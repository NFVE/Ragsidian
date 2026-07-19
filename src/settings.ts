export interface Message {
  role: 'user' | 'assistant';
  content: string;
  sources?: string[];
  timestamp: number;
}

export interface ChatSession {
  id: string;
  title: string;
  messages: Message[];
  created: number;
  lastModified: number;
}

export interface RagSettings {
  provider: 'local' | 'private';
  model: string;
  baseUrl: string;
  embeddingModel: string;
  sessions: ChatSession[];
  activeSessionId?: string;

  // Private Model Settings (OpenAI-compatible API)
  privateBaseUrl: string;
  privateModel: string;
  privateEmbeddingModel: string;

  // Indexing settings
  indexOnStartup: boolean;
  autoIndexOnChange: boolean;
  debounceMs: number;
  maxFiles: number;

  // Retrieval settings
  topK: number;
  chunkSize: number;
  chunkOverlap: number;
  useHybridSearch: boolean;
  responseLanguage: string;
}

export const DEFAULT_SETTINGS: RagSettings = {
  provider: 'local',
  model: 'mistral:latest',
  baseUrl: 'http://localhost:11434',
  embeddingModel: 'nomic-embed-text:latest',
  sessions: [],
  activeSessionId: undefined,

  privateBaseUrl: '',
  privateModel: 'gpt-oss-120b',
  privateEmbeddingModel: 'qwen3-embedding-4b',

  indexOnStartup: true,
  autoIndexOnChange: true,
  debounceMs: 5000,
  maxFiles: 200,

  topK: 8,
  chunkSize: 600,
  chunkOverlap: 100,
  useHybridSearch: true,
  responseLanguage: 'English',
};
