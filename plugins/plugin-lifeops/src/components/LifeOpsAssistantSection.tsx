import {
  HEALTH_ASSISTANT_COMMANDS,
  type HealthAssistantIconKey,
} from "@elizaos/plugin-health/ui/index";
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
  Moon,
  Plane,
  RefreshCw,
  Shield,
  Sparkles,
  Timer,
  Users,
  Zap,
} from "lucide-react";
import type { ReactNode } from "react";
import { useLifeOpsChatLauncher } from "./LifeOpsChatAdapter.js";

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

function healthIcon(iconKey: HealthAssistantIconKey): ReactNode {
  switch (iconKey) {
    case "activity":
      return <Activity className="h-4 w-4" aria-hidden />;
    case "heart":
      return <Heart className="h-4 w-4" aria-hidden />;
    case "moon":
      return <Moon className="h-4 w-4" aria-hidden />;
    case "timer":
      return <Timer className="h-4 w-4" aria-hidden />;
    case "monitor":
      return <Monitor className="h-4 w-4" aria-hidden />;
    case "shield":
      return <Shield className="h-4 w-4" aria-hidden />;
  }
}

export const HEALTH_ASSISTANT_INTENTS: AssistantIntent[] =
  HEALTH_ASSISTANT_COMMANDS.map((command) => ({
    id: `health:${command.id}`,
    label: command.label,
    shortLabel: command.shortLabel,
    icon: healthIcon(command.iconKey),
    tone: command.tone,
    prompt: command.prompt,
  }));

export const LIFEOPS_ASSISTANT_INTENTS: AssistantIntent[] = [
  ...ASSISTANT_INTENTS,
  ...HEALTH_ASSISTANT_INTENTS,
];

export const LIFEOPS_VOICE_COMMAND_PROMPT =
  "Voice command for LifeOps: ";

export function LifeOpsAssistantIntentGrid({
  intents = LIFEOPS_ASSISTANT_INTENTS,
  onLaunch,
}: {
  intents?: AssistantIntent[];
  onLaunch: (intent: AssistantIntent) => void;
}) {
  return (
    <div
      className="grid grid-cols-3 gap-2 sm:grid-cols-5 xl:grid-cols-6"
      data-testid="lifeops-assistant-intents"
    >
      {intents.map((intent) => (
        <button
          key={intent.id}
          type="button"
          aria-label={intent.label}
          data-testid="lifeops-assistant-intent"
          data-intent-id={intent.id}
          className="group flex aspect-[1.15] min-h-[5.25rem] min-w-0 flex-col items-center justify-center gap-2 rounded-lg border border-border/35 bg-bg/70 px-2 text-center transition-colors hover:bg-bg-muted/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
          onClick={() => onLaunch(intent)}
        >
          <span className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-bg-muted/60 text-txt">
            <span
              aria-hidden
              className={`absolute right-1 top-1 h-1.5 w-1.5 rounded-full ${intent.tone}`}
            />
            {intent.icon}
          </span>
          <span className="max-w-full truncate text-xs-tight font-semibold text-txt">
            {intent.shortLabel}
          </span>
        </button>
      ))}
    </div>
  );
}

export function LifeOpsAssistantSection() {
  const { openLifeOpsChat } = useLifeOpsChatLauncher();
  const commandBriefPrompt =
    ASSISTANT_INTENTS[0]?.prompt ?? "Give me a LifeOps command brief.";

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
            type="button"
            aria-label="Open LifeOps command brief"
            data-testid="lifeops-assistant-command-brief"
            className="group grid min-h-[5rem] w-full grid-cols-[auto_1fr_auto] items-center gap-3 rounded-lg border border-border/35 bg-bg-muted/35 p-3 text-left transition-colors hover:bg-bg-muted/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
            onClick={() =>
              openLifeOpsChat(commandBriefPrompt, {}, { select: true })
            }
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
            type="button"
            aria-label="Open LifeOps voice command"
            data-testid="lifeops-assistant-voice-command"
            className="group flex min-h-[5rem] items-center justify-center gap-2 rounded-lg border border-border/35 bg-bg-muted/35 px-4 text-txt transition-colors hover:bg-bg-muted/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70 sm:w-24 sm:flex-col"
            onClick={() =>
              openLifeOpsChat(LIFEOPS_VOICE_COMMAND_PROMPT, {}, { select: false })
            }
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
          <button
            key={`quick-${intent.id}`}
            type="button"
            aria-label={`Quick ${intent.label}`}
            className="flex h-10 items-center justify-center rounded-lg bg-bg-muted/35 text-txt transition-colors hover:bg-bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
            onClick={() => openLifeOpsChat(intent.prompt, {}, { select: true })}
          >
            {intent.icon}
          </button>
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
