import * as React from "react";

import { useApp } from "../../../state";
import { startTutorial } from "../tutorial/tutorial-controller";
import {
  HELP_CATEGORIES,
  HELP_ENTRIES,
  type HelpCategory,
  type HelpDeepLink,
  type HelpEntry,
} from "./help-content";

/**
 * Help — a searchable FAQ / knowledge base. Type a question or pick a category;
 * each answer can deep-link straight to the relevant screen (or launch the
 * interactive tutorial). Pinned to the home screen next to Tutorial.
 */

const BRAND = "#FF5800";

function scoreEntry(entry: HelpEntry, q: string): number {
  if (!q) return 1;
  const needle = q.toLowerCase();
  const tokens = needle.split(/\s+/).filter(Boolean);
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
  const [category, setCategory] = React.useState<HelpCategory | "All">("All");
  const [openId, setOpenId] = React.useState<string | null>(null);

  const results = React.useMemo(() => {
    return HELP_ENTRIES.map((e) => ({ e, score: scoreEntry(e, query) }))
      .filter(
        ({ e, score }) =>
          score > 0 && (category === "All" || e.category === category),
      )
      .sort((a, b) => b.score - a.score)
      .map(({ e }) => e);
  }, [query, category]);

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

  return (
    <div
      className="flex h-full w-full flex-col overflow-hidden"
      data-testid="help-view"
    >
      <div className="px-5 pt-5">
        <h1 className="text-xl font-semibold text-txt-strong">Help</h1>
        <p className="mt-0.5 text-[13px] text-txt/60">
          Search for anything, or browse by topic. Answers can take you straight
          there.
        </p>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Ask a question… e.g. “how do I change the model?”"
          data-testid="help-search"
          aria-label="Search help"
          className="mt-3 w-full rounded-xl border border-white/12 bg-white/5 px-4 py-2.5 text-[14px] text-txt-strong outline-none placeholder:text-txt/40 focus:border-white/25"
        />
        <div className="mt-3 flex flex-wrap gap-1.5 pb-3">
          {(["All", ...HELP_CATEGORIES] as const).map((c) => {
            const activeCat = category === c;
            return (
              <button
                key={c}
                type="button"
                onClick={() => setCategory(c)}
                className="rounded-full border px-2.5 py-1 text-[12px] transition-colors"
                style={
                  activeCat
                    ? {
                        backgroundColor: BRAND,
                        borderColor: BRAND,
                        color: "#fff",
                      }
                    : {
                        borderColor: "rgba(255,255,255,0.14)",
                        color: "rgba(255,255,255,0.7)",
                      }
                }
              >
                {c}
              </button>
            );
          })}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-8">
        {results.length === 0 ? (
          <p className="mt-6 text-center text-[13px] text-txt/50">
            No answers matched “{query}”. Try simpler words, or ask the chat
            directly — Eliza can help in the moment.
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
