/** Keeps Shared honest when a request requires stateful tools or device control. */

export type SharedDedicatedCapability =
  | "calendar"
  | "reminders"
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
      "Calling or messaging people needs Dedicated. I can draft it here, but Shared can't send email, texts, DMs, or place calls.",
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
  capabilities: { reminders?: boolean } = {},
): SharedCapabilityWall | null {
  const text = (message ?? "").trim();
  if (!text || NON_EXECUTION_CONTEXT.test(text)) return null;
  const match = RULES.find(
    (rule) =>
      !(rule.capability === "reminders" && capabilities.reminders) && rule.pattern.test(text),
  );
  return match ? { capability: match.capability, label: match.label, reply: match.reply } : null;
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
