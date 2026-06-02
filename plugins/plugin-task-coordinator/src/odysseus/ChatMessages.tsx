// The message log. Reuses buildConversation's block list: user/agent turns are
// rendered as odysseus bubbles; tool/reasoning/notice blocks reuse the shared
// ConversationBlockView (which inherits the odysseus palette via the remapped
// theme vars). Sticks to the newest entry unless the user has scrolled up.
//
// Deepened toward odysseus 1:1 with the citation surface (chatRenderer.js
// buildSourcesBox / buildRagSourcesBox): an assistant turn that carries
// web/research/RAG sources renders a collapsible SOURCES box directly under the
// bubble — the same affordance odysseus prepends to an assistant message. The
// box is rendered ONLY when sources are actually present on the agent block's
// metadata; eliza's orchestrator stream does not emit citations today, so this
// stays an honest no-op until it does (see integration notes — no fabricated
// sources are ever shown). Thinking/reasoning already renders 1:1 via the
// `reasoning` block → ConversationBlockView → ReasoningCell path below, which
// inherits the odysseus theme vars.

import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { ConversationBlock } from "../orchestrator-stream";
import { ConversationBlockView } from "../orchestrator-stream";
import { AgentBubble, UserBubble } from "./MessageBubble";

// ── Typed citation shapes (chatRenderer.js metadata.web_sources / .rag_sources) ──
interface WebSource {
  url: string;
  title: string;
}
interface RagSource {
  filename: string;
  similarity: number | null;
  snippet: string;
}

type AgentBlock = Extract<ConversationBlock, { kind: "agent" }>;

/** Coerce an unknown value to a plain object, or undefined. Used to read the
 * optional `metadata` bag an agent block may carry without widening the
 * ConversationBlock contract (orchestrator-stream owns that type). */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    out[key] = Reflect.get(value, key);
  }
  return out;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Parse `metadata.web_sources` (or `research_sources`) into typed WebSources,
 * dropping any malformed entry. Honest: returns [] when the key is absent. */
function parseWebSources(
  bag: Record<string, unknown>,
  key: string,
): WebSource[] {
  const raw = bag[key];
  if (!Array.isArray(raw)) return [];
  const out: WebSource[] = [];
  for (const entry of raw) {
    const rec = asRecord(entry);
    if (!rec) continue;
    const url = asString(rec.url);
    if (url === "") continue;
    out.push({ url, title: asString(rec.title) });
  }
  return out;
}

/** Parse `metadata.rag_sources` into typed RagSources (filename + similarity +
 * snippet — no URLs, unlike web sources). Honest: [] when absent/malformed. */
function parseRagSources(bag: Record<string, unknown>): RagSource[] {
  const raw = bag.rag_sources;
  if (!Array.isArray(raw)) return [];
  const out: RagSource[] = [];
  for (const entry of raw) {
    const rec = asRecord(entry);
    if (!rec) continue;
    const similarity =
      typeof rec.similarity === "number" && Number.isFinite(rec.similarity)
        ? rec.similarity
        : null;
    out.push({
      filename: asString(rec.filename),
      similarity,
      snippet: asString(rec.snippet),
    });
  }
  return out;
}

/** Hostname (sans `www.`) for the dim source-domain label; falls back to the
 * raw url when it doesn't parse. Mirrors chatRenderer.js's domain derivation. */
function sourceDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Only http(s) links survive (chatRenderer.js `_safeHref`); anything else is
 * neutralised so a malformed/`javascript:` citation can't become a live link. */
function safeHref(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return url;
  } catch {
    /* invalid URL */
  }
  return "#";
}

// Search glyph for the box header (chatRenderer.js SEARCH_ICON), inline so it
// inherits currentColor (--red) like the upstream box.
function SearchIcon(): ReactNode {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      width="14"
      height="14"
      aria-hidden="true"
      role="img"
    >
      <circle cx="11" cy="11" r="8" />
      <path d="M21 21l-4.35-4.35" />
    </svg>
  );
}

/** Collapsible web/research citation box (chatRenderer.js buildSourcesBox).
 * Expand state is local component state, replacing odysseus's global
 * `window.toggleSources` delegation. Renders nothing when `sources` is empty. */
function SourcesBox({
  sources,
  variant,
}: {
  sources: WebSource[];
  variant: "web" | "research";
}): ReactNode {
  const [expanded, setExpanded] = useState(false);
  if (sources.length === 0) return null;
  const label = variant === "research" ? "Research sources" : "Web sources";
  return (
    <div className="od-sources-section">
      <button
        type="button"
        className="od-sources-header"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="od-sources-header-left">
          <SearchIcon />
          <span>
            {sources.length} {label}
          </span>
        </span>
        <span
          className="od-sources-toggle"
          data-arrow={expanded ? "down" : "right"}
        />
      </button>
      {expanded ? (
        <div className="od-sources-content">
          <div className="od-sources-content-inner">
            {sources.map((s, i) => {
              const domain = sourceDomain(s.url);
              return (
                <a
                  key={s.url}
                  href={safeHref(s.url)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="od-source-link"
                >
                  <span className="od-source-num">{i + 1}</span>
                  <span className="od-source-title">{s.title || domain}</span>
                  <span className="od-source-domain">{domain}</span>
                </a>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** RAG "Sources (N documents)" box (chatRenderer.js buildRagSourcesBox) — a
 * native <details> with filename + similarity % + snippet per item. Renders
 * nothing when empty. */
function RagSourcesBox({ sources }: { sources: RagSource[] }): ReactNode {
  if (sources.length === 0) return null;
  return (
    <details className="od-rag-sources">
      <summary>Sources ({sources.length} documents)</summary>
      {sources.map((s) => (
        <div className="od-rag-source-item" key={`${s.filename}|${s.snippet}`}>
          <strong>{s.filename}</strong>
          {s.similarity !== null ? (
            <span className="od-rag-similarity">
              {(s.similarity * 100).toFixed(1)}%
            </span>
          ) : null}
          <div className="od-rag-snippet">{s.snippet}</div>
        </div>
      ))}
    </details>
  );
}

/** The citation footer for one assistant turn: web + research + RAG boxes,
 * each self-suppressing when empty. Reads the agent block's optional `metadata`
 * bag (forwarded by orchestrator-stream if/when the orchestrator emits
 * citations) without widening the ConversationBlock contract. */
function AgentSources({ block }: { block: AgentBlock }): ReactNode {
  // The `agent` ConversationBlock type owns no `metadata` field today, so read
  // it through a runtime-safe Record view (no cast) — forward-compatible with
  // orchestrator-stream forwarding the message metadata bag onto the block.
  const blockBag = asRecord(block);
  const bag = blockBag ? asRecord(blockBag.metadata) : undefined;
  // Parsing is trivial and the source set is empty today, so derive inline —
  // `bag` is freshly cloned each render, which would defeat a useMemo cache.
  const web = bag ? parseWebSources(bag, "web_sources") : [];
  const research = bag ? parseWebSources(bag, "research_sources") : [];
  const rag = bag ? parseRagSources(bag) : [];
  if (web.length === 0 && research.length === 0 && rag.length === 0)
    return null;
  return (
    <div className="od-msg-sources">
      <SourcesBox sources={research} variant="research" />
      <SourcesBox sources={web} variant="web" />
      <RagSourcesBox sources={rag} />
    </div>
  );
}

export function ChatMessages({
  conversation,
  locale,
}: {
  conversation: ConversationBlock[];
  locale?: string;
}): ReactNode {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottom.current = distance < 80;
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: conversation is the trigger
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [conversation.length, conversation[conversation.length - 1]?.key]);

  return (
    <div className="od-chat-history" ref={scrollRef} onScroll={onScroll}>
      {conversation.map((block) => {
        if (block.kind === "user")
          return <UserBubble key={block.key} block={block} locale={locale} />;
        if (block.kind === "agent")
          return (
            <div className="od-msg-group" key={block.key}>
              <AgentBubble block={block} locale={locale} />
              <AgentSources block={block} />
            </div>
          );
        return (
          <div className="od-msg-cells" key={block.key}>
            <ConversationBlockView block={block} locale={locale} />
          </div>
        );
      })}
    </div>
  );
}
