// A spec's Markdown as an outline (spec/outline.md), and back. Read losslessly: a story or rule nobody edited is
// written back byte for byte. Runs on the server and in the page, so it imports only the line scanner and types.
import { scanSpec } from "../../scan.ts";
import type { Outline, Rule, Story } from "../gen/outline.ts";

/** A run of prose, or the code of one quint block. */
export interface Item { quint: boolean; text: string }

/** The key a story has in the review ledger, `## <title>`, and a rule's, `<story> / <heading>`. */
export const storyKey = (title: string) => `## ${title.trim()}`;
export const ruleKey = (story: string, title: string) => `${story.trim()} / ${title.trim()}`;
/** Which story or rule of which spec a node is, as the manifest and the page's origins name it. */
export const nodeId = (file: string, key: string) => `${file}\0${key}`;
/** The mark of each kind of change in the manifest (./doc.ts), in the prompt and on the page. */
export const SIGN = { added: "+", deleted: "-", changed: "~" } as const;

/** A story, or a rule with its story's id, of an outline in one spec, with its ledger key and node id. */
export interface OutlineNode { id: string; key: string; story: Story; rule?: Rule; parent?: string }
export const nodesOfOutline = (file: string, o: Outline): OutlineNode[] => o.stories.flatMap((story) => {
  const parent = nodeId(file, storyKey(story.title));
  return [{ id: parent, key: storyKey(story.title), story }, ...story.rules.map((rule) => {
    const key = ruleKey(story.title, rule.title);
    return { id: nodeId(file, key), key, story, rule, parent };
  })];
});

/** How list `a` becomes `b`, by their longest common subsequence: each item kept (" "), removed ("-") or added ("+"), named by where it is in both. */
export function edits<T>(a: T[], b: T[]): { op: " " | "+" | "-"; item: T; at: string }[] {
  const n = a.length, m = b.length;
  const t = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) t[i][j] = a[i] === b[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
  const out: ReturnType<typeof edits<T>> = [];
  for (let i = 0, j = 0; i < n || j < m; ) {
    const at = `${i}:${j}`;
    if (i < n && j < m && a[i] === b[j]) { out.push({ op: " ", item: a[i], at }); i++; j++; }
    else if (i < n && (j >= m || t[i + 1][j] >= t[i][j + 1])) out.push({ op: "-", item: a[i++], at });
    else out.push({ op: "+", item: b[j++], at });
  }
  return out;
}

/** Specs in the order the rail lists them: a directory's index.md before the specs in it. */
const orderKey = (file: string) => file.replace(/(?:^spec\/|\/)index\.md$/, "/");
export const specOrder = (a: string, b: string) => orderKey(a).localeCompare(orderKey(b));

/**
 * The outline of a spec's text. Numbers run from 1 in the order of the text, and each story and rule keeps the key it
 * has in `file` as its origin. Rules before the first story become a story with no heading, which cannot be published
 * until it has one.
 */
export function outlineOf(file: string, text: string): Outline {
  const o: Outline = { title: "", body: "", stories: [], counter: 1 };
  let story: Story | undefined;
  let rule: Rule | undefined;
  const lines = scanSpec(text);
  lines.forEach(({ text: line, kind }, i) => {
    const end = i < lines.length - 1 ? "\n" : "";
    if (kind === "story" || (kind === "rule" && !story)) {
      const title = kind === "story" ? line.slice(3) : "";
      story = { id: o.counter++, title, body: "", origin: kind === "story" ? nodeId(file, storyKey(title)) : "", rules: [] };
      o.stories.push(story);
      rule = undefined;
      if (kind === "story") return;
    }
    if (kind === "rule") {
      rule = { id: o.counter++, title: line.slice(4), body: "", origin: nodeId(file, ruleKey(story!.title, line.slice(4))) };
      story!.rules.push(rule);
    } else if (i === 0 && line.startsWith("# ")) o.title = line.slice(2);
    else if (rule) rule.body += line + end;
    else if (story) story.body += line + end;
    else o.body += line + end;
  });
  return o;
}

/**
 * The text of an outline. `tidy` puts a blank line before every heading and ends the text with one newline, for a
 * spec that was edited: a story or rule moved to the end of another may have had nothing after it.
 */
export function textOf(o: Outline, tidy = false): string {
  let text = o.title ? `# ${o.title}\n` : "";
  text += o.body;
  const heading = (line: string) => {
    if (tidy && text && !text.endsWith("\n\n")) text += text.endsWith("\n") ? "\n" : "\n\n";
    text += line;
  };
  for (const s of o.stories) {
    heading(`## ${s.title}\n`);
    text += s.body;
    for (const r of s.rules) { heading(`### ${r.title}\n`); text += r.body; }
  }
  return tidy ? text.replace(/\n\n+$/, "\n") : text;
}

/** A rule's body as alternating prose and quint code, trimmed, empty runs dropped. */
export function itemsOf(body: string): Item[] {
  const items: Item[] = [];
  let inQuint = false;
  for (const { text, kind } of scanSpec(body)) {
    if (kind === "open quint") items.push({ quint: (inQuint = true), text: "" });
    else if (kind === "close" && inQuint) { inQuint = false; items.push({ quint: false, text: "" }); }
    else {
      if (!items.length) items.push({ quint: false, text: "" });
      items[items.length - 1].text += text + "\n";
    }
  }
  return items.map((i) => ({ quint: i.quint, text: i.quint ? i.text.replace(/\s+$/, "") : i.text.trim() })).filter((i) => i.text);
}

const fenceFor = (code: string) => "`".repeat(Math.max(3, ...(code.match(/`{3,}/g) ?? []).map((m) => m.length + 1)));
/** A rule's body from its items: one blank line around each, prose trimmed, empty items dropped. */
export const bodyOf = (items: Item[]) => items.filter((i) => i.text.trim()).map((i) => {
  if (!i.quint) return `\n${i.text.trim()}\n`;
  const f = fenceFor(i.text);
  return `\n${f}quint\n${i.text.replace(/\s+$/, "")}\n${f}\n`;
}).join("") + "\n";
/** A story's text, or a spec's introduction, from what was typed. */
export const textBody = (text: string) => (text.trim() ? `\n${text.trim()}\n\n` : "\n");
