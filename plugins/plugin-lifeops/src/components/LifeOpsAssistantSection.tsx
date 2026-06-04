import { useAgentElement } from "@elizaos/ui/agent-surface";
import {
  Activity,
  BriefcaseBusiness,
  CalendarCheck,
  ClipboardCheck,
  Clock3,
  CreditCard,
  FileSignature,
  Heart,
  Home,
  Inbox,
  Landmark,
  ListChecks,
  MessageSquareText,
  Mic2,
  Monitor,
  Plane,
  RefreshCw,
  Shield,
  Sparkles,
  Timer,
  Users,
  Zap,
} from "lucide-react";
import type { ReactNode } from "react";
import { useLifeOpsChatLauncher } from "./LifeOpsChatAdapter.helpers.js";

export interface AssistantIntent {
  id: string;
  label: string;
  shortLabel: string;
  icon: ReactNode;
  tone: string;
  prompt: string;
}

export const ASSISTANT_INTENTS: AssistantIntent[] = [
  {
    id: "command-brief",
    label: "Command brief",
    shortLabel: "Brief",
    icon: <Sparkles className="h-4 w-4" aria-hidden />,
    tone: "bg-amber-400",
    prompt:
      "Give me a LifeOps command brief. Check calendar, inbox, reminders, pending prompts, documents, travel, money admin, and relationship follow-ups. Show the smallest useful set of decisions.",
  },
  {
    id: "inbox-decisions",
    label: "Inbox decisions",
    shortLabel: "Inbox",
    icon: <Inbox className="h-4 w-4" aria-hidden />,
    tone: "bg-rose-400",
    prompt:
      "Find messages that need my decision. Group them by action, draft replies where useful, and ask me for one batch of approvals.",
  },
  {
    id: "calendar-conflicts",
    label: "Calendar conflicts",
    shortLabel: "Calendar",
    icon: <CalendarCheck className="h-4 w-4" aria-hidden />,
    tone: "bg-cyan-400",
    prompt:
      "Audit my calendar for conflicts, missing prep, no-agenda meetings, travel buffers, and events that need a reply. Turn issues into LifeOps tasks.",
  },
  {
    id: "meeting-prep",
    label: "Meeting prep",
    shortLabel: "Prep",
    icon: <ClipboardCheck className="h-4 w-4" aria-hidden />,
    tone: "bg-violet-400",
    prompt:
      "Prepare me for the next working block. Pull the related people, docs, threads, open questions, likely decisions, and follow-ups.",
  },
  {
    id: "waiting-on",
    label: "Waiting-on",
    shortLabel: "Waiting",
    icon: <Clock3 className="h-4 w-4" aria-hidden />,
    tone: "bg-orange-400",
    prompt:
      "Find what I am waiting on across delegated tasks, sent questions, docs, approvals, and open loops. Create follow-ups without duplicating active tasks.",
  },
  {
    id: "delegate",
    label: "Delegate",
    shortLabel: "Delegate",
    icon: <BriefcaseBusiness className="h-4 w-4" aria-hidden />,
    tone: "bg-lime-400",
    prompt:
      "Help me delegate active work. Identify tasks someone else can own, draft assignments, and create follow-up tasks with owners and review dates.",
  },
  {
    id: "decision-log",
    label: "Decision log",
    shortLabel: "Decisions",
    icon: <ListChecks className="h-4 w-4" aria-hidden />,
    tone: "bg-emerald-400",
    prompt:
      "Extract recent decisions from chats, approvals, meetings, and docs. Save decision records and ask me only about ambiguous items.",
  },
  {
    id: "approval-batch",
    label: "Approval batch",
    shortLabel: "Approve",
    icon: <ClipboardCheck className="h-4 w-4" aria-hidden />,
    tone: "bg-amber-300",
    prompt:
      "Batch pending approvals into safe actions. Separate reversible drafts from irreversible actions, show risk, and ask for the smallest approval set.",
  },
  {
    id: "privacy-redaction",
    label: "Privacy redaction",
    shortLabel: "Privacy",
    icon: <Shield className="h-4 w-4" aria-hidden />,
    tone: "bg-slate-300",
    prompt:
      "Prepare a privacy-safe summary. Redact credentials, financial account data, addresses, and sensitive personal context before sharing.",
  },
  {
    id: "interruption-firebreak",
    label: "Interruption firebreak",
    shortLabel: "Focus",
    icon: <Timer className="h-4 w-4" aria-hidden />,
    tone: "bg-red-400",
    prompt:
      "Protect my focus block. Triage incoming items, decide what can wait, draft holds, and escalate only items that truly need interruption.",
  },
  {
    id: "status-compression",
    label: "Status compression",
    shortLabel: "Status",
    icon: <Activity className="h-4 w-4" aria-hidden />,
    tone: "bg-cyan-300",
    prompt:
      "Compress status across active projects into a terse update: green, yellow, red, owner, next move, blocker, and decision needed.",
  },
  {
    id: "vip-escalation",
    label: "VIP escalation",
    shortLabel: "VIP",
    icon: <Heart className="h-4 w-4" aria-hidden />,
    tone: "bg-pink-400",
    prompt:
      "Handle a VIP escalation. Choose the right channel and urgency, explain why, avoid over-escalation, and draft the response or interruption note.",
  },
  {
    id: "weekly-operating-review",
    label: "Weekly operating review",
    shortLabel: "Review",
    icon: <ListChecks className="h-4 w-4" aria-hidden />,
    tone: "bg-indigo-400",
    prompt:
      "Run my weekly operating review: commitments made, commitments owed to me, schedule pressure, money admin deadlines, travel risk, and decisions.",
  },
  {
    id: "board-pack-prep",
    label: "Board pack prep",
    shortLabel: "Board",
    icon: <FileSignature className="h-4 w-4" aria-hidden />,
    tone: "bg-violet-300",
    prompt:
      "Prepare the board pack brief: gather docs, open approvals, missing metrics, calendar deadlines, and unresolved risks. Show only gaps and decisions.",
  },
  {
    id: "chief-of-staff-handoff",
    label: "Chief-of-staff handoff",
    shortLabel: "Handoff",
    icon: <BriefcaseBusiness className="h-4 w-4" aria-hidden />,
    tone: "bg-stone-300",
    prompt:
      "Build a chief-of-staff handoff: weekly priorities, delegated owners, blocked decisions, relationship follow-ups, and status risks.",
  },
  {
    id: "event-planning",
    label: "Event planning",
    shortLabel: "Event",
    icon: <CalendarCheck className="h-4 w-4" aria-hidden />,
    tone: "bg-cyan-300",
    prompt:
      "Coordinate event planning: calendar holds, invite list, venue confirmation, menu or prep docs, travel buffers, and delegated follow-ups.",
  },
  {
    id: "finance-dispute",
    label: "Finance dispute",
    shortLabel: "Dispute",
    icon: <Landmark className="h-4 w-4" aria-hidden />,
    tone: "bg-emerald-400",
    prompt:
      "Handle a finance dispute: collect receipts, payment records, related messages, approval owner, and draft the next safe action.",
  },
  {
    id: "gift-milestone",
    label: "Gift milestone",
    shortLabel: "Gift",
    icon: <Heart className="h-4 w-4" aria-hidden />,
    tone: "bg-pink-300",
    prompt:
      "Prepare a relationship milestone gift: date, preferences from prior messages, budget, delivery deadline, and approval before purchase.",
  },
  {
    id: "hiring-loop",
    label: "Hiring loop",
    shortLabel: "Hiring",
    icon: <Users className="h-4 w-4" aria-hidden />,
    tone: "bg-blue-300",
    prompt:
      "Coordinate the hiring loop: interview calendar, candidate docs, panel owner reminders, scorecard deadline, and follow-up messages.",
  },
  {
    id: "intro-routing",
    label: "Intro routing",
    shortLabel: "Intros",
    icon: <MessageSquareText className="h-4 w-4" aria-hidden />,
    tone: "bg-rose-300",
    prompt:
      "Triage inbound intro requests: decide accept, delegate, decline, or schedule; use relationship context and draft replies for approval.",
  },
  {
    id: "legal-deadline",
    label: "Legal deadline",
    shortLabel: "Legal",
    icon: <Shield className="h-4 w-4" aria-hidden />,
    tone: "bg-slate-400",
    prompt:
      "Track the legal document deadline: signature docs, counsel messages, calendar cutoff, missing approvals, and safe follow-up drafts.",
  },
  {
    id: "travel-disruption",
    label: "Travel disruption",
    shortLabel: "Delay",
    icon: <Plane className="h-4 w-4" aria-hidden />,
    tone: "bg-sky-300",
    prompt:
      "Recover from a travel disruption: rework itinerary, calendar conflicts, hotel and ground transport, people notifications, receipts, and approval decisions.",
  },
  {
    id: "vendor-negotiation",
    label: "Vendor negotiation",
    shortLabel: "Vendor",
    icon: <CreditCard className="h-4 w-4" aria-hidden />,
    tone: "bg-green-300",
    prompt:
      "Prepare vendor renewal negotiation: contract docs, current spend, cancellation deadline, prior messages, approval owner, and a concise reply draft.",
  },
  {
    id: "delegation-map",
    label: "Delegation map",
    shortLabel: "Owners",
    icon: <Users className="h-4 w-4" aria-hidden />,
    tone: "bg-lime-300",
    prompt:
      "Map delegated work by owner, deadline, dependency, next check-in, and risk. Find unclear ownership and propose follow-ups.",
  },
  {
    id: "remote-agent-stuck",
    label: "Remote agent stuck",
    shortLabel: "Unstick",
    icon: <Monitor className="h-4 w-4" aria-hidden />,
    tone: "bg-blue-300",
    prompt:
      "Unstick a remote agent or assistant task. Review the last known state, missing input, failed handoff, and the next safe recovery action.",
  },
  {
    id: "family-logistics",
    label: "Family logistics",
    shortLabel: "Family",
    icon: <Home className="h-4 w-4" aria-hidden />,
    tone: "bg-yellow-300",
    prompt:
      "Coordinate family logistics: schedules, pickups, appointments, errands, shared promises, and reminders. Ask only for decisions I must make.",
  },
  {
    id: "outage-recovery",
    label: "Outage recovery",
    shortLabel: "Recover",
    icon: <RefreshCw className="h-4 w-4" aria-hidden />,
    tone: "bg-orange-300",
    prompt:
      "Recover from a service or workflow outage. Identify impacted commitments, missed messages, failed automations, and the repair order.",
  },
  {
    id: "travel",
    label: "Travel readiness",
    shortLabel: "Travel",
    icon: <Plane className="h-4 w-4" aria-hidden />,
    tone: "bg-sky-400",
    prompt:
      "Check upcoming travel readiness: bookings, confirmations, calendar buffers, transfer gaps, lodging, docs, reminders, and expense capture.",
  },
  {
    id: "expenses",
    label: "Expenses",
    shortLabel: "Expenses",
    icon: <CreditCard className="h-4 w-4" aria-hidden />,
    tone: "bg-green-400",
    prompt:
      "Collect likely reimbursable expenses from receipts, payments, calendar travel, and inbox confirmations. Ask for only missing classifications.",
  },
  {
    id: "renewals",
    label: "Renewals",
    shortLabel: "Renewals",
    icon: <RefreshCw className="h-4 w-4" aria-hidden />,
    tone: "bg-fuchsia-400",
    prompt:
      "Review subscriptions, trials, warranties, insurance dates, recurring charges, and renewals. Surface near-term keep or cancel decisions.",
  },
  {
    id: "people",
    label: "People cadence",
    shortLabel: "People",
    icon: <Users className="h-4 w-4" aria-hidden />,
    tone: "bg-teal-400",
    prompt:
      "Prepare relationship touchpoints from overdue cadence, milestones, promises, shared threads, and open asks. Keep suggestions brief.",
  },
  {
    id: "documents",
    label: "Documents",
    shortLabel: "Docs",
    icon: <FileSignature className="h-4 w-4" aria-hidden />,
    tone: "bg-purple-400",
    prompt:
      "Scan documents and attachments for signature, review, redline, notarization, upload, or approval work. Create tasks for explicit approvals.",
  },
  {
    id: "home-ops",
    label: "Home ops",
    shortLabel: "Home",
    icon: <Home className="h-4 w-4" aria-hidden />,
    tone: "bg-yellow-400",
    prompt:
      "Review personal operations: deliveries, maintenance, errands, appointments, reservations, gifts, support tickets, and household admin.",
  },
  {
    id: "money-admin",
    label: "Money admin",
    shortLabel: "Money",
    icon: <Landmark className="h-4 w-4" aria-hidden />,
    tone: "bg-emerald-300",
    prompt:
      "Review money admin: upcoming bills, subscriptions, reimbursements, receipts, unusual charges, and documents needing my decision.",
  },
  {
    id: "closeout",
    label: "Closeout",
    shortLabel: "Close",
    icon: <MessageSquareText className="h-4 w-4" aria-hidden />,
    tone: "bg-zinc-300",
    prompt:
      "Run end-of-day closeout. Show unresolved decisions, tomorrow risks, waiting-on items, promises made today, and tasks worth moving.",
  },
];

export const LIFEOPS_ASSISTANT_INTENTS: AssistantIntent[] = ASSISTANT_INTENTS;

export const LIFEOPS_VOICE_COMMAND_PROMPT = "Voice command for LifeOps: ";

function AssistantIntentGridButton({
  intent,
  onLaunch,
}: {
  intent: AssistantIntent;
  onLaunch: (intent: AssistantIntent) => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `assistant-intent-${intent.id}`,
    role: "button",
    label: intent.label,
    group: "lifeops-assistant",
    description: `Run the ${intent.label} assistant command`,
  });
  return (
    <button
      ref={ref}
      type="button"
      aria-label={intent.label}
      title={intent.label}
      data-testid="lifeops-assistant-intent"
      data-intent-id={intent.id}
      className="group flex h-16 min-w-0 flex-col items-center justify-center gap-1.5 rounded-lg border border-border/35 bg-bg/70 px-1.5 text-center transition-colors hover:bg-bg-muted/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
      onClick={() => onLaunch(intent)}
      {...agentProps}
    >
      <span className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-bg-muted/60 text-txt">
        <span
          aria-hidden
          className={`absolute right-1 top-1 h-1.5 w-1.5 rounded-full ${intent.tone}`}
        />
        {intent.icon}
      </span>
      <span className="max-w-full truncate text-[0.6875rem] font-semibold leading-none text-txt">
        {intent.shortLabel}
      </span>
    </button>
  );
}

function AssistantQuickIntentButton({
  intent,
  onLaunch,
}: {
  intent: AssistantIntent;
  onLaunch: (intent: AssistantIntent) => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `assistant-quick-${intent.id}`,
    role: "button",
    label: `Quick ${intent.label}`,
    group: "lifeops-assistant",
    description: `Quick-run the ${intent.label} assistant command`,
  });
  return (
    <button
      ref={ref}
      type="button"
      aria-label={`Quick ${intent.label}`}
      className="flex h-10 items-center justify-center rounded-lg bg-bg-muted/35 text-txt transition-colors hover:bg-bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
      onClick={() => onLaunch(intent)}
      {...agentProps}
    >
      {intent.icon}
    </button>
  );
}

export function LifeOpsAssistantIntentGrid({
  intents = LIFEOPS_ASSISTANT_INTENTS,
  onLaunch,
}: {
  intents?: AssistantIntent[];
  onLaunch: (intent: AssistantIntent) => void;
}) {
  return (
    <div
      className="grid grid-cols-4 gap-2 sm:grid-cols-6 lg:grid-cols-8 xl:grid-cols-10"
      data-testid="lifeops-assistant-intents"
    >
      {intents.map((intent) => (
        <AssistantIntentGridButton
          key={intent.id}
          intent={intent}
          onLaunch={onLaunch}
        />
      ))}
    </div>
  );
}

export function LifeOpsAssistantSection() {
  const { openLifeOpsChat } = useLifeOpsChatLauncher();
  const commandBriefPrompt =
    ASSISTANT_INTENTS[0]?.prompt ?? "Give me a LifeOps command brief.";
  const commandBrief = useAgentElement<HTMLButtonElement>({
    id: "assistant-command-brief",
    role: "button",
    label: "Ask LifeOps command brief",
    group: "lifeops-assistant",
    description: "Open the LifeOps command brief in chat",
  });
  const voiceCommand = useAgentElement<HTMLButtonElement>({
    id: "assistant-voice-command",
    role: "button",
    label: "Voice command",
    group: "lifeops-assistant",
    description: "Start a LifeOps voice command",
  });

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
      <div className="flex min-h-[11rem] flex-col justify-end rounded-lg border border-border/30 bg-bg/70 p-4 sm:p-5">
        <div className="mb-4 flex items-center justify-between gap-3 text-muted">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4" aria-hidden />
            <span className="text-xs font-semibold uppercase tracking-wide">
              Assistant
            </span>
          </div>
          <div className="flex items-center gap-1.5" aria-hidden>
            <span className="h-1.5 w-1.5 rounded-full bg-amber-300" />
            <span className="h-1.5 w-1.5 rounded-full bg-cyan-300" />
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-300" />
          </div>
        </div>
        <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
          <button
            ref={commandBrief.ref}
            type="button"
            aria-label="Open LifeOps command brief"
            data-testid="lifeops-assistant-command-brief"
            className="group grid min-h-[5rem] w-full grid-cols-[auto_1fr_auto] items-center gap-3 rounded-lg border border-border/35 bg-bg-muted/35 p-3 text-left transition-colors hover:bg-bg-muted/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
            onClick={() =>
              openLifeOpsChat(commandBriefPrompt, {}, { select: true })
            }
            {...commandBrief.agentProps}
          >
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-accent/18 text-txt">
              <MessageSquareText className="h-5 w-5" aria-hidden />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-base font-semibold text-txt">
                Ask LifeOps
              </span>
              <span className="mt-1 flex items-center gap-1.5 text-xs text-muted">
                <Zap className="h-3.5 w-3.5" aria-hidden />
                <span>Command brief</span>
              </span>
            </span>
            <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-border/25 bg-bg/70 text-muted transition-colors group-hover:text-txt">
              <Sparkles className="h-4 w-4" aria-hidden />
            </span>
          </button>
          <button
            ref={voiceCommand.ref}
            type="button"
            aria-label="Open LifeOps voice command"
            data-testid="lifeops-assistant-voice-command"
            className="group flex min-h-[5rem] items-center justify-center gap-2 rounded-lg border border-border/35 bg-bg-muted/35 px-4 text-txt transition-colors hover:bg-bg-muted/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70 sm:w-24 sm:flex-col"
            onClick={() =>
              openLifeOpsChat(
                LIFEOPS_VOICE_COMMAND_PROMPT,
                {},
                { select: false },
              )
            }
            {...voiceCommand.agentProps}
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-bg/70 text-txt">
              <Mic2 className="h-5 w-5" aria-hidden />
            </span>
            <span className="text-xs-tight font-semibold text-muted group-hover:text-txt">
              Voice
            </span>
          </button>
        </div>
      </div>

      <div className="grid grid-cols-5 gap-2 rounded-lg border border-border/25 bg-bg/55 p-2">
        {ASSISTANT_INTENTS.slice(0, 5).map((intent) => (
          <AssistantQuickIntentButton
            key={`quick-${intent.id}`}
            intent={intent}
            onLaunch={(launched) =>
              openLifeOpsChat(launched.prompt, {}, { select: true })
            }
          />
        ))}
      </div>

      <LifeOpsAssistantIntentGrid
        onLaunch={(intent) => {
          openLifeOpsChat(intent.prompt, {}, { select: true });
        }}
      />
    </div>
  );
}
