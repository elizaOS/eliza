/**
 * Parser for the single-line `[CONNECTOR:<pluginId>]` marker emitted by agent
 * replies during connector-setup turns. The marker renders as the compact
 * branded connector card (icon + description + one Authorize/Add-token CTA) —
 * the lightweight sibling of `[CONFIG:<pluginId>]`, which renders the full
 * configuration form. Lives in its own module so unit tests can exercise the
 * region extraction without pulling the `MessageContent` React graph.
 */

// Keep the id charset in lockstep with CONFIG_RE (message-parser-helpers.ts):
// both markers name the same plugin-id namespace.
export const CONNECTOR_RE = /\[CONNECTOR:([@\w][\w@./:-]*)\]/g;

export interface ConnectorCardMatch {
  start: number;
  end: number;
  pluginId: string;
}

/** Find every `[CONNECTOR:…]` marker in `text` with its character region. */
export function findConnectorCardRegions(text: string): ConnectorCardMatch[] {
  const results: ConnectorCardMatch[] = [];
  CONNECTOR_RE.lastIndex = 0;
  let m: RegExpExecArray | null = CONNECTOR_RE.exec(text);
  while (m !== null) {
    results.push({
      start: m.index,
      end: m.index + m[0].length,
      pluginId: m[1],
    });
    m = CONNECTOR_RE.exec(text);
  }
  return results;
}
