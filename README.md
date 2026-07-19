# Obsidian RAG Plugin

A Retrieval-Augmented Generation (RAG) plugin for [Obsidian](https://obsidian.md), based on [obsidian-sample-plugin](https://github.com/obsidianmd/obsidian-sample-plugin).

- Works with local Ollama models
- Or with any private OpenAI-compatible API

## Installation

Requires [Obsidian](https://obsidian.md) to be installed.

1. Create or open a vault in Obsidian.
2. Enable community plugins under `Settings → Community plugins`.
3. Navigate to the vault folder on your file system.
4. Clone this repository into `.obsidian/plugins/`:

   ```bash
   git clone https://github.com/NFVE/ragsidian .obsidian/plugins/ragsidian
   ```

5. Install dependencies and build the plugin:

   ```bash
   cd .obsidian/plugins/ragsidian
   npm install
   npm run build
   ```

6. In Obsidian go to `Settings → Community plugins → Installed plugins`, reload plugins, and enable the toggle for **RAG Plugin**.

### Local usage (Ollama)

1. Install [Ollama](https://ollama.com/download).
2. Pull a chat model, e.g. `ollama pull mistral:latest`
3. Pull an embedding model, e.g. `ollama pull nomic-embed-text`
4. Start the server: `ollama serve` (runs at `http://localhost:11434` by default)

Use `ollama list` to see installed models.

## Configuration

Open `Settings → Community plugins → RAG Plugin`.

Select a **provider**:

- **Local (Ollama)** — set the base URL, chat model, and embedding model.
- **Private hosted** — set the OpenAI-compatible API endpoint, chat model, and embedding model.

Embeddings are stored persistently in `embeddings.json` inside the plugin folder and survive restarts. On startup only new or changed files are re-embedded; unchanged files are loaded instantly from disk.

**Indexing options** (under the *Indexing* section in settings):

| Setting | Default | Description |
|---|---|---|
| Index on startup | on | Check for new/changed files when Obsidian loads |
| Auto-update on file changes | on | Re-embed a note after it is saved |
| Debounce delay | 5000 ms | Wait this long after the last save before re-embedding |
| Max files to index | 200 | Hard cap on files included in the index |

## Usage

### Opening the chat

There are three ways to open the RAG chat panel:

| Method | How |
|---|---|
| **Ribbon icon** | Click the **Open RAG Chat** icon in the left sidebar |
| **Command palette** | Press `Ctrl+P` (macOS: `Cmd+P`), type **Open RAG Chat**, and press `Enter` |
| **Hotkey** | Assign a custom hotkey under **Settings → Hotkeys**, search for *Open RAG Chat* |
The chat opens as a panel in the right sidebar. Type your question and press **Enter** or click **Send**.

### Available commands

Open the command palette (`Ctrl+P` / `Cmd+P`) and search for any of these:

| Command | Description |
|---|---|
| **Open RAG Chat** | Opens the chat panel in the right sidebar |
| **Quick RAG Query** | Runs the currently selected text as a query and saves the answer to a new note |
| **Re-index vault** | Forces a full incremental re-index of all markdown files |

---

## API documentation

See <https://docs.obsidian.md>
