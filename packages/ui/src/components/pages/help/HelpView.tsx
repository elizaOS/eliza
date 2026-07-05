/**
 * Help — a knowledge base searched through the floating chat. There's no search
 * box of its own: while Help is open it takes over the chat composer (placeholder
 * "Ask a question about Eliza…") and receives the live draft, pulling up the best
 * matching answer here as you type. You can also browse the common questions and
 * deep-link straight to the relevant screen.
 */
import { LifeBuoy } from "lucide-react";
import * as React from "react";

import { useAgentElement } from "../../../agent-surface";
import { dispatchNavigateViewEvent } from "../../../events";
import { useAppSelector } from "../../../state";
import { useRegisterViewChatBinding } from "../../../state/view-chat-binding";
import { PagePanel } from "../../composites/page-panel";
import { ViewHeader } from "../../shared/ViewHeader";
import { Button } from "../../ui/button";
import { ShellViewAgentSurface } from "../../views/ShellViewAgentSurface";
import { startTutorial } from "../tutorial/tutorial-controller";
import {
  HELP_ENTRIES,
  type HelpDeepLink,
  type HelpEntry,
} from "./help-content";

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
  return (
    <ShellViewAgentSurface viewId="help">
      <div className="flex h-full min-h-0 w-full flex-col">
        <ViewHeader title="Help" />
        <div className="min-h-0 flex-1 overflow-hidden">
          <HelpViewBody />
        </div>
      </div>
    </ShellViewAgentSurface>
  );
}

function HelpDeepLinkButton({
  entry,
  onNavigate,
}: {
  entry: HelpEntry & { deepLink: HelpDeepLink };
  onNavigate: (link: HelpDeepLink) => void;
}): React.ReactElement {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `help-link-${entry.id}`,
    role: "button",
    label: entry.deepLink.label,
    group: "help-links",
    description: `Open the destination for help entry: ${entry.question}`,
    onActivate: () => onNavigate(entry.deepLink),
  });

  return (
    <Button
      ref={ref}
      {...agentProps}
      variant="default"
      size="sm"
      onClick={() => onNavigate(entry.deepLink)}
      className="mt-3 gap-1"
    >
      {entry.deepLink.label} →
    </Button>
  );
}

function HelpEntryItem({
  entry,
  open,
  onToggle,
  onNavigate,
}: {
  entry: HelpEntry;
  open: boolean;
  onToggle: () => void;
  onNavigate: (link: HelpDeepLink) => void;
}): React.ReactElement {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `help-entry-${entry.id}`,
    role: "button",
    label: entry.question,
    group: "help-entries",
    status: open ? "expanded" : "collapsed",
    description: `Expand or collapse the help answer for: ${entry.question}`,
    onActivate: onToggle,
  });

  return (
    <li data-testid={`help-entry-${entry.id}`}>
      <Button
        ref={ref}
        {...agentProps}
        onClick={onToggle}
        aria-expanded={open}
        variant="ghost"
        className="flex h-auto w-full items-center justify-between gap-3 whitespace-normal rounded-lg px-4 py-3 text-left font-normal transition-colors hover:bg-txt/[0.04]"
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
      </Button>
      {open && (
        <div className="px-4 pb-4">
          <p className="text-[13px] leading-relaxed text-txt/75">
            {entry.answer}
          </p>
          {entry.deepLink ? (
            <HelpDeepLinkButton
              entry={entry as HelpEntry & { deepLink: HelpDeepLink }}
              onNavigate={onNavigate}
            />
          ) : null}
        </div>
      )}
    </li>
  );
}

function HelpViewBody(): React.ReactElement {
  const setTab = useAppSelector((s) => s.setTab);
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
        // Deep-link the target section through the `eliza:navigate:view`
        // `subview` channel — the same path the agent + slash-command flows use
        // (App.tsx routes it into SettingsView's `initialSection`). Setting
        // `window.location.hash` before `setTab` never survived: setTab pushes
        // the bare `/settings` path, which clears the fragment BEFORE
        // SettingsView mounts and reads it — so the user landed on the generic
        // Settings hub instead of the promised section.
        if (typeof window !== "undefined") {
          dispatchNavigateViewEvent({
            viewId: "settings",
            viewPath: "/settings",
            subview: link.settingsSection,
          });
        }
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
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 pb-8 pt-3">
        {results.length === 0 ? (
          <PagePanel.Empty
            className="flex-1"
            icon={<LifeBuoy className="h-6 w-6" aria-hidden />}
            title="No matches."
          />
        ) : (
          <ul className="flex flex-col gap-2">
            {results.map((entry) => {
              const open = openId === entry.id;
              return (
                <HelpEntryItem
                  key={entry.id}
                  entry={entry}
                  open={open}
                  onToggle={() => setOpenId(open ? null : entry.id)}
                  onNavigate={navigate}
                />
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
