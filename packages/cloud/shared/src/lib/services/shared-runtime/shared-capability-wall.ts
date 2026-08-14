/**
 * Resolves explicit requests for stateful or device-owning features that the
 * container-free Shared runtime cannot perform. Precision-first matching keeps
 * ordinary discussion and code generation in chat while execution requests
 * receive a truthful Dedicated boundary before any model can hallucinate one.
 */

export type SharedDedicatedCapability =
  | "notes"
  | "calendar"
  | "reminders"
  | "bookings"
  | "communications"
  | "purchases"
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

const NON_EXECUTION_CONTEXT =
  /^(?:please\s+)?(?:(?:can|could|would)\s+you\s+)?(?:do\s+not|don't|dont|never|explain|describe|define|translate|teach\s+me|tell\s+me\s+how|show\s+me\s+how|how\s+(?:do|would|can|to)|what\s+(?:is|are|would|happens?)|why\s+(?:do|would|can|is|are)|if\s+(?:i|we|you)|before\s+you)\b/i;

const RULES: ReadonlyArray<{
  capability: SharedDedicatedCapability;
  label: string;
  pattern: RegExp;
  reply: string;
}> = [
  {
    capability: "reminders",
    label: "Reminders",
    pattern:
      /\b(?:remind\s+me|(?:set|create|add|schedule|cancel|delete|change|list|show)\b[\s\S]{0,36}\breminders?)\b/i,
    reply:
      "Reminders require Dedicated. Shared chat and conversation memory remain available; activate Dedicated when you want Eliza to schedule and deliver reminders.",
  },
  {
    capability: "calendar",
    label: "Calendar",
    pattern:
      /\b(?:add|create|book|schedule|cancel|delete|move|reschedule|check|show|list|open)\b[\s\S]{0,36}\b(?:calendar|events?|appointments?|meetings?)\b/i,
    reply:
      "Calendar actions require Dedicated. Shared chat remains available; activate Dedicated when you want Eliza to read or change your calendar.",
  },
  {
    capability: "bookings",
    label: "Bookings",
    pattern:
      /\b(?:(?:can|could|would|will)\s+you\s+)?(?:(?:book|reserve)\b[\s\S]{0,48}\b(?:flights?|tables?|restaurants?|reservations?|hotels?|rooms?|tickets?|dinner|lunch|appointments?)|make\b[\s\S]{0,36}\b(?:reservations?|bookings?))\b/i,
    reply:
      "Bookings require Dedicated. Shared can research and help you choose, but it cannot reserve a table, flight, hotel, appointment, or ticket.",
  },
  {
    capability: "communications",
    label: "Calls and messages",
    pattern:
      /\b(?:(?:can|could|would|will)\s+you\s+)?(?:(?:email|call|text|message|dm)\b(?!\s+(?:this|the|a|an)\s+(?:\w+\s+){0,2}(?:function|method|api|endpoint|class|variable|command)\b)|send\b[\s\S]{0,32}\b(?:email|text|message|dm)\b)/i,
    reply:
      "Calling or messaging people requires Dedicated. Shared can draft what you want to say, but it cannot send email, texts, DMs, or place calls.",
  },
  {
    capability: "purchases",
    label: "Purchases",
    pattern:
      /\b(?:(?:can|could|would|will)\s+you\s+)?(?:order|buy|purchase)\b[\s\S]{0,48}\b(?:food|groceries|meal|dinner|lunch|breakfast|item|product|gift|flowers|bottle|coffee|pizza|tickets?)\b/i,
    reply:
      "Purchases require Dedicated. Shared can compare options and help you decide, but it cannot place an order or buy anything.",
  },
  {
    capability: "notes",
    label: "Notes",
    pattern:
      /\b(?:create|save|add|store|write|read|show|list|open|delete|remove|update|edit)\b[\s\S]{0,28}\bnotes?\b/i,
    reply:
      "Persistent notes require Dedicated. Shared can discuss and remember this conversation, but it cannot create or manage a notes store.",
  },
  {
    capability: "cloud-apps",
    label: "Cloud apps",
    pattern:
      /\b(?:connect|open|read|send|search|manage|update|upload|download)\b[\s\S]{0,36}\b(?:gmail|google\s+drive|google\s+docs?|slack|notion|dropbox|microsoft\s+365|outlook)\b/i,
    reply:
      "Connected cloud apps require Dedicated. Shared chat remains available; activate Dedicated before Eliza can access or act inside external accounts.",
  },
  {
    capability: "shell",
    label: "Shell",
    pattern:
      /\b(?:run|execute|start)\b[\s\S]{0,20}\b(?:a\s+)?(?:shell|terminal|command|script|npm|bun|git|docker)\b/i,
    reply:
      "Running commands requires Dedicated. Shared can help reason about commands in chat, but it has no shell or execution environment.",
  },
  {
    capability: "filesystem",
    label: "Files",
    pattern:
      /\b(?:read|open|edit|write|create|delete|remove|move|rename|upload|download|search)\b[\s\S]{0,28}\b(?:files?|folders?|directories|workspace|path)\b/i,
    reply:
      "File access requires Dedicated. Shared can work with text you provide in chat, but it cannot read or change a filesystem.",
  },
  {
    capability: "browser-control",
    label: "Browser control",
    pattern:
      /\b(?:open|navigate|visit|click|fill|submit|scroll|control|log\s*in)\b[\s\S]{0,32}\b(?:browser|website|webpage|page|tab|form)\b/i,
    reply:
      "Browser control requires Dedicated. Shared chat remains available, but it cannot operate websites or a browser session.",
  },
  {
    capability: "coding-runtime",
    label: "Coding workspace",
    pattern:
      /\b(?:run|execute|test|build|compile|deploy|debug|fix|refactor)\b[\s\S]{0,36}\b(?:repository|repo|codebase|project|workspace|tests?|build)\b/i,
    reply:
      "A coding workspace requires Dedicated. Shared can write and explain code in chat, but it cannot execute, test, or edit a repository.",
  },
];

export function resolveSharedCapabilityWall(
  message: string | undefined,
): SharedCapabilityWall | null {
  const text = (message ?? "").trim();
  if (!text || NON_EXECUTION_CONTEXT.test(text)) return null;
  const rule = RULES.find((candidate) => candidate.pattern.test(text));
  return rule
    ? {
        capability: rule.capability,
        label: rule.label,
        reply: rule.reply,
      }
    : null;
}

export function capabilityWallActionResult(wall: SharedCapabilityWall): {
  actionName: "DEDICATED_CAPABILITY_REQUIRED";
  success: false;
  text: string;
  values: {
    capability: SharedDedicatedCapability;
    currentExecutionTier: "shared";
    requiredExecutionTier: "dedicated-always";
    automatic: false;
    source: "agent";
  };
} {
  return {
    actionName: "DEDICATED_CAPABILITY_REQUIRED",
    success: false,
    text: wall.reply,
    values: {
      capability: wall.capability,
      currentExecutionTier: "shared",
      requiredExecutionTier: "dedicated-always",
      automatic: false,
      source: "agent",
    },
  };
}
