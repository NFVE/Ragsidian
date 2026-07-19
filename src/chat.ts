import { ItemView, WorkspaceLeaf, Notice, setIcon, Menu, MarkdownRenderer, TFile, Modal, App } from 'obsidian';
import { RagSettings, ChatSession, Message } from './settings';
import { getLLM } from './llm';
import SmartRagPlugin, { renameCitations } from './main';

export const VIEW_TYPE_RAG_CHAT = 'rag-chat-view';

export class RagChatView extends ItemView {
  plugin: SmartRagPlugin;
  settings: RagSettings;
  currentSessionId: string | null = null;

  messagesContainer: HTMLDivElement;
  inputField: HTMLTextAreaElement;

  constructor(leaf: WorkspaceLeaf, plugin: SmartRagPlugin, settings: RagSettings) {
    super(leaf);
    this.plugin = plugin;
    this.settings = settings;
  }

  getViewType() { return VIEW_TYPE_RAG_CHAT; }
  getDisplayText() { return 'RAG Chat'; }
  getIcon() { return 'book-open-check'; }

  async onOpen() {
    const container = this.contentEl;
    container.empty();
    container.addClass('rag-chat-view');

    // Header
    const header = container.createEl('div', { cls: 'rag-chat-header' });
    header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:8px;border-bottom:1px solid var(--background-modifier-border)';

    const historyBtn = header.createEl('button', { cls: 'clickable-icon nav-action-button' });
    setIcon(historyBtn, 'history');
    historyBtn.setAttr('aria-label', 'Chat history');
    historyBtn.onclick = (e) => this.showHistoryMenu(e);

    const titleEl = header.createEl('span', { text: 'New Chat', cls: 'rag-chat-title' });
    titleEl.style.fontWeight = 'bold';

    const rightHeader = header.createEl('div');

    const settingsBtn = rightHeader.createEl('button', { cls: 'clickable-icon nav-action-button' });
    setIcon(settingsBtn, 'settings');
    settingsBtn.setAttr('aria-label', 'Plugin settings');
    settingsBtn.style.marginRight = '4px';
    settingsBtn.onclick = () => {
      (this.plugin.app as any).setting.open();
      (this.plugin.app as any).setting.openTabById(this.plugin.manifest.id);
    };

    const deleteBtn = rightHeader.createEl('button', { cls: 'clickable-icon nav-action-button' });
    setIcon(deleteBtn, 'trash');
    deleteBtn.setAttr('aria-label', 'Delete current chat');
    deleteBtn.style.marginRight = '4px';
    deleteBtn.onclick = () => this.deleteCurrentSession();

    const reindexBtn = rightHeader.createEl('button', { cls: 'clickable-icon nav-action-button' });
    setIcon(reindexBtn, 'refresh-cw');
    reindexBtn.setAttr('aria-label', 'Re-index vault');
    reindexBtn.style.marginRight = '4px';
    reindexBtn.onclick = async () => {
      new Notice('Re-indexing vault...');
      await this.plugin.buildVectorStore();
    };

    const newChatBtn = rightHeader.createEl('button', { cls: 'clickable-icon nav-action-button' });
    setIcon(newChatBtn, 'plus-square');
    newChatBtn.setAttr('aria-label', 'New chat');
    newChatBtn.onclick = () => this.createNewSession();

    // Messages
    this.messagesContainer = container.createEl('div', { cls: 'rag-messages' });
    this.messagesContainer.style.cssText = 'flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:12px';

    // Input
    const inputContainer = container.createEl('div', { cls: 'rag-input-container' });
    inputContainer.style.cssText = 'padding:12px;border-top:1px solid var(--background-modifier-border)';

    this.inputField = inputContainer.createEl('textarea', { cls: 'rag-chat-input' });
    this.inputField.placeholder = 'Ask your documents...';
    this.inputField.rows = 3;
    this.inputField.style.cssText = 'width:100%;resize:none';

    const buttonContainer = inputContainer.createEl('div', { cls: 'rag-buttons' });
    buttonContainer.style.cssText = 'display:flex;gap:8px;margin-top:8px';

    const sendBtn = buttonContainer.createEl('button', { text: 'Send', cls: 'mod-cta' });
    sendBtn.style.flex = '1';
    sendBtn.onclick = () => this.sendMessage();

    this.inputField.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.sendMessage(); }
    });

    if (this.plugin.settings.activeSessionId) {
      this.loadSession(this.plugin.settings.activeSessionId);
    } else {
      this.createNewSession();
    }
  }

  async createNewSession() {
    this.currentSessionId = crypto.randomUUID();
    const session: ChatSession = {
      id: this.currentSessionId, title: 'New Chat',
      messages: [], created: Date.now(), lastModified: Date.now()
    };
    this.plugin.settings.sessions.unshift(session);
    this.plugin.settings.activeSessionId = this.currentSessionId;
    await this.plugin.saveSettings();
    this.renderMessages(session.messages);
    this.updateTitle('New Chat');
  }

  async loadSession(sessionId: string) {
    const session = this.plugin.settings.sessions.find(s => s.id === sessionId);
    if (session) {
      this.currentSessionId = sessionId;
      this.plugin.settings.activeSessionId = sessionId;
      await this.plugin.saveSettings();
      this.renderMessages(session.messages);
      this.updateTitle(session.title);
    } else {
      this.createNewSession();
    }
  }

  async deleteCurrentSession() {
    if (!this.currentSessionId) return;

    const confirmed = await new Promise<boolean>(resolve => {
      class ConfirmDialog extends Modal {
        constructor(app: App, title: string, body: string) {
          super(app);
          this.setTitle(title);
          
          // Make the modal narrower
          this.modalEl.style.width = '300px';
          this.modalEl.style.maxWidth = '90vw';
          
          const msg = this.contentEl.createEl('p', { text: body });
          // Reduce top margin to bring text closer to title, and bottom margin to bring buttons closer
          msg.style.margin = '4px 0 16px 0'; 

          const footer = this.contentEl.createEl('div');
          footer.style.display = 'flex';
          footer.style.justifyContent = 'flex-end';
          footer.style.gap = '8px';

          const cancel = footer.createEl('button', { text: 'Cancel' });
          cancel.onclick = () => { this.close(); resolve(false); };

          const ok = footer.createEl('button', { text: 'Delete', cls: 'mod-warning' });
          ok.onclick = () => { this.close(); resolve(true); };
        }
      }
      new ConfirmDialog(this.plugin.app, 'Delete chat?', 'This action cannot be undone.').open();
    });

    if (!confirmed) return;

    this.plugin.settings.sessions = this.plugin.settings.sessions.filter(s => s.id !== this.currentSessionId);
    const next = this.plugin.settings.sessions[0];
    if (next) { await this.loadSession(next.id); } else { await this.createNewSession(); }
    new Notice('Chat deleted');
  }

  updateTitle(title: string) {
    const el = this.containerEl.querySelector('.rag-chat-title');
    if (el) el.textContent = title;
  }

  showHistoryMenu(event: MouseEvent) {
    const menu = new Menu();
    const sorted = [...this.plugin.settings.sessions].sort((a, b) => b.lastModified - a.lastModified);
    if (sorted.length === 0) menu.addItem(i => i.setTitle('No history').setDisabled(true));
    sorted.forEach(session => {
      menu.addItem(i => i.setTitle(session.title)
        .setIcon(session.id === this.currentSessionId ? 'check' : 'message-square')
        .onClick(() => this.loadSession(session.id)));
    });
    menu.showAtMouseEvent(event);
  }

  async sendMessage() {
    const query = this.inputField.value.trim();
    if (!query) return;

    if (!this.plugin.vectorStore) {
      new Notice('Please index your vault first!');
      return;
    }

    const session = this.plugin.settings.sessions.find(s => s.id === this.currentSessionId);
    if (!session) return;

    const userMsg: Message = { role: 'user', content: query, timestamp: Date.now() };
    session.messages.push(userMsg);

    if (session.messages.length === 1) {
      session.title = query.substring(0, 30) + (query.length > 30 ? '...' : '');
      this.updateTitle(session.title);
    }
    session.lastModified = Date.now();
    await this.plugin.saveSettings();

    this.inputField.value = '';
    this.renderMessages(session.messages);

    try {
      const thinkingMsg: Message = { role: 'assistant', content: 'Thinking...', timestamp: Date.now() };
      this.renderMessages([...session.messages, thinkingMsg]);

      // Hybrid retrieval + reranking
      const chunks = await this.plugin.retrieve(query);

      if (chunks.length === 0) {
        const noCtxMsg: Message = {
          role: 'assistant',
          content: "The available notes don't contain enough information to answer this.",
          timestamp: Date.now()
        };
        session.messages.push(noCtxMsg);
        session.lastModified = Date.now();
        await this.plugin.saveSettings();
        this.renderMessages(session.messages);
        return;
      }

      const sources = [...new Set(chunks.map(c => c.source))];
      const context = this.plugin.formatContext(chunks, sources);
      const historyContext = session.messages.slice(-6, -1)
        .map(m => `${m.role}: ${m.content}`).join('\n');

      const prompt = this.plugin.buildPrompt(context, historyContext, query);
      const llm = getLLM(this.plugin.settings.provider, this.plugin.settings);
      const response = await llm.invoke(prompt);

      // Normalise LaTeX delimiters to Obsidian format
      let formatted = response
        .replace(/\\\(/g, '$').replace(/\\\)/g, '$')
        .replace(/\\\[/g, '$$').replace(/\\\]/g, '$$');

      const { text: renamed, sources: newSources } = renameCitations(formatted, sources);
      formatted = renamed;

      const assistantMsg: Message = {
        role: 'assistant', content: formatted, sources: newSources, timestamp: Date.now()
      };
      session.messages.push(assistantMsg);
      session.lastModified = Date.now();
      await this.plugin.saveSettings();
      this.renderMessages(session.messages);

    } catch (error) {
      const msg = (error as Error).message;
      new Notice('Error: ' + msg);
      session.messages.push({ role: 'assistant', content: 'Error: ' + msg, timestamp: Date.now() });
      await this.plugin.saveSettings();
      this.renderMessages(session.messages);
    }
  }

  renderMessages(messages: Message[]) {
    this.messagesContainer.empty();

    messages.forEach(msg => {
      const msgEl = this.messagesContainer.createEl('div', {
        cls: `rag-message ${msg.role === 'user' ? 'user-msg' : 'bot-msg'}`
      });
      msgEl.style.cssText = `
        align-self:${msg.role === 'user' ? 'flex-end' : 'flex-start'};
        max-width:85%;padding:10px;border-radius:8px;position:relative;
        background:${msg.role === 'user' ? 'var(--interactive-accent)' : 'var(--background-secondary)'};
        color:${msg.role === 'user' ? 'var(--text-on-accent)' : 'var(--text-normal)'};
      `;

      let processedContent = msg.content;
      if (msg.role === 'assistant' && msg.sources && msg.sources.length > 0) {
        // Find citations like [1] or [2]
        processedContent = processedContent.replace(/\[(\d+)\]/g, (match, idStr) => {
          const id = parseInt(idStr);
          if (id > 0 && id <= msg.sources!.length) {
            return `<a class="rag-source-link" data-id="${id - 1}" title="${msg.sources![id - 1]}">[${id}]</a>`;
          }
          return match;
        });
      }

      const content = msgEl.createEl('div');
      MarkdownRenderer.render(this.plugin.app, processedContent, content, '', this).then(() => {
        content.querySelectorAll('p').forEach(p => p.style.margin = '0');
        
        // Attach click handlers to inline source links
        content.querySelectorAll('.rag-source-link').forEach(link => {
          const el = link as HTMLElement;
          el.style.cursor = 'pointer';
          el.style.color = 'var(--link-color)';
          el.style.textDecoration = 'none';
          el.onclick = (e) => {
            e.preventDefault();
            const idStr = el.getAttribute('data-id');
            if (idStr === null || !msg.sources) return;
            const sourcePath = msg.sources[parseInt(idStr)];
            
            if (sourcePath) {
              const file = this.plugin.app.vault.getAbstractFileByPath(sourcePath);
              if (file instanceof TFile) {
                this.plugin.app.workspace.getLeaf('tab').openFile(file);
              } else {
                new Notice('File not found: ' + sourcePath);
              }
            }
          };
        });
      });

      // Render the legend at the bottom if sources exist
      if (msg.role === 'assistant' && msg.sources && msg.sources.length > 0) {
        const legendEl = msgEl.createEl('div', { cls: 'rag-sources-legend' });
        legendEl.style.cssText = 'font-size:0.85em;margin-top:12px;padding-top:8px;border-top:1px solid var(--background-modifier-border);opacity:0.8';
        msg.sources.forEach((sourcePath, idx) => {
          const row = legendEl.createEl('div');
          row.style.marginBottom = '2px';
          row.createEl('span', { text: `[${idx + 1}]: ` });
          const link = row.createEl('span', { text: sourcePath.split('/').pop() ?? sourcePath });
          link.style.cssText = 'cursor:pointer;color:var(--link-color);text-decoration:underline;';
          link.title = sourcePath;
          link.onclick = () => {
            const file = this.plugin.app.vault.getAbstractFileByPath(sourcePath);
            if (file instanceof TFile) {
              this.plugin.app.workspace.getLeaf('tab').openFile(file);
            } else {
              new Notice('File not found: ' + sourcePath);
            }
          };
        });
      }

      // Copy button
      const copyBtn = msgEl.createEl('button', { cls: 'clickable-icon rag-copy-btn' });
      setIcon(copyBtn, 'copy');
      copyBtn.setAttr('aria-label', 'Copy');
      copyBtn.style.cssText = 'position:absolute;top:-8px;right:-8px;width:24px;height:24px;padding:4px;border-radius:50%;background:var(--background-primary);border:1px solid var(--background-modifier-border);cursor:pointer;display:none';
      msgEl.addEventListener('mouseenter', () => copyBtn.style.display = 'flex');
      msgEl.addEventListener('mouseleave', () => copyBtn.style.display = 'none');
      copyBtn.onclick = () => { navigator.clipboard.writeText(msg.content); new Notice('Copied'); };
    });

    this.messagesContainer.scrollTo(0, this.messagesContainer.scrollHeight);
  }

  async onClose() {}
}
