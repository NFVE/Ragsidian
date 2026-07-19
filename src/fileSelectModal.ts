import { App, Modal, TFile, Notice, setIcon } from 'obsidian';
import SmartRagPlugin from './main';

export class FileSelectModal extends Modal {
    plugin: SmartRagPlugin;
    selectedFiles: Set<TFile> = new Set();
    files: TFile[] = [];
    listContainer: HTMLDivElement;

    constructor(app: App, plugin: SmartRagPlugin) {
        super(app);
        this.plugin = plugin;
        this.files = this.app.vault.getMarkdownFiles();
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('file-select-modal');

        const header = contentEl.createEl('div', { cls: 'file-select-header' });
        header.createEl('h2', { text: 'Select files to index' });
        header.createEl('p', { text: 'Choose which markdown files to include in the vector index.' });

        const buttonBar = contentEl.createEl('div', { cls: 'file-select-buttons' });
        buttonBar.style.display = 'flex';
        buttonBar.style.gap = '8px';
        buttonBar.style.marginBottom = '12px';

        const selectAllBtn = buttonBar.createEl('button', { text: 'Select all' });
        selectAllBtn.onclick = () => this.selectAll();

        const deselectAllBtn = buttonBar.createEl('button', { text: 'Deselect all' });
        deselectAllBtn.onclick = () => this.deselectAll();

        this.listContainer = contentEl.createEl('div', { cls: 'file-select-list' });
        this.listContainer.style.maxHeight = '400px';
        this.listContainer.style.overflowY = 'auto';
        this.listContainer.style.border = '1px solid var(--background-modifier-border)';
        this.listContainer.style.borderRadius = '4px';
        this.listContainer.style.padding = '8px';

        this.renderFileList();

        const footer = contentEl.createEl('div', { cls: 'file-select-footer' });
        footer.style.marginTop = '16px';
        footer.style.display = 'flex';
        footer.style.justifyContent = 'space-between';
        footer.style.alignItems = 'center';

        const countEl = footer.createEl('span', { cls: 'file-count' });
        countEl.id = 'selected-count';
        this.updateCount();

        const indexBtn = footer.createEl('button', { cls: 'mod-cta' });
        const indexIcon = indexBtn.createEl('span');
        setIcon(indexIcon, 'database');
        indexBtn.createEl('span', { text: ' Index selected files' });
        indexBtn.onclick = () => this.indexFiles();
    }

    renderFileList() {
        this.listContainer.empty();

        const folders = new Map<string, TFile[]>();
        for (const file of this.files) {
            const folder = file.parent?.path || '/';
            if (!folders.has(folder)) folders.set(folder, []);
            folders.get(folder)!.push(file);
        }

        for (const folderPath of Array.from(folders.keys()).sort()) {
            const folderFiles = folders.get(folderPath)!;
            const folderEl = this.listContainer.createEl('div', { cls: 'folder-group' });
            folderEl.style.marginBottom = '12px';

            const folderHeader = folderEl.createEl('div', { cls: 'folder-header' });
            folderHeader.style.fontWeight = 'bold';
            folderHeader.style.marginBottom = '4px';
            folderHeader.style.color = 'var(--text-muted)';
            folderHeader.style.display = 'flex';
            folderHeader.style.alignItems = 'center';
            folderHeader.style.gap = '4px';
            const folderIcon = folderHeader.createEl('span');
            setIcon(folderIcon, 'folder');
            folderHeader.createEl('span', { text: folderPath === '/' ? 'Root' : folderPath });

            for (const file of folderFiles) {
                const fileRow = folderEl.createEl('div', { cls: 'file-row' });
                fileRow.style.display = 'flex';
                fileRow.style.alignItems = 'center';
                fileRow.style.padding = '4px 8px';
                fileRow.style.cursor = 'pointer';
                fileRow.style.borderRadius = '4px';
                fileRow.onmouseenter = () => fileRow.style.background = 'var(--background-secondary)';
                fileRow.onmouseleave = () => fileRow.style.background = 'transparent';

                const checkbox = fileRow.createEl('input', { type: 'checkbox' });
                checkbox.checked = this.selectedFiles.has(file);
                checkbox.style.marginRight = '8px';
                fileRow.createEl('span', { text: file.basename });

                const toggle = () => {
                    this.selectedFiles.has(file) ? this.selectedFiles.delete(file) : this.selectedFiles.add(file);
                    checkbox.checked = this.selectedFiles.has(file);
                    this.updateCount();
                };
                checkbox.onclick = (e) => { e.stopPropagation(); toggle(); };
                fileRow.onclick = toggle;
            }
        }
    }

    selectAll() { this.selectedFiles = new Set(this.files); this.renderFileList(); this.updateCount(); }
    deselectAll() { this.selectedFiles.clear(); this.renderFileList(); this.updateCount(); }

    updateCount() {
        const countEl = document.getElementById('selected-count');
        if (countEl) countEl.textContent = `${this.selectedFiles.size} of ${this.files.length} files selected`;
    }

    async indexFiles() {
        if (this.selectedFiles.size === 0) { new Notice('No files selected'); return; }
        this.close();
        new Notice(`Indexing ${this.selectedFiles.size} files...`);
        try {
            await this.plugin.buildVectorStore();
            new Notice(`Indexed ${this.selectedFiles.size} files`);
        } catch (error) {
            new Notice(`Indexing failed: ${(error as Error).message}`);
        }
    }

    onClose() { this.contentEl.empty(); }
}
