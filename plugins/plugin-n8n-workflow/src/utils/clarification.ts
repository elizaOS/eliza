import type { ClarificationRequest } from '../types';

/**
 * Marker used by the service to flag clarifications produced by post-LLM
 * catalog validation (vs. clarifications emitted by the LLM itself). Hosts
 * may surface these differently if needed.
 */
export const CATALOG_CLARIFICATION_SUFFIX =
  '— please provide this value or clarify your requirements';

export function isCatalogClarificationString(value: string): boolean {
  return value.endsWith(CATALOG_CLARIFICATION_SUFFIX);
}

export function isCatalogClarification(item: string | ClarificationRequest): boolean {
  return typeof item === 'string'
    ? isCatalogClarificationString(item)
    : isCatalogClarificationString(item.question);
}

/**
 * Normalize a mixed-shape clarifications array into structured
 * `ClarificationRequest` objects. Legacy strings become `kind: 'free_text'`
 * with an empty `paramPath` (host renders a free-form input instead of a
 * picker). Structured items pass through unchanged.
 */
export function coerceClarificationRequests(
  items: ReadonlyArray<string | ClarificationRequest> | undefined | null
): ClarificationRequest[] {
  if (!items || items.length === 0) {
    return [];
  }
  const out: ClarificationRequest[] = [];
  for (const item of items) {
    if (typeof item === 'string') {
      const trimmed = item.trim();
      if (trimmed.length === 0) {
        continue;
      }
      out.push({ kind: 'free_text', question: trimmed, paramPath: '' });
    } else if (item && typeof item === 'object' && typeof item.question === 'string') {
      out.push({
        kind: item.kind ?? 'free_text',
        platform: item.platform,
        scope: item.scope,
        question: item.question,
        paramPath: typeof item.paramPath === 'string' ? item.paramPath : '',
      });
    }
  }
  return out;
}
