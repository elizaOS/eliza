import type { TraceSpan } from '@evilmartians/agent-prism-types';

/**
 * Recursively filter spans based on a search query
 * Matches against span title, type, and attributes
 */
export function filterSpansRecursively(spans: TraceSpan[], searchQuery: string): TraceSpan[] {
  const query = searchQuery.toLowerCase().trim();
  if (!query) {
    return spans;
  }

  const filtered: TraceSpan[] = [];

  for (const span of spans) {
    // Check if current span matches
    const titleMatch = span.title.toLowerCase().includes(query);
    const typeMatch = span.type.toLowerCase().includes(query);
    const attributeMatch = span.attributes?.some(
      (attr) =>
        attr.key.toLowerCase().includes(query) ||
        attr.value.stringValue?.toLowerCase().includes(query) ||
        attr.value.intValue?.toLowerCase().includes(query)
    );

    const matchesQuery = titleMatch || typeMatch || attributeMatch;

    // Recursively filter children
    const filteredChildren = span.children
      ? filterSpansRecursively(span.children, searchQuery)
      : [];

    // Include span if it matches or if any of its children match
    if (matchesQuery || filteredChildren.length > 0) {
      filtered.push({
        ...span,
        children: filteredChildren.length > 0 ? filteredChildren : span.children,
      });
    }
  }

  return filtered;
}
