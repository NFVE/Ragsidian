// Local LLM via Ollama
export class LocalLLM {
  baseUrl: string;
  model: string;

  constructor(baseUrl: string, model: string) {
    this.baseUrl = baseUrl;
    this.model = model;
  }

  async invoke(prompt: string): Promise<string> {
    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: 'user', content: prompt }],
        stream: false
      })
    });

    if (!response.ok) throw new Error(`Ollama HTTP ${response.status}`);

    const data = await response.json();
    if (!data.message?.content) throw new Error(`No response from Ollama: ${JSON.stringify(data)}`);
    return data.message.content;
  }
}

import { requestUrl } from 'obsidian';

// Private hosted LLM (OpenAI-compatible API)
export class PrivateLLM {
  baseUrl: string;
  model: string;

  constructor(baseUrl: string, model: string) {
    this.baseUrl = baseUrl;
    this.model = model;
  }

  async invoke(prompt: string): Promise<string> {
    const response = await requestUrl({
      url: `${this.baseUrl}/chat/completions`,
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ignored',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 2000,
        temperature: 0.1
      })
    });

    const data = response.json;
    if (!data.choices?.[0]) throw new Error(`Private LLM error: ${JSON.stringify(data.error || data)}`);
    return data.choices[0].message.content;
  }
}

export function getLLM(provider: string, settings: any) {
  if (provider === 'private') return new PrivateLLM(settings.privateBaseUrl, settings.privateModel);
  return new LocalLLM(settings.baseUrl, settings.model);
}
