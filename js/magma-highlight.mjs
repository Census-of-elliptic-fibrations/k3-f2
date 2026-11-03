// Tree-sitter is loaded only when a surface has a Magma snippet to highlight.
const assets = new URL('../vendor/tree-sitter/', import.meta.url);
let highlighterPromise;

function highlighter() {
  return highlighterPromise ||= (async () => {
    const { Parser, Language, Query } = await import('../vendor/tree-sitter/tree-sitter.js');
    await Parser.init({ locateFile: name => new URL(name, assets).href });
    const [language, response] = await Promise.all([
      Language.load(new URL('tree-sitter-magma.wasm', assets).href),
      fetch(new URL('highlights.scm', assets)),
    ]);
    if (!response.ok) throw new Error(`could not load Magma highlights (${response.status})`);
    const query = new Query(language, await response.text());
    const parser = new Parser();
    parser.setLanguage(language);
    return { parser, query };
  })().catch(error => {
    highlighterPromise = null; // Allow a later surface to retry a failed asset fetch.
    throw error;
  });
}

function highlightedText(source, captures) {
  // Web Tree-sitter uses UTF-16 indices, just like JavaScript strings. Resolve
  // overlapping captures by letting narrower nodes and then later query patterns
  // override broader ones (for example, @function overrides @variable).
  const styles = new Array(source.length);
  captures.sort((a, b) =>
    (b.node.endIndex - b.node.startIndex) - (a.node.endIndex - a.node.startIndex)
    || a.patternIndex - b.patternIndex);
  for (const { name, node } of captures) {
    styles.fill(name.split('.')[0], node.startIndex, node.endIndex);
  }
  const fragment = document.createDocumentFragment();
  for (let start = 0; start < source.length;) {
    let end = start + 1;
    while (end < source.length && styles[end] === styles[start]) end++;
    const text = source.slice(start, end);
    if (styles[start]) {
      const span = document.createElement('span');
      span.className = `syntax-${styles[start]}`;
      span.textContent = text;
      fragment.append(span);
    } else fragment.append(text);
    start = end;
  }
  return fragment;
}

export async function highlightMagma(element) {
  // Keep plain text visible during loading and on failure. Retain this particular
  // element so a delayed load cannot highlight a different page after navigation.
  const source = element.textContent;
  try {
    const { parser, query } = await highlighter();
    if (!element.isConnected || element.textContent !== source) return;
    const tree = parser.parse(source);
    if (!tree) return;
    try {
      element.replaceChildren(highlightedText(source, query.captures(tree.rootNode)));
    } finally {
      tree.delete();
    }
  } catch (error) {
    console.warn('Magma highlighting unavailable; keeping plain text.', error);
  }
}
