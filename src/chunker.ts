export interface SectionChunk {
  content: string;  // breadcrumb prefix + heading + body
  heading: string;  // plain-text heading (for display/metadata)
}

/**
 * Split markdown into header-aware chunks.
 * Each chunk = one section (heading + its body).
 * Parent headings are prepended as breadcrumb so retrieval context is preserved.
 * Falls back to paragraph splitting when a section exceeds maxSize.
 */
export function chunkMarkdown(text: string, maxSize: number, overlap: number): SectionChunk[] {
  const sections = parseSections(text);
  const headingStack: { level: number; heading: string }[] = [];
  const chunks: SectionChunk[] = [];

  for (const section of sections) {
    // Maintain ancestor stack
    while (headingStack.length > 0 && headingStack[headingStack.length - 1].level >= section.level) {
      headingStack.pop();
    }
    if (section.level > 0) headingStack.push({ level: section.level, heading: section.heading });

    // Breadcrumb of parent headings (excluding current)
    const ancestors = headingStack.slice(0, -1).map(h => stripMarkers(h.heading)).join(' › ');
    const prefix = ancestors ? `[${ancestors}]\n` : '';
    const headingLine = section.heading ? section.heading + '\n\n' : '';
    const full = (prefix + headingLine + section.body).trim();

    if (!full) continue;

    const plainHeading = stripMarkers(section.heading);

    if (full.length <= maxSize) {
      chunks.push({ content: full, heading: plainHeading });
    } else {
      // Section body too large — split by paragraphs, each sub-chunk keeps heading prefix
      const subSize = Math.max(100, maxSize - prefix.length - headingLine.length);
      for (const part of splitByParagraph(section.body, subSize, overlap)) {
        chunks.push({
          content: (prefix + headingLine + part).trim(),
          heading: plainHeading
        });
      }
    }
  }

  return chunks.filter(c => c.content.length > 0);
}

interface RawSection {
  level: number;
  heading: string;
  body: string;
}

function parseSections(text: string): RawSection[] {
  const sections: RawSection[] = [];
  let level = 0;
  let heading = '';
  let bodyLines: string[] = [];

  const flush = () => {
    const body = bodyLines.join('\n').trim();
    if (heading || body) sections.push({ level, heading, body });
    bodyLines = [];
  };

  for (const line of text.split('\n')) {
    const m = line.match(/^(#{1,6})\s+(.*)/);
    if (m) {
      flush();
      level = m[1].length;
      heading = line;
    } else {
      bodyLines.push(line);
    }
  }
  flush();
  return sections;
}

function stripMarkers(heading: string): string {
  return heading.replace(/^#+\s*/, '').trim();
}

/** Paragraph-based fallback for oversized sections. */
function splitByParagraph(text: string, size: number, overlap: number): string[] {
  const paras = text.split(/\n\n+/).filter(p => p.trim());
  const chunks: string[] = [];
  let current = '';

  for (const para of paras) {
    if ((current ? current.length + 2 : 0) + para.length <= size) {
      current = current ? current + '\n\n' + para : para;
    } else {
      if (current) chunks.push(current.trim());
      if (para.length > size) {
        for (let i = 0; i < para.length; i += size - overlap) {
          chunks.push(para.slice(i, i + size));
          if (i + size >= para.length) break;
        }
        current = '';
      } else {
        current = para;
      }
    }
  }
  if (current.trim()) chunks.push(current.trim());
  if (chunks.length === 0 && text.trim()) chunks.push(text.slice(0, size));
  return chunks;
}
