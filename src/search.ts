/** Tokenize to lowercase words/digits, stripping punctuation. */
function tokenize(text: string): string[] {
  return text.toLowerCase().match(/\b[a-z0-9]+\b/g) ?? [];
}

export interface SearchDoc {
  id: string;
  text: string;
}

/**
 * Okapi BM25 keyword ranker.
 * in-process, no persistence | upgrade: Lunr.js or a WASM-based index
 */
export class BM25 {
  private k1 = 1.5;
  private b = 0.75;
  private docs: { id: string; terms: string[] }[] = [];
  private idf: Record<string, number> = {};
  private avgDl = 0;

  build(docs: SearchDoc[]) {
    this.docs = docs.map(d => ({ id: d.id, terms: tokenize(d.text) }));
    this.avgDl = this.docs.reduce((s, d) => s + d.terms.length, 0) / (this.docs.length || 1);

    const df: Record<string, number> = {};
    for (const doc of this.docs) {
      for (const term of new Set(doc.terms)) df[term] = (df[term] ?? 0) + 1;
    }

    const N = this.docs.length;
    this.idf = {};
    for (const [term, freq] of Object.entries(df)) {
      this.idf[term] = Math.log((N - freq + 0.5) / (freq + 0.5) + 1);
    }
  }

  search(query: string, k: number): string[] {
    const queryTerms = tokenize(query);
    const scores: Record<string, number> = {};

    for (const doc of this.docs) {
      const tf: Record<string, number> = {};
      for (const term of doc.terms) tf[term] = (tf[term] ?? 0) + 1;
      const dl = doc.terms.length;

      for (const term of queryTerms) {
        const idf = this.idf[term];
        if (!idf) continue;
        const f = tf[term] ?? 0;
        scores[doc.id] = (scores[doc.id] ?? 0) +
          idf * (f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + this.b * dl / this.avgDl));
      }
    }

    return Object.entries(scores)
      .sort(([, a], [, b]) => b - a)
      .slice(0, k)
      .map(([id]) => id);
  }
}

/**
 * Reciprocal Rank Fusion — merges multiple ranked lists into one.
 * RRF constant k=60 is the standard default.
 */
export function rrf(rankLists: string[][], k = 60): string[] {
  const scores: Record<string, number> = {};
  for (const list of rankLists) {
    list.forEach((id, rank) => {
      scores[id] = (scores[id] ?? 0) + 1 / (k + rank + 1);
    });
  }
  return Object.keys(scores).sort((a, b) => (scores[b] ?? 0) - (scores[a] ?? 0));
}
