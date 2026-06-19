import * as React from "react";

import { useApp } from "../../../state";
import { useRegisterViewChatBinding } from "../../../state/view-chat-binding";
import { startTutorial } from "../tutorial/tutorial-controller";
import {
  HELP_ENTRIES,
  type HelpDeepLink,
  type HelpEntry,
} from "./help-content";

/**
 * Help — a knowledge base searched through the floating chat. There's no search
 * box of its own: while Help is open it takes over the chat composer (placeholder
 * "Ask a question about Eliza…") and receives the live draft, pulling up the best
 * matching answer here as you type. You can also browse the common questions and
 * deep-link straight to the relevant screen.
 */

const BRAND = "#FF5800";

function scoreEntry(entry: HelpEntry, q: string): number {
  if (!q) return 1;
  const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hay =
    `${entry.question} ${entry.answer} ${entry.keywords.join(" ")}`.toLowerCase();
  let score = 0;
  for (const t of tokens) {
    if (entry.question.toLowerCase().includes(t)) score += 3;
    else if (entry.keywords.some((k) => k.includes(t))) score += 2;
    else if (hay.includes(t)) score += 1;
    else return 0; // every token must match somewhere
  }
  return score;
}

export function HelpView(): React.ReactElement {
  const { setTab } = useApp();
  const [query, setQuery] = React.useState("");
  const [openId, setOpenId] = React.useState<string | null>(null);

  // The chat IS the search box for Help. Stable binding (setQuery is stable).
  const binding = React.useMemo(
    () => ({ placeholder: "Ask a question about Eliza…", onQuery: setQuery }),
    [],
  );
  useRegisterViewChatBinding(binding);

  const results = React.useMemo(
    () =>
      HELP_ENTRIES.map((e) => ({ e, score: scoreEntry(e, query) }))
        .filter(({ score }) => score > 0)
        .sort((a, b) => b.score - a.score)
        .map(({ e }) => e),
    [query],
  );

  // As the user types a question in the chat, pull up the best match — but don't
  // fight a manual close (only re-open when the top match actually changes).
  const lastTopRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    const top = query.trim() && results.length > 0 ? results[0].id : null;
    if (top && top !== lastTopRef.current) {
      lastTopRef.current = top;
      setOpenId(top);
    } else if (!query.trim()) {
      lastTopRef.current = null;
    }
  }, [query, results]);

  const navigate = React.useCallback(
    (link: HelpDeepLink) => {
      if (link.startTutorial) {
        startTutorial();
        setTab("chat");
        return;
      }
      if (link.settingsSection) {
        try {
          window.location.hash = link.settingsSection;
        } catch {
          /* ignore */
        }
        setTab("settings");
        return;
      }
      if (link.tab) setTab(link.tab);
    },
    [setTab],
  );

  const searching = query.trim().length > 0;

  return (
    <div
      className="flex h-full w-full flex-col overflow-hidden"
      data-testid="help-view"
    >
      <div className="px-5 pt-5">
        <h1 className="text-xl font-semibold text-txt-strong">Help</h1>
        <p className="mt-1 text-[13px] leading-relaxed text-txt/60">
          {searching ? (
            <>
              Showing answers for{" "}
              <span className="font-medium text-txt-strong">“{query}”</span>
            </>
          ) : (
            <>
              Type your question in the chat below — the answer appears right
              here. Or tap a common question to expand it.
            </>
          )}
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-8 pt-3">
        {results.length === 0 ? (
          <p className="mt-6 text-center text-[13px] text-txt/50">
            No answer matched that yet. Try simpler words — or just send your
            question in the chat and Eliza will help directly.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {results.map((entry) => {
              const open = openId === entry.id;
              return (
                <li
                  key={entry.id}
                  className="overflow-hidden rounded-xl border border-white/10 bg-white/[0.03]"
                  data-testid={`help-entry-${entry.id}`}
                >
                  <button
                    type="button"
                    onClick={() => setOpenId(open ? null : entry.id)}
                    aria-expanded={open}
                    className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-white/[0.04]"
                  >
                    <span className="text-[14px] font-medium text-txt-strong">
                      {entry.question}
                    </span>
                    <span
                      className="shrink-0 text-txt/40 transition-transform"
                      style={{ transform: open ? "rotate(90deg)" : "none" }}
                      aria-hidden
                    >
                      ›
                    </span>
                  </button>
                  {open && (
                    <div className="px-4 pb-4">
                      <p className="text-[13px] leading-relaxed text-txt/75">
                        {entry.answer}
                      </p>
                      {entry.deepLink && (
                        <button
                          type="button"
                          onClick={() =>
                            navigate(entry.deepLink as HelpDeepLink)
                          }
                          className="mt-3 inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-[13px] font-semibold text-white transition-colors"
                          style={{ backgroundColor: BRAND }}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.backgroundColor = "#D44A00";
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.backgroundColor = BRAND;
                          }}
                        >
                          {entry.deepLink.label} →
                        </button>
                      )}
                      <div className="mt-2 text-[11px] uppercase tracking-wide text-txt/35">
                        {entry.category}
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
