/**
 * Parser for `[CONNECTOR:<id> …]…[/CONNECTOR]` blocks the agent emits to render
 * a connector-setup widget inline in chat. Lives in its own module so unit
 * tests can exercise the regex/param extraction without pulling the widget's
 * React graph (which transitively imports the runtime), mirroring the other
 * `message-*-parser.ts` modules.
 *
 * Body lines are `KEY|required|isSet|label` tuples describing the connector's
 * parameter schema (the shape `buildPluginConfigUiSpec` consumes). The widget
 * derives minimal-vs-advanced tiers and the connected state from these; secrets
 * are never rendered as plain fields — the widget routes them through the
 * sensitive-request flow, so only the schema (never a value) travels in-band.
 */
import type { PluginParam } from "@elizaos/shared";

// Attributes (`name=…`) are captured as one string and split below so they may
// appear in any order; the body is the newline-delimited param schema.
export const CONNECTOR_RE =
  /\[CONNECTOR:([\w-]+)(?:\s+([^\]]*))?\]\n([\s\S]*?)\n\[\/CONNECTOR\]/g;

export interface ConnectorMatch {
  start: number;
  end: number;
  id: string;
  name: string;
  params: PluginParam[];
}

/** Parse a `KEY|required|isSet|label`-per-line body into typed params. */
export function parseConnectorBody(body: string): PluginParam[] {
  const params: PluginParam[] = [];
  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const [key, required, isSet, label] = line.split("|");
    const trimmedKey = key?.trim();
    if (!trimmedKey) continue;
    params.push({
      key: trimmedKey,
      required: required?.trim() === "1",
      isSet: isSet?.trim() === "1",
      ...(label?.trim() ? { label: label.trim() } : {}),
    });
  }
  return params;
}

/** Read the `name="…"` attribute from a CONNECTOR header attribute string. */
function parseConnectorName(
  attrs: string | undefined,
  fallback: string,
): string {
  if (!attrs) return fallback;
  const match = attrs.match(/name="([^"]*)"/);
  return match?.[1]?.trim() || fallback;
}

/** Find every CONNECTOR block in `text` and return their character regions. */
export function findConnectorRegions(text: string): ConnectorMatch[] {
  const matches: ConnectorMatch[] = [];
  CONNECTOR_RE.lastIndex = 0;
  let m = CONNECTOR_RE.exec(text);
  while (m !== null) {
    const id = m[1];
    matches.push({
      start: m.index,
      end: m.index + m[0].length,
      id,
      name: parseConnectorName(m[2], id),
      params: parseConnectorBody(m[3]),
    });
    m = CONNECTOR_RE.exec(text);
  }
  return matches;
}
