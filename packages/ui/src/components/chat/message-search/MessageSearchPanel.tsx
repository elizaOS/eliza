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
}

type Status = "idle" | "loading" | "ready" | "error";

export function MessageSearchPanel({
  search,
  onJump,
  onClose,
  initialQuery = "",
}: MessageSearchPanelProps) {
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

  return (
    <div
      data-testid="message-search-panel"
      role="dialog"
      aria-label="Search messages"
      onKeyDown={onKeyDown}
      className="flex flex-col gap-2"
    >
      <Input
        ref={inputRef}
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search messages…"
        aria-label="Search messages"
        data-testid="message-search-input"
      />

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

      {results.length > 0 ? (
        <ul
          data-testid="message-search-results"
          className="flex flex-col gap-1"
        >
          {results.map((result) => (
            <li key={result.messageId}>
              <Button
                data-testid="message-search-result"
                onClick={() => handleJump(result)}
                variant="ghost"
                className="flex h-auto w-full flex-col items-start gap-0.5 whitespace-normal rounded-md px-2 py-1.5 text-left font-normal hover:bg-muted/60"
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
      ) : null}
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
    return "";
  }
}
