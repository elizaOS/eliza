// Assistant-intent catalog for the LifeOps assistant section. Kept out of
// LifeOpsAssistantSection.tsx so that file exports only React components and
// stays Fast-Refresh-compatible in dev. Icons are built with `createElement`
// (rather than JSX) so this module can be a plain `.ts` sibling.

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
  type LucideIcon,
  MessageSquareText,
  Monitor,
  Plane,
  RefreshCw,
  Shield,
  Sparkles,
  Timer,
  Users,
} from "lucide-react";
import { createElement, type ReactNode } from "react";

export interface AssistantIntent {
  id: string;
  label: string;
  shortLabel: string;
  icon: ReactNode;
  tone: string;
  prompt: string;
}

const icon = (Icon: LucideIcon): ReactNode =>
  createElement(Icon, { className: "h-4 w-4", "aria-hidden": true });

export const ASSISTANT_INTENTS: AssistantIntent[] = [
  {
    id: "command-brief",
    label: "Command brief",
    shortLabel: "Brief",
    icon: icon(Sparkles),
    tone: "bg-amber-400",
    prompt:
      "Give me a LifeOps command brief. Check calendar, inbox, reminders, pending prompts, documents, travel, money admin, and relationship follow-ups. Show the smallest useful set of decisions.",
  },
  {
    id: "inbox-decisions",
    label: "Inbox decisions",
    shortLabel: "Inbox",
    icon: icon(Inbox),
    tone: "bg-rose-400",
    prompt:
      "Find messages that need my decision. Group them by action, draft replies where useful, and ask me for one batch of approvals.",
  },
  {
    id: "calendar-conflicts",
    label: "Calendar conflicts",
    shortLabel: "Calendar",
    icon: icon(CalendarCheck),
    tone: "bg-cyan-400",
    prompt:
      "Audit my calendar for conflicts, missing prep, no-agenda meetings, travel buffers, and events that need a reply. Turn issues into LifeOps tasks.",
  },
  {
    id: "meeting-prep",
    label: "Meeting prep",
    shortLabel: "Prep",
    icon: icon(ClipboardCheck),
    tone: "bg-violet-400",
    prompt:
      "Prepare me for the next working block. Pull the related people, docs, threads, open questions, likely decisions, and follow-ups.",
  },
  {
    id: "waiting-on",
    label: "Waiting-on",
    shortLabel: "Waiting",
    icon: icon(Clock3),
    tone: "bg-orange-400",
    prompt:
      "Find what I am waiting on across delegated tasks, sent questions, docs, approvals, and open loops. Create follow-ups without duplicating active tasks.",
  },
  {
    id: "delegate",
    label: "Delegate",
    shortLabel: "Delegate",
    icon: icon(BriefcaseBusiness),
    tone: "bg-lime-400",
    prompt:
      "Help me delegate active work. Identify tasks someone else can own, draft assignments, and create follow-up tasks with owners and review dates.",
  },
  {
    id: "decision-log",
    label: "Decision log",
    shortLabel: "Decisions",
    icon: icon(ListChecks),
    tone: "bg-emerald-400",
    prompt:
      "Extract recent decisions from chats, approvals, meetings, and docs. Save decision records and ask me only about ambiguous items.",
  },
  {
    id: "approval-batch",
    label: "Approval batch",
    shortLabel: "Approve",
    icon: icon(ClipboardCheck),
    tone: "bg-amber-300",
    prompt:
      "Batch pending approvals into safe actions. Separate reversible drafts from irreversible actions, show risk, and ask for the smallest approval set.",
  },
  {
    id: "privacy-redaction",
    label: "Privacy redaction",
    shortLabel: "Privacy",
    icon: icon(Shield),
    tone: "bg-slate-300",
    prompt:
      "Prepare a privacy-safe summary. Redact credentials, financial account data, addresses, and sensitive personal context before sharing.",
  },
  {
    id: "interruption-firebreak",
    label: "Interruption firebreak",
    shortLabel: "Focus",
    icon: icon(Timer),
    tone: "bg-red-400",
    prompt:
      "Protect my focus block. Triage incoming items, decide what can wait, draft holds, and escalate only items that truly need interruption.",
  },
  {
    id: "status-compression",
    label: "Status compression",
    shortLabel: "Status",
    icon: icon(Activity),
    tone: "bg-cyan-300",
    prompt:
      "Compress status across active projects into a terse update: green, yellow, red, owner, next move, blocker, and decision needed.",
  },
  {
    id: "vip-escalation",
    label: "VIP escalation",
    shortLabel: "VIP",
    icon: icon(Heart),
    tone: "bg-pink-400",
    prompt:
      "Handle a VIP escalation. Choose the right channel and urgency, explain why, avoid over-escalation, and draft the response or interruption note.",
  },
  {
    id: "weekly-operating-review",
    label: "Weekly operating review",
    shortLabel: "Review",
    icon: icon(ListChecks),
    tone: "bg-indigo-400",
    prompt:
      "Run my weekly operating review: commitments made, commitments owed to me, schedule pressure, money admin deadlines, travel risk, and decisions.",
  },
  {
    id: "board-pack-prep",
    label: "Board pack prep",
    shortLabel: "Board",
    icon: icon(FileSignature),
    tone: "bg-violet-300",
    prompt:
      "Prepare the board pack brief: gather docs, open approvals, missing metrics, calendar deadlines, and unresolved risks. Show only gaps and decisions.",
  },
  {
    id: "chief-of-staff-handoff",
    label: "Chief-of-staff handoff",
    shortLabel: "Handoff",
    icon: icon(BriefcaseBusiness),
    tone: "bg-stone-300",
    prompt:
      "Build a chief-of-staff handoff: weekly priorities, delegated owners, blocked decisions, relationship follow-ups, and status risks.",
  },
  {
    id: "event-planning",
    label: "Event planning",
    shortLabel: "Event",
    icon: icon(CalendarCheck),
    tone: "bg-cyan-300",
    prompt:
      "Coordinate event planning: calendar holds, invite list, venue confirmation, menu or prep docs, travel buffers, and delegated follow-ups.",
  },
  {
    id: "finance-dispute",
    label: "Finance dispute",
    shortLabel: "Dispute",
    icon: icon(Landmark),
    tone: "bg-emerald-400",
    prompt:
      "Handle a finance dispute: collect receipts, payment records, related messages, approval owner, and draft the next safe action.",
  },
  {
    id: "gift-milestone",
    label: "Gift milestone",
    shortLabel: "Gift",
    icon: icon(Heart),
    tone: "bg-pink-300",
    prompt:
      "Prepare a relationship milestone gift: date, preferences from prior messages, budget, delivery deadline, and approval before purchase.",
  },
  {
    id: "hiring-loop",
    label: "Hiring loop",
    shortLabel: "Hiring",
    icon: icon(Users),
    tone: "bg-blue-300",
    prompt:
      "Coordinate the hiring loop: interview calendar, candidate docs, panel owner reminders, scorecard deadline, and follow-up messages.",
  },
  {
    id: "intro-routing",
    label: "Intro routing",
    shortLabel: "Intros",
    icon: icon(MessageSquareText),
    tone: "bg-rose-300",
    prompt:
      "Triage inbound intro requests: decide accept, delegate, decline, or schedule; use relationship context and draft replies for approval.",
  },
  {
    id: "legal-deadline",
    label: "Legal deadline",
    shortLabel: "Legal",
    icon: icon(Shield),
    tone: "bg-slate-400",
    prompt:
      "Track the legal document deadline: signature docs, counsel messages, calendar cutoff, missing approvals, and safe follow-up drafts.",
  },
  {
    id: "travel-disruption",
    label: "Travel disruption",
    shortLabel: "Delay",
    icon: icon(Plane),
    tone: "bg-sky-300",
    prompt:
      "Recover from a travel disruption: rework itinerary, calendar conflicts, hotel and ground transport, people notifications, receipts, and approval decisions.",
  },
  {
    id: "vendor-negotiation",
    label: "Vendor negotiation",
    shortLabel: "Vendor",
    icon: icon(CreditCard),
    tone: "bg-green-300",
    prompt:
      "Prepare vendor renewal negotiation: contract docs, current spend, cancellation deadline, prior messages, approval owner, and a concise reply draft.",
  },
  {
    id: "delegation-map",
    label: "Delegation map",
    shortLabel: "Owners",
    icon: icon(Users),
    tone: "bg-lime-300",
    prompt:
      "Map delegated work by owner, deadline, dependency, next check-in, and risk. Find unclear ownership and propose follow-ups.",
  },
  {
    id: "remote-agent-stuck",
    label: "Remote agent stuck",
    shortLabel: "Unstick",
    icon: icon(Monitor),
    tone: "bg-blue-300",
    prompt:
      "Unstick a remote agent or assistant task. Review the last known state, missing input, failed handoff, and the next safe recovery action.",
  },
  {
    id: "family-logistics",
    label: "Family logistics",
    shortLabel: "Family",
    icon: icon(Home),
    tone: "bg-yellow-300",
    prompt:
      "Coordinate family logistics: schedules, pickups, appointments, errands, shared promises, and reminders. Ask only for decisions I must make.",
  },
  {
    id: "outage-recovery",
    label: "Outage recovery",
    shortLabel: "Recover",
    icon: icon(RefreshCw),
    tone: "bg-orange-300",
    prompt:
      "Recover from a service or workflow outage. Identify impacted commitments, missed messages, failed automations, and the repair order.",
  },
  {
    id: "travel",
    label: "Travel readiness",
    shortLabel: "Travel",
    icon: icon(Plane),
    tone: "bg-sky-400",
    prompt:
      "Check upcoming travel readiness: bookings, confirmations, calendar buffers, transfer gaps, lodging, docs, reminders, and expense capture.",
  },
  {
    id: "expenses",
    label: "Expenses",
    shortLabel: "Expenses",
    icon: icon(CreditCard),
    tone: "bg-green-400",
    prompt:
      "Collect likely reimbursable expenses from receipts, payments, calendar travel, and inbox confirmations. Ask for only missing classifications.",
  },
  {
    id: "renewals",
    label: "Renewals",
    shortLabel: "Renewals",
    icon: icon(RefreshCw),
    tone: "bg-fuchsia-400",
    prompt:
      "Review subscriptions, trials, warranties, insurance dates, recurring charges, and renewals. Surface near-term keep or cancel decisions.",
  },
  {
    id: "people",
    label: "People cadence",
    shortLabel: "People",
    icon: icon(Users),
    tone: "bg-teal-400",
    prompt:
      "Prepare relationship touchpoints from overdue cadence, milestones, promises, shared threads, and open asks. Keep suggestions brief.",
  },
  {
    id: "documents",
    label: "Documents",
    shortLabel: "Docs",
    icon: icon(FileSignature),
    tone: "bg-purple-400",
    prompt:
      "Scan documents and attachments for signature, review, redline, notarization, upload, or approval work. Create tasks for explicit approvals.",
  },
  {
    id: "home-ops",
    label: "Home ops",
    shortLabel: "Home",
    icon: icon(Home),
    tone: "bg-yellow-400",
    prompt:
      "Review personal operations: deliveries, maintenance, errands, appointments, reservations, gifts, support tickets, and household admin.",
  },
  {
    id: "money-admin",
    label: "Money admin",
    shortLabel: "Money",
    icon: icon(Landmark),
    tone: "bg-emerald-300",
    prompt:
      "Review money admin: upcoming bills, subscriptions, reimbursements, receipts, unusual charges, and documents needing my decision.",
  },
  {
    id: "closeout",
    label: "Closeout",
    shortLabel: "Close",
    icon: icon(MessageSquareText),
    tone: "bg-zinc-300",
    prompt:
      "Run end-of-day closeout. Show unresolved decisions, tomorrow risks, waiting-on items, promises made today, and tasks worth moving.",
  },
];

export const LIFEOPS_ASSISTANT_INTENTS: AssistantIntent[] = ASSISTANT_INTENTS;

export const LIFEOPS_VOICE_COMMAND_PROMPT = "Voice command for LifeOps: ";
