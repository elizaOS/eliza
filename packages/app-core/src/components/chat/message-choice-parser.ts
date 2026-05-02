/**
 * Parser for `[CHOICE:<scope>(?: id=<id>)?]\n...lines...\n[/CHOICE]` blocks
 * emitted by agent actions. Lives in its own module so unit tests can
 * exercise the regex/option extraction without pulling the entire
 * `MessageContent` React graph (which transitively imports the runtime).
 */

import type { ChoiceOption } from "./widgets/ChoiceWidget";

export const CHOICE_RE =
  /\[CHOICE:([\w-]+)(?:\s+id=(\S+))?\]\n([\s\S]*?)\n\[\/CHOICE\]/g;

export function generateChoiceId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return `choice-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
}

export function parseChoiceBody(body: string): ChoiceOption[] {
  const options: ChoiceOption[] = [];
  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const value = line.slice(0, eq).trim();
    const label = line.slice(eq + 1).trim();
    if (!value || !label) continue;
    options.push({ value, label });
  }
  return options;
}

export interface ChoiceMatch {
  start: number;
  end: number;
  id: string;
  scope: string;
  options: ChoiceOption[];
}

/** Find every CHOICE block in `text` and return their character regions. */
export function findChoiceRegions(text: string): ChoiceMatch[] {
  const results: ChoiceMatch[] = [];
  CHOICE_RE.lastIndex = 0;
  let m: RegExpExecArray | null = CHOICE_RE.exec(text);
  while (m !== null) {
    const scope = m[1];
    const id = m[2] && m[2].length > 0 ? m[2] : generateChoiceId();
    const options = parseChoiceBody(m[3]);
    if (options.length > 0) {
      results.push({
        start: m.index,
        end: m.index + m[0].length,
        id,
        scope,
        options,
      });
    }
    m = CHOICE_RE.exec(text);
  }
  return results;
}
