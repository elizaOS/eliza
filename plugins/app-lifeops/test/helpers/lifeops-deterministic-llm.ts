import type { AgentRuntime } from "@elizaos/core";

export type LifeOpsDeterministicLlmCall = {
  kind: string;
  modelType: string;
  prompt: string;
  request: string;
  response: string;
};

export type LifeOpsDeterministicLlm = {
  calls: LifeOpsDeterministicLlmCall[];
  useModel: AgentRuntime["useModel"];
};

type JsonObject = Record<string, JsonValue>;
type JsonValue = boolean | number | string | null | JsonObject | JsonValue[];

const NULL_GMAIL_PAYLOAD = {
  queries: [],
  messageId: null,
  messageIds: [],
  replyNeededOnly: null,
  operation: null,
  labelIds: [],
  confirmDestructive: null,
  olderThanDays: null,
  to: [],
  cc: [],
  bcc: [],
  subject: null,
  bodyText: null,
} satisfies JsonObject;

function stringify(value: JsonObject): string {
  return JSON.stringify(value);
}

function promptFromParams(params: object): string {
  if ("prompt" in params && typeof params.prompt === "string") {
    return params.prompt;
  }
  return "";
}

function lower(value: string): string {
  return value.toLowerCase();
}

function parseJsonLineField(prompt: string, label: string): string {
  const prefix = `${label}: `;
  for (const line of prompt.split("\n").reverse()) {
    if (!line.startsWith(prefix)) {
      continue;
    }
    try {
      const parsed = JSON.parse(line.slice(prefix.length)) as unknown;
      return typeof parsed === "string" ? parsed : "";
    } catch {
      return "";
    }
  }
  return "";
}

function parseNextLineField(prompt: string, label: string): string {
  const lines = prompt.split("\n");
  for (let i = 0; i < lines.length - 1; i++) {
    if (lines[i].trim() === `${label}:`) {
      return lines[i + 1].trim();
    }
  }
  return "";
}

function currentRequest(prompt: string): string {
  return (
    parseJsonLineField(prompt, "Current request") ||
    parseNextLineField(prompt, "Current request") ||
    parseJsonLineField(prompt, "User request") ||
    parseNextLineField(prompt, "User request") ||
    parseJsonLineField(prompt, "User said")
  );
}

function parsePendingDraft(prompt: string): JsonObject | null {
  const prefix = "Pending draft: ";
  const line = prompt
    .split("\n")
    .reverse()
    .find((entry) => entry.startsWith(prefix));
  if (!line) {
    return null;
  }
  try {
    const parsed = JSON.parse(line.slice(prefix.length)) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as JsonObject)
      : null;
  } catch {
    return null;
  }
}

function planLifeOperation(request: string): JsonObject {
  const normalized = lower(request);
  if (normalized.includes("brushed my teeth")) {
    return {
      operation: "complete_occurrence",
      confidence: 0.96,
      shouldAct: true,
      missing: [],
    };
  }
  if (normalized.includes("less reminders")) {
    return {
      operation: "set_reminder_preference",
      confidence: 0.92,
      shouldAct: true,
      missing: [],
    };
  }
  if (normalized.includes("learn guitar") || normalized.includes("marathon")) {
    return {
      operation: "create_goal",
      confidence: 0.9,
      shouldAct: true,
      missing: [],
    };
  }
  if (normalized.includes("calendar")) {
    return {
      operation: "query_calendar_today",
      confidence: 0.88,
      shouldAct: true,
      missing: [],
    };
  }
  if (normalized.includes("email") || normalized.includes("inbox")) {
    return {
      operation: "query_email",
      confidence: 0.88,
      shouldAct: true,
      missing: [],
    };
  }
  if (
    normalized.includes("remind") ||
    normalized.includes("routine") ||
    normalized.includes("alarm")
  ) {
    return {
      operation: "create_definition",
      confidence: 0.95,
      shouldAct: true,
      missing: [],
    };
  }
  return { operation: null, confidence: 0.62, shouldAct: false, missing: [] };
}

function planTaskCreate(request: string): JsonObject {
  const normalized = lower(request);
  if (normalized.includes("april 17") && normalized.includes("mountain")) {
    return {
      mode: "create",
      response: null,
      requestKind: "reminder",
      title: "Hug my wife",
      description: null,
      cadenceKind: "once",
      windows: null,
      weekdays: null,
      timeOfDay: "20:00",
      timeZone: "America/Denver",
      everyMinutes: null,
      timesPerDay: null,
      priority: null,
      durationMinutes: 30,
    };
  }
  if (normalized.includes("shave") && normalized.includes("twice a week")) {
    return {
      mode: "create",
      response: null,
      requestKind: "reminder",
      title: "Shave",
      description: null,
      cadenceKind: "weekly",
      windows: null,
      weekdays: [1, 4],
      timeOfDay: null,
      timeZone: null,
      everyMinutes: null,
      timesPerDay: null,
      priority: null,
      durationMinutes: null,
    };
  }
  if (normalized.includes("urgent") || normalized.includes("priority")) {
    return {
      mode: "create",
      response: null,
      requestKind: "reminder",
      title: "Review priority items",
      description: null,
      cadenceKind: "daily",
      windows: ["morning"],
      weekdays: null,
      timeOfDay: null,
      timeZone: null,
      everyMinutes: null,
      timesPerDay: null,
      priority: 5,
      durationMinutes: null,
    };
  }
  if (normalized.includes("brush") || normalized.includes("cepillar")) {
    return {
      mode: "create",
      response: null,
      requestKind: "reminder",
      title: "Brush teeth",
      description: null,
      cadenceKind: "daily",
      windows: ["morning", "night"],
      weekdays: null,
      timeOfDay: null,
      timeZone: null,
      everyMinutes: null,
      timesPerDay: null,
      priority: null,
      durationMinutes: null,
    };
  }
  return {
    mode: "respond",
    response: "What should I track, and when should it happen?",
    requestKind: null,
    title: null,
    description: null,
    cadenceKind: null,
    windows: null,
    weekdays: null,
    timeOfDay: null,
    timeZone: null,
    everyMinutes: null,
    timesPerDay: null,
    priority: null,
    durationMinutes: null,
  };
}

function planGoalCreate(request: string): JsonObject {
  const normalized = lower(request);
  if (normalized.includes("stabilize sleep schedule")) {
    return {
      mode: "respond",
      response:
        "What would a stabilized sleep schedule look like: target bedtime and wake time, or a consistency window?",
      title: "Stabilize sleep schedule",
      description: "Build a more consistent sleep schedule.",
      cadence: { kind: "weekly" },
      successCriteria: null,
      supportStrategy: null,
      groundingState: "partial",
      missingCriticalFields: [
        "target_state",
        "success_metric",
        "time_horizon",
        "evidence_source",
        "support_plan",
      ],
      confidence: 0.78,
      evaluationSummary: null,
      targetDomain: "sleep",
    };
  }
  return {
    mode: "respond",
    response: "What goal do you want to work on?",
    title: null,
    description: null,
    cadence: null,
    successCriteria: null,
    supportStrategy: null,
    groundingState: "ungrounded",
    missingCriticalFields: [
      "title",
      "target_state",
      "success_metric",
      "time_horizon",
      "evidence_source",
      "support_plan",
    ],
    confidence: 0.56,
    evaluationSummary: null,
    targetDomain: null,
  };
}

function planCalendar(request: string): JsonObject {
  const normalized = lower(request);
  if (normalized.includes("help") && normalized.includes("calendar")) {
    return {
      subaction: null,
      shouldAct: false,
      response:
        "What do you want to do on your calendar: check, add, move, delete, or search?",
      queries: [],
    };
  }
  if (normalized.includes("schedule") || normalized.includes("add ")) {
    return {
      subaction: "create_event",
      shouldAct: true,
      response: null,
      queries: [],
      title: normalized.includes("alex")
        ? "Meeting with Alex"
        : "Calendar event",
    };
  }
  if (
    normalized.includes("move") ||
    normalized.includes("reschedule") ||
    normalized.includes("rename")
  ) {
    return {
      subaction: "update_event",
      shouldAct: true,
      response: null,
      queries: [
        normalized.includes("dentist") ? "dentist appointment" : "meeting",
      ],
      windowLabel: normalized.includes("friday") ? "friday" : null,
    };
  }
  if (normalized.includes("delete") || normalized.includes("cancel")) {
    return {
      subaction: "delete_event",
      shouldAct: true,
      response: null,
      queries: [normalized.includes("team") ? "team meeting" : "event"],
      windowLabel: normalized.includes("tomorrow") ? "tomorrow" : null,
    };
  }
  if (
    normalized.includes("investor dinner") ||
    normalized.includes("dentist")
  ) {
    return {
      subaction: "search_events",
      shouldAct: true,
      response: null,
      queries: ["investor dinner", "return flight", "dentist"],
    };
  }
  if (normalized.includes("return flight")) {
    return {
      subaction: "search_events",
      shouldAct: true,
      response: null,
      queries: ["return flight"],
    };
  }
  if (normalized.includes("next meeting")) {
    return {
      subaction: "next_event",
      shouldAct: true,
      response: null,
      queries: [],
    };
  }
  return {
    subaction: "feed",
    shouldAct: true,
    response: null,
    queries: [],
  };
}

function calendarMutationBoundary(request: string): JsonObject {
  const subaction = planCalendar(request).subaction;
  return {
    subaction:
      subaction === "create_event" ||
      subaction === "update_event" ||
      subaction === "delete_event"
        ? subaction
        : null,
  };
}

function calendarReadBoundary(request: string): JsonObject {
  const subaction = planCalendar(request).subaction;
  return {
    subaction:
      subaction === "feed" ||
      subaction === "next_event" ||
      subaction === "search_events" ||
      subaction === "trip_window"
        ? subaction
        : null,
    tripLocation: null,
  };
}

function gmailStep(
  id: string,
  subaction: string,
  goal: string,
  fields: JsonObject = {},
): JsonObject {
  return {
    id,
    kind: "gmail_subaction",
    subaction,
    goal,
    status: "ready",
    dependsOn: [],
    requiresApproval: false,
    ...fields,
  };
}

function gmailIntentPlan(request: string): JsonObject {
  const normalized = lower(request);
  if (normalized.includes("help") && normalized.includes("email")) {
    return {
      subaction: null,
      shouldAct: false,
      response:
        "What do you want to do in Gmail: check, search, read, or draft?",
      planSummary: null,
      currentStepId: null,
      steps: [],
    };
  }
  if (
    normalized.includes("need") &&
    (normalized.includes("reply") || normalized.includes("response"))
  ) {
    return {
      subaction: "needs_response",
      shouldAct: true,
      response: null,
      planSummary: "Find emails needing a response",
      currentStepId: "needs_response",
      steps: [
        gmailStep(
          "needs_response",
          "needs_response",
          "Find reply-needed email",
          {
            replyNeededOnly: true,
          },
        ),
      ],
    };
  }
  if (
    normalized.includes("check my inbox") ||
    normalized.includes("urgent blockers")
  ) {
    return {
      subaction: "triage",
      shouldAct: true,
      response: null,
      planSummary: "Triage Gmail inbox by priority",
      currentStepId: "triage",
      steps: [gmailStep("triage", "triage", "Summarize priority inbox items")],
    };
  }
  if (normalized.includes("send") && normalized.includes("@")) {
    return {
      subaction: "send_message",
      shouldAct: true,
      response: null,
      planSummary: "Compose outbound Gmail message",
      currentStepId: "send_message",
      steps: [
        gmailStep("send_message", "send_message", "Compose outbound email"),
      ],
    };
  }
  return {
    subaction: "search",
    shouldAct: true,
    response: null,
    planSummary: "Search Gmail",
    currentStepId: "search",
    steps: [gmailStep("search", "search", "Find matching Gmail threads")],
  };
}

function gmailPayload(request: string, prompt: string): JsonObject {
  const normalized = lower(request);
  if (prompt.includes("(needs_response)")) {
    return {
      ...NULL_GMAIL_PAYLOAD,
      replyNeededOnly: true,
      queries: normalized.includes("venue") ? ["venue details"] : [],
    };
  }
  if (prompt.includes("(send_message)")) {
    return {
      ...NULL_GMAIL_PAYLOAD,
      to: normalized.includes("maria@example.com")
        ? ["maria@example.com"]
        : ["alice@example.com"],
      subject: normalized.includes("hola") ? "hola" : "Notes from today",
      bodyText: normalized.includes("nos vemos")
        ? "nos vemos manana"
        : "Here are the notes from today.",
    };
  }
  if (normalized.includes("personal") && normalized.includes("work")) {
    return {
      ...NULL_GMAIL_PAYLOAD,
      queries: ["suran account:personal", "suran account:work"],
    };
  }
  if (normalized.includes("sarah")) {
    return {
      ...NULL_GMAIL_PAYLOAD,
      queries: ["from:sarah report", "from:sarah venue"],
    };
  }
  if (normalized.includes("today") || normalized.includes("who emailed")) {
    return { ...NULL_GMAIL_PAYLOAD, queries: ["newer_than:1d"] };
  }
  if (normalized.includes("suran")) {
    return { ...NULL_GMAIL_PAYLOAD, queries: ["from:suran"] };
  }
  return { ...NULL_GMAIL_PAYLOAD, queries: [request] };
}

function crossChannelPlan(prompt: string): JsonObject {
  const request = currentRequest(prompt);
  const normalized = lower(request);
  const pendingDraft = parsePendingDraft(prompt);
  if (normalized.includes("send it") && pendingDraft) {
    return {
      channel: pendingDraft.channel ?? null,
      target: pendingDraft.target ?? null,
      message: pendingDraft.message ?? null,
      subject: pendingDraft.subject ?? null,
      confirmed: true,
      shouldAct: true,
      response: null,
    };
  }
  if (normalized.includes("direct relaying gets messy")) {
    return {
      channel: null,
      target: null,
      message: null,
      subject: null,
      confirmed: null,
      shouldAct: false,
      response:
        "If relay coordination gets messy, I will suggest a group chat handoff instead of one-off relays.",
    };
  }
  if (normalized.includes("alice@example.com")) {
    return {
      channel: "email",
      target: "alice@example.com",
      message: "Here are the notes from today.",
      subject: "Notes from today",
      confirmed: false,
      shouldAct: true,
      response: null,
    };
  }
  return {
    channel: null,
    target: null,
    message: null,
    subject: null,
    confirmed: null,
    shouldAct: false,
    response: "Who should receive the message, and what should it say?",
  };
}

function resolveResponse(prompt: string): {
  kind: string;
  request: string;
  value: JsonObject;
} {
  const request = currentRequest(prompt);
  if (
    prompt.includes("Plan the LifeOps response for the current user request.")
  ) {
    return {
      kind: "life-operation",
      request,
      value: planLifeOperation(request),
    };
  }
  if (prompt.includes("Recover the core LifeOps intent for this request.")) {
    return {
      kind: "life-operation-recovery",
      request,
      value: planLifeOperation(request),
    };
  }
  if (
    prompt.includes(
      "Plan the next step for a LifeOps create_definition request.",
    )
  ) {
    return { kind: "task-create", request, value: planTaskCreate(request) };
  }
  if (
    prompt.includes(
      "Ground the user's goal into something the system can actually review later.",
    )
  ) {
    return { kind: "goal-create", request, value: planGoalCreate(request) };
  }
  if (prompt.includes("Plan the calendar action for this request.")) {
    return { kind: "calendar-plan", request, value: planCalendar(request) };
  }
  if (prompt.includes("Resolve whether this calendar request is a mutation.")) {
    return {
      kind: "calendar-mutation-boundary",
      request,
      value: calendarMutationBoundary(request),
    };
  }
  if (prompt.includes("Resolve this calendar read intent.")) {
    return {
      kind: "calendar-read-boundary",
      request,
      value: calendarReadBoundary(request),
    };
  }
  if (prompt.includes("Resolve this calendar lookup intent.")) {
    return {
      kind: "calendar-lookup-boundary",
      request,
      value: calendarReadBoundary(request),
    };
  }
  if (prompt.includes("Create the Gmail execution plan for this request.")) {
    return { kind: "gmail-intent", request, value: gmailIntentPlan(request) };
  }
  if (
    prompt.includes("Extract Gmail parameters for the current executable step")
  ) {
    return {
      kind: "gmail-payload",
      request,
      value: gmailPayload(request, prompt),
    };
  }
  if (prompt.includes("Plan the MESSAGE action for this request.")) {
    return {
      kind: "cross-channel-send",
      request,
      value: crossChannelPlan(prompt),
    };
  }
  if (
    prompt.includes("Judge whether the assistant output satisfies the rubric.")
  ) {
    return {
      kind: "judge",
      request,
      value: {
        passed: true,
        score: 1,
        reasoning: "Deterministic fixture pass.",
      },
    };
  }
  return {
    kind: "unhandled",
    request,
    value: {
      subaction: null,
      shouldAct: false,
      response: `Unhandled deterministic LifeOps prompt: ${prompt.slice(0, 80)}`,
      queries: [],
    },
  };
}

export function createLifeOpsDeterministicLlm(): LifeOpsDeterministicLlm {
  const calls: LifeOpsDeterministicLlmCall[] = [];
  const useModel: AgentRuntime["useModel"] = async (modelType, params) => {
    const prompt = promptFromParams(params);
    const resolved = resolveResponse(prompt);
    const response = stringify(resolved.value);
    calls.push({
      kind: resolved.kind,
      modelType: String(modelType),
      prompt,
      request: resolved.request,
      response,
    });
    if (resolved.kind === "unhandled") {
      throw new Error(resolved.value.response as string);
    }
    return response;
  };

  return { calls, useModel };
}
