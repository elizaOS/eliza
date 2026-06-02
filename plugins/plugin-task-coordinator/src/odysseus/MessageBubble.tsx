// odysseus message bubbles (static/index.html .msg-user / .msg-ai). User turns
// are right-aligned rounded bubbles; agent turns are left bubbles with a model
// role header (dot + name) above flat markdown. Prose + code render through the
// shared MarkdownText so we don't re-solve markdown here.
//
// Each bubble carries:
//   • a per-turn action footer — odysseus chatRenderer.js createUserMsgFooter /
//     createMsgFooter. Odysseus's user footer offers edit / delete / copy /
//     resend with an overflow menu, but edit / delete / resend all require
//     per-message mutation endpoints the orchestrator does not expose (the
//     client only has postOrchestratorTaskMessage + a whole-task delete — there
//     is no per-message PUT/DELETE). So, exactly as ChatMessages' AgentFooter
//     does for the assistant turn, we ship only the honest wired subset: a Copy
//     button. No dead edit/delete/resend controls that route nowhere.
//   • a sensitive-info censor — odysseus static/js/censor.js. Pure client-side:
//     it blurs emails / API keys / tokens / JWTs / private keys / internal IPs
//     in the rendered body and reveals an item on click. Off by default, gated
//     on the same opt-in pref odysseus uses (`odysseus-sensitive-blur`), so it
//     never alters output unless the user turned it on.

import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { MarkdownText } from "../orchestrator-markdown";
import type { ConversationBlock } from "../orchestrator-stream";
import { formatClockTime } from "../view-format";

type UserBlock = Extract<ConversationBlock, { kind: "user" }>;
type AgentBlock = Extract<ConversationBlock, { kind: "agent" }>;

// ── Sensitive-info censor (odysseus static/js/censor.js) ───────────────────
// Patterns that mark a substring as sensitive. Ported 1:1 from censor.js
// PATTERNS — emails, API-key prefixes, bearer tokens, key=value credentials,
// PEM private keys, long hashes, JWTs, internal-network IPs.
const CENSOR_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g, label: "email" },
  {
    re: /\b(sk-[a-zA-Z0-9]{20,}|pk-[a-zA-Z0-9]{20,}|ghp_[a-zA-Z0-9]{36,}|gho_[a-zA-Z0-9]{36,}|glpat-[a-zA-Z0-9\-_]{20,}|xox[bpras]-[a-zA-Z0-9-]{10,}|npm_[a-zA-Z0-9]{36,}|AKIA[A-Z0-9]{12,})\b/g,
    label: "api-key",
  },
  { re: /Bearer\s+[A-Za-z0-9._-]{20,}/g, label: "token" },
  {
    re: /(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|private[_-]?key|client[_-]?secret)[\s]*[:=]\s*["']?[^\s"'<]{4,}["']?/gi,
    label: "credential",
  },
  {
    re: /-----BEGIN\s[\w\s]*PRIVATE KEY-----[\s\S]*?-----END\s[\w\s]*PRIVATE KEY-----/g,
    label: "private-key",
  },
  { re: /\b[0-9a-f]{32,}\b/gi, label: "hash" },
  {
    re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    label: "jwt",
  },
  {
    re: /\b(?:10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])|192\.168)\.\d{1,3}\.\d{1,3}(?::\d+)?\b/g,
    label: "internal-ip",
  },
];

const CENSOR_PREF_KEY = "odysseus-sensitive-blur";

// How long the Copy button shows its success glyph before reverting (odysseus
// chatRenderer.js footer-copy-btn reverts after 1500ms).
const COPY_FEEDBACK_MS = 1500;

/** Mirrors censor.js `_prefEnabled` — opt-in, off unless explicitly turned on. */
function censorEnabled(): boolean {
  if (typeof localStorage === "undefined") return false;
  try {
    return localStorage.getItem(CENSOR_PREF_KEY) === "on";
  } catch {
    return false;
  }
}

interface CensorMatch {
  start: number;
  end: number;
  text: string;
  label: string;
}

/** Wrap sensitive substrings inside a single text node with `.od-censored`
 * spans. Faithful to censor.js `_processElement` Pass 1: collect every pattern
 * match, merge overlaps, then splice the node into text / censored fragments. */
function censorTextNode(node: Text): void {
  const text = node.textContent;
  if (!text || text.trim().length < 4) return;

  const matches: CensorMatch[] = [];
  for (const pattern of CENSOR_PATTERNS) {
    pattern.re.lastIndex = 0;
    let m = pattern.re.exec(text);
    while (m !== null) {
      matches.push({
        start: m.index,
        end: m.index + m[0].length,
        text: m[0],
        label: pattern.label,
      });
      m = pattern.re.exec(text);
    }
  }
  if (matches.length === 0) return;

  matches.sort((a, b) => a.start - b.start);
  const deduped: CensorMatch[] = [matches[0]];
  for (let i = 1; i < matches.length; i++) {
    const prev = deduped[deduped.length - 1];
    if (matches[i].start < prev.end) {
      if (matches[i].end > prev.end) prev.end = matches[i].end;
    } else {
      deduped.push(matches[i]);
    }
  }

  const frag = document.createDocumentFragment();
  let lastIdx = 0;
  for (const match of deduped) {
    if (match.start > lastIdx) {
      frag.appendChild(
        document.createTextNode(text.slice(lastIdx, match.start)),
      );
    }
    const span = document.createElement("span");
    span.className = "od-censored";
    span.dataset.type = match.label;
    span.title = `Click to reveal ${match.label}`;
    span.textContent = match.text;
    frag.appendChild(span);
    lastIdx = match.end;
  }
  if (lastIdx < text.length) {
    frag.appendChild(document.createTextNode(text.slice(lastIdx)));
  }
  node.parentNode?.replaceChild(frag, node);
}

/** Walk every (uncensored, non-`<pre>`) text node under `root` and censor it. */
function censorElement(root: HTMLElement): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const targets: Text[] = [];
  let node = walker.nextNode();
  while (node !== null) {
    // SHOW_TEXT yields only Text nodes; the instanceof keeps the type honest
    // (no cast) and satisfies the parentElement access below.
    if (node instanceof Text) {
      const parent = node.parentElement;
      // Don't censor code blocks or anything already censored.
      if (parent && !parent.closest("pre, .od-censored")) targets.push(node);
    }
    node = walker.nextNode();
  }
  for (const target of targets) censorTextNode(target);
}

/** Hook: run the censor over a body ref after each render of `content`, and
 * wire click-to-reveal on the censored spans. No-op unless the pref is on. */
function useCensoredBody(content: string) {
  const ref = useRef<HTMLDivElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-censor whenever the rendered body content changes
  useEffect(() => {
    const el = ref.current;
    if (!el || !censorEnabled()) return;
    censorElement(el);
    const onClick = (e: MouseEvent) => {
      const target = e.target;
      if (!(target instanceof HTMLElement)) return;
      const item = target.closest(".od-censored");
      if (!item) return;
      e.preventDefault();
      e.stopPropagation();
      item.classList.toggle("revealed");
    };
    el.addEventListener("click", onClick);
    return () => el.removeEventListener("click", onClick);
  }, [content]);

  return ref;
}

/** Hover-revealed Copy action for one turn — odysseus footer-copy-btn. Copy is
 * the only footer action with a real wired surface (it is pure client-side);
 * edit / delete / resend need per-message mutation endpoints the orchestrator
 * does not expose, so they are intentionally absent rather than dead controls.
 * Mirrors ChatMessages' AgentFooter so user and assistant footers behave alike. */
function CopyFooter({ content }: { content: string }): ReactNode {
  const [copied, setCopied] = useState(false);
  // Revert timer for the success glyph; cleared on unmount and before re-arming
  // so copying a message that unmounts within the window never sets state on an
  // unmounted component.
  const revertRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (revertRef.current !== null) clearTimeout(revertRef.current);
    },
    [],
  );

  const onCopy = useCallback(() => {
    // Guard for non-secure-context / older webviews where clipboard is absent.
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText)
      return;
    navigator.clipboard.writeText(content).then(
      () => {
        setCopied(true);
        if (revertRef.current !== null) clearTimeout(revertRef.current);
        revertRef.current = setTimeout(
          () => setCopied(false),
          COPY_FEEDBACK_MS,
        );
      },
      () => undefined,
    );
  }, [content]);

  return (
    <div className="od-msg-footer">
      <span className="od-msg-actions">
        <button
          type="button"
          className="od-footer-copy-btn"
          title={copied ? "Copied" : "Copy message"}
          aria-label={copied ? "Copied" : "Copy message"}
          data-copied={copied ? "true" : undefined}
          onClick={onCopy}
        >
          {copied ? <CheckGlyph /> : <CopyGlyph />}
        </button>
      </span>
    </div>
  );
}

// odysseus chatRenderer.js COPY_ICON / CHECK_ICON, as inline SVG so the footer
// matches the upstream copy affordance exactly (lucide is used elsewhere; these
// two-stroke glyphs are the odysseus originals).
function CopyGlyph(): ReactNode {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function CheckGlyph(): ReactNode {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

export function UserBubble({
  block,
  locale,
}: {
  block: UserBlock;
  locale?: string;
}): ReactNode {
  const bodyRef = useCensoredBody(block.content);
  return (
    <div className="od-msg od-msg-user">
      <div className="od-body" ref={bodyRef}>
        <MarkdownText text={block.content} />
      </div>
      <div className="od-msg-time">{formatClockTime(block.at, locale)}</div>
      <CopyFooter content={block.content} />
    </div>
  );
}

export function AgentBubble({
  block,
  locale,
}: {
  block: AgentBlock;
  locale?: string;
}): ReactNode {
  const bodyRef = useCensoredBody(block.content);
  return (
    <div className="od-msg od-msg-ai">
      <div className="od-role">{block.senderName}</div>
      <div
        className={`od-body${block.tone === "error" ? " od-body-error" : ""}`}
        ref={bodyRef}
      >
        <MarkdownText text={block.content} />
      </div>
      <div className="od-msg-time">{formatClockTime(block.at, locale)}</div>
    </div>
  );
}
