import { App, Plugin, PluginSettingTab, Setting, Notice, Editor, WorkspaceLeaf, TFile, requestUrl } from 'obsidian';
import { Document } from '@langchain/core/documents';
import { MemoryVectorStore } from '@langchain/classic/vectorstores/memory';
import { RagSettings, DEFAULT_SETTINGS } from './settings';
import { getLLM } from './llm';
import { RagChatView, VIEW_TYPE_RAG_CHAT } from './chat';
import { chunkMarkdown } from './chunker';
import { BM25, SearchDoc, rrf } from './search';

interface ChunkEntry {
  embedding: number[];
  content: string;
  heading: string;  // section heading (empty for preamble or non-markdown)
}

interface EmbeddingEntry {
  mtime: number;
  chunks: ChunkEntry[];
}

export interface RetrievedChunk {
  content: string;
  source: string;   // always a TFile.path — never undefined
  chunkIndex: number;
  heading: string;  // empty when file has no headings
}

export default class SmartRagPlugin extends Plugin {
  settings: RagSettings;
  vectorStore: MemoryVectorStore | null = null;
  embeddingStore: Record<string, EmbeddingEntry> = {};
  private bm25 = new BM25();
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  async onload() {
    await this.loadSettings();
    await this.loadEmbeddingStore();
    this.addSettingTab(new RagSettingTab(this.app, this));

    this.registerView(
      VIEW_TYPE_RAG_CHAT,
      (leaf) => new RagChatView(leaf, this, this.settings)
    );

    this.addRibbonIcon('book-open-check', 'Open RAG Chat', () => this.activateView());

    this.addCommand({ id: 'open-rag-chat', name: 'Open RAG Chat', callback: () => this.activateView() });
    this.addCommand({
      id: 'quick-rag-query',
      name: 'Quick RAG Query',
      editorCallback: (editor: Editor) => {
        const q = editor.getSelection();
        if (q) this.quickQuery(q);
      }
    });
    this.addCommand({ id: 'reindex-vault', name: 'Re-index vault', callback: () => this.buildVectorStore() });

    // Vault watchers (always registered; settings checked inside handlers)
    this.registerEvent(this.app.vault.on('modify', (f) => {
      if (!(f instanceof TFile) || f.extension !== 'md' || !this.settings.autoIndexOnChange) return;
      this.debounceIndex(f);
    }));
    this.registerEvent(this.app.vault.on('create', (f) => {
      if (!(f instanceof TFile) || f.extension !== 'md' || !this.settings.autoIndexOnChange) return;
      this.debounceIndex(f);
    }));
    this.registerEvent(this.app.vault.on('delete', (f) => {
      if (!(f instanceof TFile) || f.extension !== 'md' || !this.settings.autoIndexOnChange) return;
      if (this.embeddingStore[f.path]) {
        delete this.embeddingStore[f.path];
        this.saveEmbeddingStore();
        this.rebuildMemoryStore();
      }
    }));
    this.registerEvent(this.app.vault.on('rename', (f, oldPath) => {
      if (!(f instanceof TFile) || f.extension !== 'md' || !this.settings.autoIndexOnChange) return;
      if (this.embeddingStore[oldPath]) {
        this.embeddingStore[f.path] = this.embeddingStore[oldPath];
        delete this.embeddingStore[oldPath];
        this.saveEmbeddingStore();
        this.rebuildMemoryStore();
      }
    }));

    if (this.settings.indexOnStartup) {
      await this.buildVectorStore();
    } else {
      this.rebuildMemoryStore();
    }
  }

  async onunload() {
    for (const t of this.debounceTimers.values()) clearTimeout(t);
  }

  // --- Persistence ---

  private get storeFilePath() { return `${this.manifest.dir}/embeddings.json`; }

  async loadEmbeddingStore() {
    try {
      if (await this.app.vault.adapter.exists(this.storeFilePath)) {
        const raw = await this.app.vault.adapter.read(this.storeFilePath);
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        // Migration: discard old format entries (no 'chunks' array)
        const store: Record<string, EmbeddingEntry> = {};
        for (const [path, entry] of Object.entries(parsed)) {
          const e = entry as any;
          if (Array.isArray(e.chunks)) store[path] = e as EmbeddingEntry;
        }
        this.embeddingStore = store;
      }
    } catch (e) {
      console.error('Failed to load embedding store:', e);
      this.embeddingStore = {};
    }
  }

  async saveEmbeddingStore() {
    try {
      await this.app.vault.adapter.write(this.storeFilePath, JSON.stringify(this.embeddingStore));
    } catch (e) {
      console.error('Failed to save embedding store:', e);
    }
  }

  // --- Vector store & BM25 ---

  /** Rebuild MemoryVectorStore and BM25 index from embeddingStore — no API calls. */
  rebuildMemoryStore() {
    const entries = Object.entries(this.embeddingStore);
    if (entries.length === 0) { this.vectorStore = null; return; }

    const embeddingsIface = {
      embedQuery: (t: string) => this.getEmbedding(t),
      embedDocuments: (ts: string[]) => Promise.all(ts.map(t => this.getEmbedding(t)))
    };

    const store = new MemoryVectorStore(embeddingsIface as any);
    const docs: Document[] = [];
    const vectors: number[][] = [];
    const bm25Docs: SearchDoc[] = [];

    for (const [path, entry] of entries) {
      entry.chunks.forEach((chunk, i) => {
        docs.push(new Document({ pageContent: chunk.content, metadata: { source: path, chunkIndex: i } }));
        vectors.push(chunk.embedding);
        bm25Docs.push({ id: `${path}::${i}`, text: chunk.content });
      });
    }

    // addVectors is sync-safe for MemoryVectorStore (no I/O)
    store.addVectors(vectors, docs).then(() => { this.vectorStore = store; });
    this.bm25.build(bm25Docs);
  }

  /** Incremental index: only re-embeds changed/new files. */
  async buildVectorStore() {
    try {
      const files = this.app.vault.getMarkdownFiles().slice(0, this.settings.maxFiles);
      const vaultPaths = new Set(files.map(f => f.path));

      // Prune deleted files
      for (const path of Object.keys(this.embeddingStore)) {
        if (!vaultPaths.has(path)) delete this.embeddingStore[path];
      }

      let embedded = 0;
      for (const file of files) {
        const existing = this.embeddingStore[file.path];
        if (existing && existing.mtime === file.stat.mtime) continue;
        await this.embedFile(file);
        embedded++;
      }

      await this.saveEmbeddingStore();
      this.rebuildMemoryStore();

      new Notice(
        embedded > 0
          ? `Indexed ${embedded} file(s) (${files.length} total)`
          : `Index up to date (${files.length} files)`
      );
    } catch (error) {
      console.error('Index error:', error);
      new Notice(`Indexing error: ${(error as Error).message}`);
    }
  }

  private debounceIndex(file: TFile) {
    const existing = this.debounceTimers.get(file.path);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(async () => {
      this.debounceTimers.delete(file.path);
      await this.updateFileEmbedding(file);
    }, this.settings.debounceMs);
    this.debounceTimers.set(file.path, timer);
  }

  private async embedFile(file: TFile) {
    const raw = await this.app.vault.read(file);
    const sections = chunkMarkdown(raw, this.settings.chunkSize, this.settings.chunkOverlap);
    const chunks: ChunkEntry[] = [];
    for (const { content, heading } of sections) {
      chunks.push({ embedding: await this.getEmbedding(content), content, heading });
    }
    this.embeddingStore[file.path] = { mtime: file.stat.mtime, chunks };
  }

  async updateFileEmbedding(file: TFile) {
    try {
      await this.embedFile(file);
      await this.saveEmbeddingStore();
      this.rebuildMemoryStore();
    } catch (e) {
      console.error(`Failed to update embedding for ${file.path}:`, e);
    }
  }

  // --- Hybrid retrieval ---

  /**
   * Retrieve the top-k most relevant chunks using hybrid search (BM25 + vector) + RRF.
   * Falls back to vector-only when hybrid is disabled.
   */
  async retrieve(query: string): Promise<RetrievedChunk[]> {
    if (!this.vectorStore) return [];
    const k = this.settings.topK;
    const candidates = k * 3; // over-fetch before reranking

    const vectorDocs = await this.vectorStore.similaritySearch(query, candidates);
    const vectorIds = vectorDocs.map(d => `${d.metadata.source}::${d.metadata.chunkIndex}`);

    let finalIds: string[];
    if (this.settings.useHybridSearch) {
      const bm25Ids = this.bm25.search(query, candidates);
      finalIds = rrf([vectorIds, bm25Ids]).slice(0, k);
    } else {
      finalIds = vectorIds.slice(0, k);
    }

    const results: RetrievedChunk[] = [];
    for (const id of finalIds) {
      const sepIdx = id.lastIndexOf('::');
      const path = id.slice(0, sepIdx);
      const chunkIndex = parseInt(id.slice(sepIdx + 2));
      const entry = this.embeddingStore[path];
      if (!entry?.chunks[chunkIndex]) continue;
      results.push({ content: entry.chunks[chunkIndex].content, source: path, chunkIndex, heading: entry.chunks[chunkIndex].heading ?? '' });
    }
    return results;
  }

  // --- Embeddings API ---

  async getEmbedding(text: string): Promise<number[]> {
    return this.settings.provider === 'private'
      ? this.getPrivateEmbedding(text)
      : this.getOllamaEmbedding(text);
  }

  async getOllamaEmbedding(text: string): Promise<number[]> {
    const r = await fetch(`${this.settings.baseUrl}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.settings.embeddingModel, prompt: text })
    });
    if (!r.ok) throw new Error(`Ollama embedding HTTP ${r.status}`);
    const data = await r.json();
    if (!Array.isArray(data.embedding) || data.embedding.length === 0)
      throw new Error('Ollama returned empty embedding');
    return data.embedding;
  }

  async getPrivateEmbedding(text: string): Promise<number[]> {
    const r = await requestUrl({
      url: `${this.settings.privateBaseUrl}/embeddings`,
      method: 'POST',
      headers: { 'Authorization': 'Bearer ignored', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.settings.privateEmbeddingModel, input: text })
    });

    const data = r.json;
    if (!data.data?.[0]?.embedding) throw new Error('Private API returned empty embedding');
    return data.data[0].embedding;
  }

  // --- Quick query ---

  async quickQuery(query: string) {
    if (!this.vectorStore) { new Notice('Please index your vault first!'); return; }
    try {
      new Notice('Generating...');
      const chunks = await this.retrieve(query);
      const sources = [...new Set(chunks.map(c => c.source))];
      const context = this.formatContext(chunks, sources);
      const llm = getLLM(this.settings.provider, this.settings);
      let answer = await llm.invoke(this.buildPrompt(context, '', query));
      const { text, sources: cited } = renameCitations(answer, sources);
      answer = text;
      const note = await this.app.vault.create(
        `RAG-${Date.now()}.md`,
        `# Quick RAG\n\n**Q:** ${query}\n\n**A:**\n${answer}\n\n**Sources:**\n${cited.map((s, i) => `[${i + 1}] ${s}`).join('\n')}`
      );
      this.app.workspace.activeLeaf?.openFile(note);
    } catch (error) {
      new Notice(`${(error as Error).message}`);
    }
  }

  // --- Prompt helpers (used by chat.ts too) ---

  formatContext(chunks: RetrievedChunk[], uniqueSources: string[]): string {
    const idxMap = new Map(uniqueSources.map((s, i) => [s, i + 1]));
    return chunks.map(c => {
      const sourceId = idxMap.get(c.source) ?? 0;
      const fileName = c.source.split('/').pop() ?? c.source;
      const label = c.heading ? `${fileName} › ${c.heading}` : fileName;
      return `Source [${sourceId}]: ${label}\n${c.content}`;
    }).join('\n\n---\n\n');
  }

  buildPrompt(context: string, history: string, query: string): string {
    return `You are a helpful assistant that answers questions strictly based on the user's notes.

Rules:
- Answer ONLY using information from the context below.
- Always respond in ${this.settings.responseLanguage}.
- If the context does not contain enough information, respond with exactly: "The available notes don't contain enough information to answer this."
- Cite sources inline using their numeric ID in brackets, e.g., [1] or [2].
- Format your response in Markdown.
- Do not speculate or use outside knowledge.

Context:
${context}
${history ? `\nChat history:\n${history}\n` : ''}
Question: ${query}
Answer:`;
  }

  // --- Lifecycle ---

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async activateView() {
    const { workspace } = this.app;
    const leaves = workspace.getLeavesOfType(VIEW_TYPE_RAG_CHAT);
    let leaf = leaves.length > 0 ? leaves[0] as WorkspaceLeaf : workspace.getRightLeaf(false);
    if (leaf && leaves.length === 0) await leaf.setViewState({ type: VIEW_TYPE_RAG_CHAT, active: true });
    if (leaf) workspace.revealLeaf(leaf);
  }
}

/**
 * Strips uncited sources and renumbers [N] references in the LLM answer.
 * Shared by quickQuery and chat.ts sendMessage.
 */
export function renameCitations(text: string, sources: string[]): { text: string; sources: string[] } {
  const cited = new Set([...text.matchAll(/\[(\d+)\]/g)].map(m => parseInt(m[1] ?? '')));
  const kept: string[] = [];
  const remap = new Map<number, number>();
  sources.forEach((s, i) => {
    const oldId = i + 1;
    if (cited.has(oldId)) { remap.set(oldId, kept.push(s)); }
  });
  const renamed = text.replace(/\[(\d+)\]/g, (match, n) => {
    const newId = remap.get(parseInt(n));
    return newId !== undefined ? `[${newId}]` : match;
  });
  return { text: renamed, sources: kept };
}

class RagSettingTab extends PluginSettingTab {
  plugin: SmartRagPlugin;

  constructor(app: App, plugin: SmartRagPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'RAG settings' });

    // --- Provider ---
    new Setting(containerEl)
      .setName('Provider')
      .setDesc('Choose your LLM provider')
      .addDropdown(dd => dd
        .addOption('local', 'Local (Ollama)')
        .addOption('private', 'Private hosted (OpenAI-compatible)')
        .setValue(this.plugin.settings.provider)
        .onChange(async (v) => {
          this.plugin.settings.provider = v as 'local' | 'private';
          await this.plugin.saveSettings();
          this.display();
        }));

    if (this.plugin.settings.provider === 'local') {
      containerEl.createEl('h3', { text: 'Ollama settings' });
      new Setting(containerEl).setName('Base URL').setDesc('Ollama server URL')
        .addText(t => t.setPlaceholder('http://localhost:11434').setValue(this.plugin.settings.baseUrl)
          .onChange(async (v) => { this.plugin.settings.baseUrl = v; await this.plugin.saveSettings(); }));
      new Setting(containerEl).setName('Chat model')
        .addText(t => t.setPlaceholder('mistral:latest').setValue(this.plugin.settings.model)
          .onChange(async (v) => { this.plugin.settings.model = v; await this.plugin.saveSettings(); }));
      new Setting(containerEl).setName('Embedding model')
        .addText(t => t.setPlaceholder('nomic-embed-text:latest').setValue(this.plugin.settings.embeddingModel)
          .onChange(async (v) => { this.plugin.settings.embeddingModel = v; await this.plugin.saveSettings(); }));
    }

    if (this.plugin.settings.provider === 'private') {
      containerEl.createEl('h3', { text: 'Private server settings' });
      new Setting(containerEl).setName('Base URL').setDesc('OpenAI-compatible API endpoint')
        .addText(t => t.setPlaceholder('').setValue(this.plugin.settings.privateBaseUrl)
          .onChange(async (v) => { this.plugin.settings.privateBaseUrl = v; await this.plugin.saveSettings(); }));
      new Setting(containerEl).setName('Chat model')
        .addText(t => t.setPlaceholder('gpt-oss-120b').setValue(this.plugin.settings.privateModel)
          .onChange(async (v) => { this.plugin.settings.privateModel = v; await this.plugin.saveSettings(); }));
      new Setting(containerEl).setName('Embedding model')
        .addText(t => t.setPlaceholder('qwen3-embedding-4b').setValue(this.plugin.settings.privateEmbeddingModel)
          .onChange(async (v) => { this.plugin.settings.privateEmbeddingModel = v; await this.plugin.saveSettings(); }));
    }

    // --- Indexing ---
    containerEl.createEl('h3', { text: 'Indexing' });

    new Setting(containerEl)
      .setName('Index on startup')
      .setDesc('Check for new or changed files when Obsidian loads.')
      .addToggle(t => t.setValue(this.plugin.settings.indexOnStartup)
        .onChange(async (v) => { this.plugin.settings.indexOnStartup = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName('Auto-update on file changes')
      .setDesc('Re-embed a note automatically after it is saved.')
      .addToggle(t => t.setValue(this.plugin.settings.autoIndexOnChange)
        .onChange(async (v) => { this.plugin.settings.autoIndexOnChange = v; await this.plugin.saveSettings(); this.display(); }));

    if (this.plugin.settings.autoIndexOnChange) {
      new Setting(containerEl)
        .setName('Debounce delay (ms)')
        .setDesc('Milliseconds to wait after the last save before re-embedding.')
        .addText(t => t.setPlaceholder('5000').setValue(String(this.plugin.settings.debounceMs))
          .onChange(async (v) => {
            const n = parseInt(v);
            if (!isNaN(n) && n >= 0) { this.plugin.settings.debounceMs = n; await this.plugin.saveSettings(); }
          }));
    }

    new Setting(containerEl)
      .setName('Max files to index')
      .setDesc('Hard cap on markdown files included in the index.')
      .addText(t => t.setPlaceholder('200').setValue(String(this.plugin.settings.maxFiles))
        .onChange(async (v) => {
          const n = parseInt(v);
          if (!isNaN(n) && n > 0) { this.plugin.settings.maxFiles = n; await this.plugin.saveSettings(); }
        }));

    new Setting(containerEl)
      .setName('Chunk size (chars)')
      .setDesc('Target character length of each indexed chunk. Smaller = more precise retrieval.')
      .addText(t => t.setPlaceholder('600').setValue(String(this.plugin.settings.chunkSize))
        .onChange(async (v) => {
          const n = parseInt(v);
          if (!isNaN(n) && n > 50) { this.plugin.settings.chunkSize = n; await this.plugin.saveSettings(); }
        }));

    new Setting(containerEl)
      .setName('Chunk overlap (chars)')
      .setDesc('Characters shared between consecutive chunks to avoid splitting mid-thought.')
      .addText(t => t.setPlaceholder('100').setValue(String(this.plugin.settings.chunkOverlap))
        .onChange(async (v) => {
          const n = parseInt(v);
          if (!isNaN(n) && n >= 0) { this.plugin.settings.chunkOverlap = n; await this.plugin.saveSettings(); }
        }));

    // --- Retrieval ---
    containerEl.createEl('h3', { text: 'Retrieval' });

    new Setting(containerEl)
      .setName('Results (top-k)')
      .setDesc('Number of chunks passed to the LLM as context per query.')
      .addText(t => t.setPlaceholder('5').setValue(String(this.plugin.settings.topK))
        .onChange(async (v) => {
          const n = parseInt(v);
          if (!isNaN(n) && n > 0) { this.plugin.settings.topK = n; await this.plugin.saveSettings(); }
        }));

    new Setting(containerEl)
      .setName('Hybrid search (BM25 + vector)')
      .setDesc('Combine keyword search with vector similarity, then rerank with RRF. Usually improves precision.')
      .addToggle(t => t.setValue(this.plugin.settings.useHybridSearch)
        .onChange(async (v) => { this.plugin.settings.useHybridSearch = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName('Response language')
      .setDesc('Language the assistant uses for answers (e.g. English, German, French).')
      .addText(t => t.setPlaceholder('English').setValue(this.plugin.settings.responseLanguage)
        .onChange(async (v) => { this.plugin.settings.responseLanguage = v.trim() || 'English'; await this.plugin.saveSettings(); }));

    // --- Storage ---
    containerEl.createEl('h3', { text: 'Storage' });
    containerEl.createEl('p', {
      text: `Embeddings persisted at: ${this.plugin.manifest.dir}/embeddings.json`,
      cls: 'setting-item-description'
    });
    new Setting(containerEl)
      .setName('Re-index now')
      .setDesc('Force a full incremental update. Run this after changing chunk size or embedding model.')
      .addButton(btn => btn.setButtonText('Re-index').setCta()
        .onClick(() => this.plugin.buildVectorStore()));
  }
}
