// What the page draws from text: icons, the Markdown specs use, Quint with its keywords marked, and a status dot.
import type { ReactNode } from "react";
import { Button, cn } from "@repo/ui";
import { S, select } from "./studio.ts";

const ICONS = {
  grip: "M6 4h.01M10 4h.01M6 8h.01M10 8h.01M6 12h.01M10 12h.01",
  chev: "M6 4l4 4-4 4",
  edit: "M10.5 3.5l2 2L6 12H4v-2z",
  trash: "M3.5 4.5h9M6.5 4.5V3h3v1.5M5 4.5l.5 8h5l.5-8",
  plus: "M8 3.5v9M3.5 8h9",
  check: "M3.5 8.5l3 3 6-7",
  close: "M4 4l8 8M12 4l-8 8",
  play: "M5 3.5l7 4.5-7 4.5z",
  stop: "M4.5 4.5h7v7h-7z",
  open: "M9 3h4v4M13 3L7.5 8.5M11 9.5V13H3V5h3.5",
  copy: "M5.5 5.5h7v7h-7zM3.5 10.5v-7h7",
  up: "M8 12.5v-9M4.5 7L8 3.5 11.5 7",
  undo: "M5.5 4L3 6.5 5.5 9M3 6.5h6.5a3 3 0 010 6H7",
} as const;
export type IconName = keyof typeof ICONS;

export const Icon = ({ name, className }: { name: IconName; className?: string }) => (
  <svg viewBox="0 0 16 16" aria-hidden className={cn("size-4 flex-none", className)}>
    <path d={ICONS[name]} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** A small button that is only an icon, named by `label`. */
export const IconButton = ({ name, label, onClick, danger = false }: { name: IconName; label: string; onClick: () => void; danger?: boolean }) => (
  <Button variant="ghost" size="icon" title={label} aria-label={label} className={cn("size-6 text-muted-foreground", danger && "hover:text-destructive")}
    onClick={(e) => { e.stopPropagation(); onClick(); }}>
    <Icon name={name} />
  </Button>
);

/** Where a spec, story or rule stands: failing a check, waiting for review, unpublished, or in step (no dot). */
export type Mark = "bad" | "review" | "dirty" | "ok" | "";
const DOT: Record<Mark, string> = { bad: "bg-destructive", review: "bg-warn", dirty: "bg-primary", ok: "bg-ok", "": "" };
export const Dot = ({ mark, label }: { mark: Mark; label: string }) => (
  <span role="img" aria-label={label || "in step"} title={label} className={cn("size-2 flex-none rounded-full", DOT[mark])} />
);

/** Inline Markdown: code, links (to another spec, or out), strong and emphasis. */
function inline(s: string, file: string): ReactNode[] {
  const out: ReactNode[] = [];
  let end = 0;
  for (const m of s.matchAll(/`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)|\*\*([^*]+)\*\*|\*([^*]+)\*/g)) {
    out.push(s.slice(end, m.index));
    const k = m.index;
    if (m[1]) out.push(<code key={k} className="rounded-sm bg-muted px-1 font-mono text-[0.9em]">{m[1]}</code>);
    else if (m[2]) {
      let link: URL | undefined;
      try { link = new URL(m[3], new URL(file, "https://spec.invalid/")); } catch { link = undefined; }
      const local = link?.origin === "https://spec.invalid";
      const name = local ? decodeURIComponent(link!.pathname).slice(1).replace(/\/$/, "") : "";
      const target = local && S.specs.find((spec) => !spec.deleted && [name, `${name}.md`, `${name}/index.md`].includes(spec.file));
      out.push(target ? <a key={k} href={`#${encodeURIComponent(target.file)}`} className="text-primary" onClick={(e) => { e.preventDefault(); select(target.file); }}>{m[2]}</a>
        : link && !local && /^https?:$/.test(link.protocol) ? <a key={k} href={link.href} target="_blank" rel="noreferrer" className="text-primary">{m[2]}</a> : m[0]);
    } else if (m[4]) out.push(<strong key={k}>{m[4]}</strong>);
    else out.push(<em key={k}>{m[5]}</em>);
    end = m.index + m[0].length;
  }
  return [...out, s.slice(end)];
}

/** Markdown, as far as specs use it: paragraphs, quotes, lists, code and tables kept as written. */
export function Markdown({ text, file, className }: { text: string; file: string; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {[...text.trim().matchAll(/(?:.|\n(?!\s*\n))+/g)].map(({ 0: block, index: at }) =>
        /^\s*(`{3,}|~{3,})/.test(block) ? <Code key={at}>{block.split("\n").slice(1, -1).join("\n")}</Code>
        : /^\|/.test(block) ? <Code key={at}>{block}</Code>
        : /^>/.test(block) ? <blockquote key={at} className="border-l-3 border-border pl-3">{inline(block.replace(/^>\s?/gm, ""), file)}</blockquote>
        : /^\s*[-*] /.test(block) ? <ul key={at} className="list-disc pl-5">{[...block.matchAll(/^\s*[-*] (.*(?:\n(?!\s*[-*] ).*)*)/gm)].map((l) => <li key={l.index}>{inline(l[1], file)}</li>)}</ul>
        : <p key={at}>{inline(block, file)}</p>)}
    </div>
  );
}

const KEYWORDS = /^(pure|def|val|const|type|import|from|if|else|match|and|or|not|implies|iff|all|any|Set|List|Map|int|bool|str|true|false|module|as)$/;
const KIND = { com: "text-muted-foreground italic", str: "text-ok", num: "text-warn", kw: "text-primary", def: "font-semibold" };
/** Quint, marked: keywords, the names a block defines, strings, numbers and comments. */
export function Quint({ code }: { code: string }) {
  const out: ReactNode[] = [];
  let end = 0;
  for (const match of code.matchAll(/(\/\/.*)|("(?:[^"\\\n]|\\.)*")|\b(\d+)\b|\b([A-Za-z_]\w*)\b/g)) {
    const [text, com, str, num, word] = match;
    out.push(code.slice(end, match.index));
    const kind = com ? "com" : str ? "str" : num ? "num" : KEYWORDS.test(word) ? "kw"
      : /\b(def|val|type)\s+$/.test(code.slice(Math.max(0, match.index - 6), match.index)) ? "def" : undefined;
    out.push(kind ? <span key={match.index} className={KIND[kind]}>{text}</span> : text);
    end = match.index + text.length;
  }
  return <Code>{[...out, code.slice(end)]}</Code>;
}

export const Code = ({ children, className }: { children: ReactNode; className?: string }) => (
  <pre className={cn("m-0 overflow-x-auto rounded-md border border-border bg-muted px-3 py-2 font-mono text-xs leading-relaxed", className)}>{children}</pre>
);
