import { TerminalPluginView } from "@elizaos/ui";
import * as React from "react";

type LifeOpsPanel = "brief" | "approvals" | "schedule";

const PANEL_COPY: Record<LifeOpsPanel, string> = {
  brief: "Morning brief, inbox triage, follow-ups, and owner priorities.",
  approvals: "Pending approvals, sensitive sends, signatures, and payments.",
  schedule: "Calendar conflicts, travel readiness, reminders, and routines.",
};

const WORKSPACE_CARDS = [
  {
    title: "Inbox",
    detail:
      "Triage decisions, waiting-on loops, and VIP escalations ready for review.",
  },
  {
    title: "Calendar",
    detail:
      "Conflicts, travel buffers, meeting prep, and family logistics stay visible.",
  },
  {
    title: "Approvals",
    detail:
      "Sensitive sends, signatures, payments, and document handoffs wait for confirmation.",
  },
  {
    title: "Follow-ups",
    detail:
      "Open loops, delegated work, vendor replies, and stale requests are compressed.",
  },
  {
    title: "Routines",
    detail:
      "Daily rhythm, reminders, focus protection, and health wrappers stay coordinated.",
  },
  {
    title: "Briefs",
    detail:
      "Morning, evening, weekly operating, and monthly admin reviews are grouped.",
  },
];

const OPERATING_CHECKS = [
  "Owner-visible pending prompts are grouped by urgency and channel.",
  "Calendar conflicts include the next unblock action and approval owner.",
  "Inbox triage separates safe drafts from messages that need explicit consent.",
  "Documents, signatures, renewals, and payments remain behind approval gates.",
  "Delegated work threads show stale status, missing input, and recovery steps.",
];

export function LifeOpsPageView() {
  const [activePanel, setActivePanel] = React.useState<LifeOpsPanel>("brief");
  const [draft, setDraft] = React.useState("");

  return (
    <main className="flex min-h-full flex-col gap-4 p-6">
      <section
        className="rounded-lg border border-border bg-card p-6"
        data-testid="lifeops-dynamic-view-fallback"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold text-txt">LifeOpsPageView</h1>
            <p className="mt-2 max-w-2xl text-muted text-sm">
              Personal assistant workspace for LifeOps briefs, approvals,
              schedule repair, and owner operations.
            </p>
          </div>
          <button
            className="rounded-md border border-border px-3 py-2 text-sm"
            type="button"
            onClick={() => setActivePanel("brief")}
          >
            Refresh view
          </button>
        </div>

        <div className="mt-5 flex flex-wrap gap-2">
          {(["brief", "approvals", "schedule"] as const).map((panel) => (
            <button
              key={panel}
              className="rounded-md border border-border px-3 py-2 text-sm"
              type="button"
              aria-pressed={activePanel === panel}
              onClick={() => setActivePanel(panel)}
            >
              {panel}
            </button>
          ))}
        </div>

        <p className="mt-4 text-sm text-muted">{PANEL_COPY[activePanel]}</p>

        <label className="mt-4 block text-sm">
          <span className="sr-only">LifeOps input</span>
          <input
            aria-label="LifeOps input"
            className="mt-1 w-full rounded-md border border-border bg-bg px-3 py-2 text-sm"
            placeholder="Capture a LifeOps request"
            value={draft}
            onChange={(event) => setDraft(event.currentTarget.value)}
          />
        </label>

        <div className="mt-4 grid gap-3 text-sm md:grid-cols-3">
          {WORKSPACE_CARDS.map((card) => (
            <div
              key={card.title}
              className="rounded-md border border-border p-3"
            >
              <strong>{card.title}</strong>
              <p className="mt-1 text-muted">{card.detail}</p>
            </div>
          ))}
        </div>

        <section className="mt-5 rounded-md border border-border p-4">
          <h2 className="text-base font-semibold">Operating checks</h2>
          <ul className="mt-3 grid gap-2 text-muted text-sm">
            {OPERATING_CHECKS.map((check) => (
              <li key={check} className="flex gap-2">
                <span aria-hidden="true">-</span>
                <span>{check}</span>
              </li>
            ))}
          </ul>
        </section>
      </section>
    </main>
  );
}

export function LifeOpsTuiView() {
  return (
    <TerminalPluginView
      id="lifeops"
      label="LifeOps TUI"
      description="Terminal personal assistant workspace for briefs, approvals, schedule repair, and owner operations"
      commands={["terminal-lifeops-state", "terminal-lifeops-enable"]}
      endpoints={[
        "/api/lifeops/overview",
        "/api/lifeops/inbox",
        "/api/lifeops/calendar/feed",
      ]}
    />
  );
}
