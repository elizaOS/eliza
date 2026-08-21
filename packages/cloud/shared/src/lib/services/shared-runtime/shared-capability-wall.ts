/** Keeps Shared honest and returns a resumable setup handoff for unavailable work. */

import type { CapabilityHandoffRequest } from "@elizaos/shared";

export type SharedDedicatedCapability =
  | "calendar"
  | "reminders"
  | "todos"
  | "bookings"
  | "communications"
  | "purchases"
  | "notes"
  | "cloud-apps"
  | "coding-runtime"
  | "shell"
  | "filesystem"
  | "browser-control";

export interface SharedCapabilityWall {
  capability: SharedDedicatedCapability;
  label: string;
  /**
   * Factual runtime constraint supplied to the model and action receipt. This
   * is deliberately not end-user copy: the model must express it naturally in
   * the agent's voice and in the context of the actual request.
   */
  constraint: string;
}

export type SharedCapabilityResolution =
  | { kind: "blocked-primary"; blocked: SharedCapabilityWall }
  | {
      kind: "enabled-primary";
      primary: SharedCapabilityWall;
      blockedSecondary: SharedCapabilityWall[];
    };

const NON_EXECUTION_CONTEXT =
  /^(?:please\s+)?(?:(?:can|could|would)\s+you\s+)?(?:do\s+not|don't|dont|never|explain|describe|define|translate|teach\s+me|tell\s+me\s+how|show\s+me\s+how|how\s+(?:do|would|can|to)|what\s+(?:is|are|would|happens?)|why\s+(?:do|would|can|is|are)|if\s+(?:i|we|you)|before\s+you)\b/i;

const RULES: ReadonlyArray<SharedCapabilityWall & { pattern: RegExp }> = [
  {
    capability: "reminders",
    label: "Reminders",
    pattern:
      /\b(?:remind\s+me|(?:set|create|add|schedule|cancel|delete|change|list|show)\b[\s\S]{0,36}\breminders?)\b/i,
    constraint:
      "This transport has no trusted reminder delivery, so it cannot create, change, list, or deliver reminders.",
  },
  {
    capability: "todos",
    label: "Todos",
    pattern:
      /\b(?:add|create|make|write|show|list|get|update|edit|complete|finish|cancel|delete|remove|clear)\b[\s\S]{0,48}\b(?:to[ -]?dos?|task\s+list|checklist|my\s+tasks?)\b/i,
    constraint:
      "This chat path has no persistent todo storage, so it cannot read or change a checklist.",
  },
  {
    capability: "calendar",
    label: "Calendar",
    pattern:
      /\b(?:(?:add|create|book|schedule|cancel|delete|move|reschedule)\b[\s\S]{0,36}\b(?:calendar|events?|appointments?|meetings?)|(?:check|show|list|open)\b\s+(?:me\s+)?(?:(?:my|our|the|upcoming|next|today(?:'s)?|tomorrow(?:'s)?)\s+){0,2}(?:calendar|events?|appointments?|meetings?)|(?:check|show)\b\s+(?:me\s+)?(?:if|whether)\s+(?:(?:i|we)\s+have|there\s+(?:is|are))\s+(?:(?:any|some|an?)\s+)?(?:events?|appointments?|meetings?))\b/i,
    constraint:
      "No calendar account or calendar action is available in this runtime, so it cannot read or change calendar data.",
  },
  {
    capability: "bookings",
    label: "Bookings",
    pattern:
      /\b(?:(?:can|could|would|will)\s+you\s+)?(?:(?:book|reserve)\s+(?:it|that|this)|(?:book|reserve)\b[\s\S]{0,48}\b(?:flights?|tables?|restaurants?|reservations?|hotels?|rooms?|tickets?|dinner|lunch|appointments?)|make\b[\s\S]{0,36}\b(?:reservations?|bookings?))\b/i,
    constraint:
      "No booking action is available in this runtime, so it cannot make or change a reservation.",
  },
  {
    capability: "communications",
    label: "Calls and messages",
    pattern:
      /(?:(?<=^|[.!?;,]\s*|\b(?:and\s+)?then\s+|\band\s+|\bto\s+|\bplease\s+|\b(?:can|could|would|will)\s+you\s+)(?:email|call|text|message|dm)\s+(?!(?:this|the|a|an)\s+(?:\w+\s+){0,2}(?:function|method|api|endpoint|class|variable|command)\b)|\bsend\b[\s\S]{0,32}\b(?:email|text|message|dm)\b)/i,
    constraint:
      "This session can reply in its current connected channel but cannot initiate a separate call, email, text, or DM to another person.",
  },
  {
    capability: "purchases",
    label: "Purchases",
    pattern:
      /\b(?:(?:can|could|would|will)\s+you\s+)?(?:order|buy|purchase)\b[\s\S]{0,48}\b(?:food|groceries|meal|dinner|lunch|breakfast|item|product|gift|flowers|bottle|coffee|pizza|tickets?)\b/i,
    constraint:
      "No purchasing action is available in this runtime, so it cannot place an order or buy anything.",
  },
  {
    capability: "notes",
    label: "Notes",
    pattern:
      /\b(?:create|save|add|store|write|read|show|list|open|delete|remove|update|edit)\b[\s\S]{0,28}\bnotes?\b/i,
    constraint:
      "This runtime has no separate persistent notes store, so it cannot read or change notes.",
  },
  {
    capability: "cloud-apps",
    label: "Cloud apps",
    pattern:
      /\b(?:connect|open|read|send|search|manage|update|upload|download)\b[\s\S]{0,36}\b(?:gmail|google\s+drive|google\s+docs?|slack|notion|dropbox|microsoft\s+365|outlook)\b/i,
    constraint:
      "No external app account is connected in this runtime, so it cannot access or act inside one.",
  },
  {
    capability: "shell",
    label: "Shell",
    pattern:
      /\b(?:run|execute|start)\b[\s\S]{0,20}\b(?:a\s+)?(?:shell|terminal|command|script|npm|bun|git|docker)\b/i,
    constraint: "This runtime has no shell and cannot execute commands or scripts.",
  },
  {
    capability: "filesystem",
    label: "Files",
    pattern:
      /\b(?:read|open|edit|write|create|delete|remove|move|rename|upload|download|search)\b[\s\S]{0,28}\b(?:files?|folders?|directories|workspace|path)\b/i,
    constraint: "This runtime has no filesystem access and cannot read or change files.",
  },
  {
    capability: "browser-control",
    label: "Browser control",
    pattern:
      /\b(?:open|navigate|visit|click|fill|submit|scroll|control|log\s*in)\b[\s\S]{0,32}\b(?:browser|website|webpage|page|tab|form)\b/i,
    constraint: "This runtime has no browser control and cannot operate websites or browser tabs.",
  },
  {
    capability: "coding-runtime",
    label: "Coding workspace",
    pattern:
      /\b(?:run|execute|test|build|compile|deploy|debug|fix|refactor)\b[\s\S]{0,36}\b(?:repository|repo|codebase|project|workspace|tests?|build)\b/i,
    constraint:
      "This runtime has no coding workspace and cannot execute, test, deploy, or edit a repository.",
  },
];

export function resolveSharedCapabilityWall(
  message: string | undefined,
  capabilities: { reminders?: boolean; todos?: boolean } = {},
): SharedCapabilityWall | null {
  const resolution = resolveSharedCapabilityIntent(message, capabilities);
  if (!resolution) return null;
  return resolution.kind === "blocked-primary"
    ? resolution.blocked
    : (resolution.blockedSecondary[0] ?? null);
}

type CapabilityMatch = {
  rule: (typeof RULES)[number];
  priority: number;
  index: number;
  end: number;
};

function isEnabled(
  match: CapabilityMatch,
  capabilities: { reminders?: boolean; todos?: boolean },
): boolean {
  return (
    (match.rule.capability === "reminders" && capabilities.reminders === true) ||
    (match.rule.capability === "todos" && capabilities.todos === true)
  );
}

function wallFor(match: CapabilityMatch): SharedCapabilityWall {
  const { capability, label, constraint } = match.rule;
  return { capability, label, constraint };
}

function startsInNonExecutionClause(text: string, index: number): boolean {
  const prefix = text.slice(0, index);
  const boundaries = Array.from(prefix.matchAll(/[.!?;,\n]+/g));
  const boundary = boundaries.at(-1);
  const clauseStart = boundary ? boundary.index + boundary[0].length : 0;
  return NON_EXECUTION_CONTEXT.test(text.slice(clauseStart, index));
}
function matchesForRule(
  rule: (typeof RULES)[number],
  priority: number,
  text: string,
): CapabilityMatch[] {
  const flags = rule.pattern.global ? rule.pattern.flags : `${rule.pattern.flags}g`;
  const pattern = new RegExp(rule.pattern.source, flags);
  return Array.from(text.matchAll(pattern), (match) => ({
    rule,
    priority,
    index: match.index,
    end: match.index + match[0].length,
  })).filter((match) => !startsInNonExecutionClause(text, match.index));
}

function beginsSeparateClause(text: string, primary: CapabilityMatch, candidate: CapabilityMatch) {
  if (candidate.index < primary.end) return false;
  const between = text.slice(primary.end, candidate.index);
  const isReminderPayload = primary.rule.capability === "reminders" && /\bto\b/i.test(between);
  if (/[.!?;,]\s*$/i.test(between)) return true;
  if (/\b(?:and\s+)?then\b[\s\S]*$/i.test(between)) {
    return !isReminderPayload || /[.!?;,]\s*(?:and\s+)?then\b[\s\S]*$/i.test(between);
  }
  if (!/\band\s*$/i.test(between)) return false;
  // An infinitive after "remind me" is reminder content, even when that
  // content coordinates several actions. A completed trigger followed by
  // "and" starts a new command instead.
  return !isReminderPayload;
}

/** Resolve enabled primary intents without hiding unsupported later clauses. */
export function resolveSharedCapabilityIntent(
  message: string | undefined,
  capabilities: { reminders?: boolean; todos?: boolean } = {},
): SharedCapabilityResolution | null {
  const text = (message ?? "").trim();
  if (!text) return null;
  const matches = RULES.flatMap((rule, priority) => matchesForRule(rule, priority, text)).sort(
    (left, right) => left.index - right.index || left.priority - right.priority,
  );
  const primary = matches[0];
  if (!primary) return null;
  if (!isEnabled(primary, capabilities)) {
    return { kind: "blocked-primary", blocked: wallFor(primary) };
  }
  const blockedCapabilities = new Set<SharedDedicatedCapability>();
  const blockedSecondary = matches
    .slice(1)
    .filter(
      (candidate) =>
        !isEnabled(candidate, capabilities) && beginsSeparateClause(text, primary, candidate),
    )
    .flatMap((candidate) => {
      if (blockedCapabilities.has(candidate.rule.capability)) return [];
      blockedCapabilities.add(candidate.rule.capability);
      return [wallFor(candidate)];
    });
  return {
    kind: "enabled-primary",
    primary: wallFor(primary),
    blockedSecondary,
  };
}

export function capabilityWallActionResult(
  wall: SharedCapabilityWall,
  context: {
    agentId?: string;
    originalIntent?: string;
    clientMessageId?: string;
  } = {},
) {
  const originalIntent = context.originalIntent?.trim() || undefined;
  const clientMessageId = context.clientMessageId?.trim() || undefined;
  const handoff: CapabilityHandoffRequest = {
    version: 1,
    kind: "capability_handoff",
    capabilityId: wall.capability,
    label: wall.label,
    availability: "needs_workspace",
    reason: wall.constraint,
    currentTier: "shared",
    requiredTier: "personal",
    nextAction: "upgrade_workspace",
    // This receipt offers a paid-workspace setup flow; it never authorizes
    // setup or the original capability request automatically.
    requiresConfirmation: true,
    cta: {
      label: "Set up personal workspace",
      href: context.agentId
        ? `/cloud/agents/${encodeURIComponent(context.agentId)}`
        : "/cloud/agents",
    },
    ...(originalIntent || clientMessageId
      ? {
          continuation: {
            ...(originalIntent ? { originalIntent } : {}),
            ...(clientMessageId ? { clientMessageId } : {}),
          },
        }
      : {}),
  };
  return {
    actionName: "DEDICATED_CAPABILITY_REQUIRED" as const,
    success: false as const,
    text: wall.constraint,
    values: {
      capability: wall.capability,
      currentExecutionTier: "shared" as const,
      requiredExecutionTier: "dedicated-always" as const,
      automatic: false as const,
      source: "agent" as const,
      capabilityHandoff: handoff,
    },
  };
}
