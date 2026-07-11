/**
 * MessageSearchPanel — keyword search across conversations with jump-to-message
 * (#9955). Self-contained + presentation-only: the caller injects how to `search`
 * (→ `client.searchConversationMessages`) and what to do `onJump` (select the
 * conversation + scroll the message into view), so the panel unit-tests in
 * isolation and stays decoupled from the chat shell.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { ConversationMessageSearchResult } from "../../../api/client-types-chat";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";

const MIN_QUERY_LENGTH = 2;
const DEBOUNCE_MS = 250;

export interface MessageSearchPanelProps {
  /** Runs the keyword search; rejects/aborts are handled by the panel. */
  search: (
    query: string,
    signal: AbortSignal,
  ) => Promise<ConversationMessageSearchResult[]>;
  /** Navigate to the result's conversation and scroll the message into view. */
  onJump: (result: ConversationMessageSearchResult) => void;
  /** Close the panel (Escape, or after a jump). */
  onClose: () => void;
  /** Optional initial query (e.g. selected text). */
  initialQuery?: string;
  /**
   * Where the search input sits relative to its results.
   *
   * - `"stacked"` (default): the input is the FIRST child and the results/
   *   status flow beneath it. The desktop / no-keyboard reading order.
   * - `"keyboard-anchored"`: the input is the LAST child, pinned to the panel
   *   bottom (right above a raised mobile keyboard) while the results scroll in
   *   the space ABOVE it. This is the mobile chat-sheet layout: it guarantees
   *   the input the user is typing into is never occluded by the soft keyboard,
   *   and the results occupy the shrinking visible region between the sheet top
   *   and the keyboard (matching the composer's own bottom-anchored geometry).
   *   The container is responsible for being a bottom-anchored flex column; the
   *   panel renders `results (scroll) → input` in DOM order so the input is the
   *   flex item pinned at the bottom.
   */
  layout?: "stacked" | "keyboard-anchored";
}

type Status = "idle" | "loading" | "ready" | "error";

export function MessageSearchPanel({
  search,
  onJump,
  onClose,
  initialQuery = "",
  layout = "stacked",
}: MessageSearchPanelProps) {
  const keyboardAnchored = layout === "keyboard-anchored";
  const [query, setQuery] = useState(initialQuery);
  const [results, setResults] = useState<ConversationMessageSearchResult[]>([]);
  const [status, setStatus] = useState<Status>("idle");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Debounced search; a fresh keystroke aborts the in-flight request.
  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < MIN_QUERY_LENGTH) {
      setResults([]);
      setStatus("idle");
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setStatus("loading");
      try {
        const found = await search(trimmed, controller.signal);
        if (controller.signal.aborted) return;
        setResults(found);
        setStatus("ready");
      } catch (err) {
        // error-policy:J4 aborted searches are expected; real failures render
        // the panel's error state
        if (
          controller.signal.aborted ||
          (err as Error)?.name === "AbortError"
        ) {
          return;
        }
        setResults([]);
        setStatus("error");
      }
    }, DEBOUNCE_MS);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [query, search]);

  const handleJump = useCallback(
    (result: ConversationMessageSearchResult) => {
      onJump(result);
      onClose();
    },
    [onJump, onClose],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    },
    [onClose],
  );

  const trimmed = query.trim();
  const tooShort = trimmed.length > 0 && trimmed.length < MIN_QUERY_LENGTH;

  const inputEl = (
    <Input
      ref={inputRef}
      type="search"
      value={query}
      onChange={(e) => setQuery(e.target.value)}
      placeholder="Search messages…"
      aria-label="Search messages"
      data-testid="message-search-input"
      // In the keyboard-anchored layout the input is the flex item pinned at
      // the panel bottom (right above the soft keyboard); it must never shrink
      // away when the results list above it is long.
      className={
        keyboardAnchored
          ? "shrink-0 border-white/15 bg-white/[0.08] text-white shadow-sm placeholder:text-white/45"
          : undefined
      }
    />
  );

  const statusEl = (
    <>
      {tooShort ? (
        <p className="px-1 text-xs text-muted-foreground">
          Type at least {MIN_QUERY_LENGTH} characters.
        </p>
      ) : null}

      {status === "loading" ? (
        <p
          data-testid="message-search-loading"
          className="px-1 text-xs text-muted-foreground"
        >
          Searching…
        </p>
      ) : null}

      {status === "error" ? (
        <p
          data-testid="message-search-error"
          className="px-1 text-xs text-destructive"
        >
          Search failed. Try again.
        </p>
      ) : null}

      {status === "ready" && results.length === 0 ? (
        <p
          data-testid="message-search-empty"
          className="px-1 text-xs text-muted-foreground"
        >
          No messages match “{trimmed}”.
        </p>
      ) : null}
    </>
  );

  const resultsListEl =
    results.length > 0 ? (
      <ul data-testid="message-search-results" className="flex flex-col gap-1">
        {results.map((result) => (
          <li key={result.messageId}>
            <Button
              data-testid="message-search-result"
              onClick={() => handleJump(result)}
              variant="ghost"
              className={
                keyboardAnchored
                  ? "flex h-auto w-full flex-col items-start gap-0.5 whitespace-normal rounded-lg border border-transparent bg-white/[0.04] px-3 py-2 text-left font-normal hover:border-white/10 hover:bg-white/[0.08]"
                  : "flex h-auto w-full flex-col items-start gap-0.5 whitespace-normal rounded-md px-2 py-1.5 text-left font-normal hover:bg-muted/60"
              }
            >
              <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
                {result.role === "assistant" ? "Agent" : "You"} ·{" "}
                {formatTimestamp(result.createdAt)}
              </span>
              <span className="line-clamp-2 text-sm text-foreground">
                {result.snippet}
              </span>
            </Button>
          </li>
        ))}
      </ul>
    ) : null;

  if (keyboardAnchored) {
    // Bottom-anchored: results scroll in the region ABOVE the input, the input
    // (+ its status line) is pinned to the bottom right above the keyboard.
    // `min-h-0` on the scroll region lets it actually shrink+scroll under a
    // raised keyboard instead of pushing the input off-screen; the container
    // (in the overlay) is a bottom-anchored flex column bounded by panelMaxH.
    return (
      <div
        data-testid="message-search-panel"
        data-layout="keyboard-anchored"
        role="dialog"
        aria-label="Search messages"
        onKeyDown={onKeyDown}
        className="flex min-h-0 flex-1 flex-col gap-2"
      >
        <div
          data-testid="message-search-scroll"
          className="scroll-fade flex min-h-0 flex-1 flex-col justify-end gap-1 overflow-y-auto overscroll-contain [scrollbar-width:none] [-webkit-overflow-scrolling:touch] [&::-webkit-scrollbar]:hidden"
        >
          {resultsListEl}
        </div>
        <div className="flex shrink-0 flex-col gap-1">
          {statusEl}
          {inputEl}
        </div>
      </div>
    );
  }

  return (
    <div
      data-testid="message-search-panel"
      data-layout="stacked"
      role="dialog"
      aria-label="Search messages"
      onKeyDown={onKeyDown}
      className="flex flex-col gap-2"
    >
      {inputEl}
      {statusEl}
      {resultsListEl}
    </div>
  );
}

function formatTimestamp(createdAt: number): string {
  if (!createdAt) return "";
  try {
    return new Date(createdAt).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
  } catch {
    // error-policy:J3 invalid stored timestamp — a date label is decoration;
    // omit it rather than render "Invalid Date"
    return "";
  }
}
