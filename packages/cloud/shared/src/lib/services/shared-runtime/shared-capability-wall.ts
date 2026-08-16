/** Keeps Shared honest when a request requires stateful tools or device control. */

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
  reply: string;
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
    reply:
      "Reminders need Dedicated. I can still help you plan it here, but Shared can't schedule or deliver reminders.",
  },
  {
    capability: "todos",
    label: "Todos",
    pattern:
      /\b(?:add|create|make|write|show|list|get|update|edit|complete|finish|cancel|delete|remove|clear)\b[\s\S]{0,48}\b(?:to[ -]?dos?|task\s+list|checklist|my\s+tasks?)\b/i,
    reply: "Todos are unavailable on this chat path right now. I didn't save or change anything.",
  },
  {
    capability: "calendar",
    label: "Calendar",
    pattern:
      /\b(?:add|create|book|schedule|cancel|delete|move|reschedule|check|show|list|open)\b[\s\S]{0,36}\b(?:calendar|events?|appointments?|meetings?)\b/i,
    reply:
      "Calendar actions need Dedicated. I can help plan the event here, but Shared can't read or change your calendar.",
  },
  {
    capability: "bookings",
    label: "Bookings",
    pattern:
      /\b(?:(?:can|could|would|will)\s+you\s+)?(?:(?:book|reserve)\s+(?:it|that|this)|(?:book|reserve)\b[\s\S]{0,48}\b(?:flights?|tables?|restaurants?|reservations?|hotels?|rooms?|tickets?|dinner|lunch|appointments?)|make\b[\s\S]{0,36}\b(?:reservations?|bookings?))\b/i,
    reply:
      "Bookings need Dedicated. I can research options and help you choose, but Shared can't make the reservation or purchase.",
  },
  {
    capability: "communications",
    label: "Calls and messages",
    pattern:
      /\b(?:(?:can|could|would|will)\s+you\s+)?(?:(?:email|call|text|message|dm)\b(?!\s+(?:this|the|a|an)\s+(?:\w+\s+){0,2}(?:function|method|api|endpoint|class|variable|command)\b)|send\b[\s\S]{0,32}\b(?:email|text|message|dm)\b)/i,
    reply:
      "I can talk with you and reply through Eliza's connected voice and messaging channels. I can't initiate a separate call, email, text, or DM to another person from this session.",
  },
  {
    capability: "purchases",
    label: "Purchases",
    pattern:
      /\b(?:(?:can|could|would|will)\s+you\s+)?(?:order|buy|purchase)\b[\s\S]{0,48}\b(?:food|groceries|meal|dinner|lunch|breakfast|item|product|gift|flowers|bottle|coffee|pizza|tickets?)\b/i,
    reply:
      "Purchases need Dedicated. I can compare options here, but Shared can't place an order or buy anything.",
  },
  {
    capability: "notes",
    label: "Notes",
    pattern:
      /\b(?:create|save|add|store|write|read|show|list|open|delete|remove|update|edit)\b[\s\S]{0,28}\bnotes?\b/i,
    reply:
      "Persistent notes need Dedicated. I can remember this conversation, but Shared doesn't manage a separate notes store.",
  },
  {
    capability: "cloud-apps",
    label: "Cloud apps",
    pattern:
      /\b(?:connect|open|read|send|search|manage|update|upload|download)\b[\s\S]{0,36}\b(?:gmail|google\s+drive|google\s+docs?|slack|notion|dropbox|microsoft\s+365|outlook)\b/i,
    reply: "Connected apps need Dedicated. Shared can't access or act inside external accounts.",
  },
  {
    capability: "shell",
    label: "Shell",
    pattern:
      /\b(?:run|execute|start)\b[\s\S]{0,20}\b(?:a\s+)?(?:shell|terminal|command|script|npm|bun|git|docker)\b/i,
    reply:
      "Running commands needs Dedicated. I can reason about commands here, but Shared has no shell.",
  },
  {
    capability: "filesystem",
    label: "Files",
    pattern:
      /\b(?:read|open|edit|write|create|delete|remove|move|rename|upload|download|search)\b[\s\S]{0,28}\b(?:files?|folders?|directories|workspace|path)\b/i,
    reply:
      "File access needs Dedicated. Shared can use text you paste here, but it can't read or change a filesystem.",
  },
  {
    capability: "browser-control",
    label: "Browser control",
    pattern:
      /\b(?:open|navigate|visit|click|fill|submit|scroll|control|log\s*in)\b[\s\S]{0,32}\b(?:browser|website|webpage|page|tab|form)\b/i,
    reply: "Browser control needs Dedicated. Shared can't operate websites or a browser session.",
  },
  {
    capability: "coding-runtime",
    label: "Coding workspace",
    pattern:
      /\b(?:run|execute|test|build|compile|deploy|debug|fix|refactor)\b[\s\S]{0,36}\b(?:repository|repo|codebase|project|workspace|tests?|build)\b/i,
    reply:
      "A coding workspace needs Dedicated. I can write and explain code here, but Shared can't execute or edit a repository.",
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
  const { capability, label, reply } = match.rule;
  return { capability, label, reply };
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

/**
 * Resolve the first executable intent without losing explicit later clauses.
 * Enabled reminder/Todo payloads may contain capability words, while a later
 * sentence or sequenced clause remains a typed blocked request.
 */
export function resolveSharedCapabilityIntent(
  message: string | undefined,
  capabilities: { reminders?: boolean; todos?: boolean } = {},
): SharedCapabilityResolution | null {
  const text = (message ?? "").trim();
  if (!text || NON_EXECUTION_CONTEXT.test(text)) return null;
  const matches = RULES.flatMap((rule, priority) => {
    const pattern = new RegExp(
      rule.pattern.source,
      rule.pattern.flags.includes("g") ? rule.pattern.flags : `${rule.pattern.flags}g`,
    );
    return Array.from(text.matchAll(pattern), (match) => ({
      rule,
      priority,
      index: match.index,
      end: match.index + match[0].length,
    }));
  }).sort((left, right) => left.index - right.index || left.priority - right.priority);
  const primary = matches[0];
  if (!primary) return null;
  if (!isEnabled(primary, capabilities)) {
    return { kind: "blocked-primary", blocked: wallFor(primary) };
  }
  const blockedMatches = matches
    .slice(1)
    .filter(
      (candidate) =>
        !isEnabled(candidate, capabilities) && beginsSeparateClause(text, primary, candidate),
    );
  const blockedCapabilities = new Set<SharedDedicatedCapability>();
  const blockedSecondary = blockedMatches.flatMap((match) => {
    if (blockedCapabilities.has(match.rule.capability)) return [];
    blockedCapabilities.add(match.rule.capability);
    return [wallFor(match)];
  });
  return {
    kind: "enabled-primary",
    primary: wallFor(primary),
    blockedSecondary,
  };
}

export function capabilityWallActionResult(wall: SharedCapabilityWall) {
  return {
    actionName: "DEDICATED_CAPABILITY_REQUIRED" as const,
    success: false as const,
    text: wall.reply,
    values: {
      capability: wall.capability,
      currentExecutionTier: "shared" as const,
      requiredExecutionTier: "dedicated-always" as const,
      automatic: false as const,
      source: "agent" as const,
    },
  };
}
