import {
  BROWSER_BRIDGE_ACTION_KINDS,
  type BrowserBridgeAction,
} from "@elizaos/plugin-browser";
import type {
  CreateLifeOpsDefinitionRequest,
  GetLifeOpsCalendarFeedRequest,
  GetLifeOpsGmailTriageRequest,
  GetLifeOpsGmailUnrespondedRequest,
  GetLifeOpsHealthSummaryRequest,
  LifeOpsCadence,
  LifeOpsProgressionRule,
  LifeOpsTimeWindowDefinition,
  LifeOpsWebsiteAccessPolicy,
  LifeOpsWindowPolicy,
  LifeOpsWorkflowAction,
  LifeOpsWorkflowActionPlan,
} from "../contracts/index.js";
import { DAY_MINUTES } from "./service-constants.js";
import {
  fail,
  normalizeEnumValue,
  normalizeFiniteNumber,
  normalizeIsoString,
  normalizeOptionalBoolean,
  normalizeOptionalMinutes,
  normalizeOptionalString,
  normalizePositiveInteger,
  requireNonEmptyString,
} from "./service-normalize.js";
import { normalizeOptionalBrowserKind } from "./service-normalize-connector.js";

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(400, `${field} must be an object`);
  }
  return { ...value } as Record<string, unknown>;
}

function normalizeOptionalRecord(
  value: unknown,
  field: string,
): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  return requireRecord(value, field);
}

export function normalizeBrowserActionInput(
  value: unknown,
  field: string,
): Omit<BrowserBridgeAction, "id"> {
  const input = requireRecord(value, field);
  const kind = normalizeEnumValue(
    input.kind,
    `${field}.kind`,
    BROWSER_BRIDGE_ACTION_KINDS,
  );
  const label = requireNonEmptyString(input.label, `${field}.label`);
  const browser = normalizeOptionalBrowserKind(
    input.browser,
    `${field}.browser`,
  );
  const windowId = normalizeOptionalString(input.windowId) ?? null;
  const tabId = normalizeOptionalString(input.tabId) ?? null;
  const url = normalizeOptionalString(input.url) ?? null;
  const selector = normalizeOptionalString(input.selector) ?? null;
  const text = normalizeOptionalString(input.text) ?? null;
  if ((kind === "open" || kind === "navigate") && !url) {
    fail(400, `${field}.url is required for ${kind} actions`);
  }
  if (kind === "focus_tab" && !tabId) {
    fail(400, `${field}.tabId is required for focus_tab actions`);
  }
  if ((kind === "click" || kind === "type" || kind === "submit") && !selector) {
    fail(400, `${field}.selector is required for ${kind} actions`);
  }
  if (kind === "type" && text === null) {
    fail(400, `${field}.text is required for type actions`);
  }
  return {
    kind,
    label,
    browser,
    windowId,
    tabId,
    url,
    selector,
    text,
    accountAffecting:
      normalizeOptionalBoolean(
        input.accountAffecting,
        `${field}.accountAffecting`,
      ) ?? false,
    requiresConfirmation:
      normalizeOptionalBoolean(
        input.requiresConfirmation,
        `${field}.requiresConfirmation`,
      ) ?? false,
    metadata:
      normalizeOptionalRecord(input.metadata, `${field}.metadata`) ?? {},
  };
}

export function normalizeWorkflowActionPlan(
  value: unknown,
): LifeOpsWorkflowActionPlan {
  const input = requireRecord(value, "actionPlan");
  if (!Array.isArray(input.steps) || input.steps.length === 0) {
    fail(400, "actionPlan.steps must contain at least one step");
  }
  const steps: LifeOpsWorkflowAction[] = input.steps.map((candidate, index) => {
    const step = requireRecord(candidate, `actionPlan.steps[${index}]`);
    const kind = normalizeEnumValue(
      step.kind,
      `actionPlan.steps[${index}].kind`,
      [
        "create_task",
        "relock_website_access",
        "resolve_website_access_callback",
        "get_calendar_feed",
        "get_gmail_triage",
        "get_gmail_unresponded",
        "get_health_summary",
        "dispatch_n8n_workflow",
        "summarize",
        "browser",
      ] as const,
    );
    const id = normalizeOptionalString(step.id);
    const resultKey = normalizeOptionalString(step.resultKey);
    if (kind === "create_task") {
      return {
        kind,
        id,
        resultKey,
        request: requireRecord(
          step.request,
          `actionPlan.steps[${index}].request`,
        ) as unknown as CreateLifeOpsDefinitionRequest,
      };
    }
    if (kind === "relock_website_access") {
      return {
        kind,
        id,
        resultKey,
        request: {
          groupKey: requireNonEmptyString(
            requireRecord(step.request, `actionPlan.steps[${index}].request`)
              .groupKey,
            `actionPlan.steps[${index}].request.groupKey`,
          ),
        },
      };
    }
    if (kind === "resolve_website_access_callback") {
      return {
        kind,
        id,
        resultKey,
        request: {
          callbackKey: requireNonEmptyString(
            requireRecord(step.request, `actionPlan.steps[${index}].request`)
              .callbackKey,
            `actionPlan.steps[${index}].request.callbackKey`,
          ),
        },
      };
    }
    if (kind === "get_calendar_feed") {
      return {
        kind,
        id,
        resultKey,
        request: normalizeOptionalRecord(
          step.request,
          `actionPlan.steps[${index}].request`,
        ) as unknown as GetLifeOpsCalendarFeedRequest | undefined,
      };
    }
    if (kind === "get_gmail_triage") {
      return {
        kind,
        id,
        resultKey,
        request: normalizeOptionalRecord(
          step.request,
          `actionPlan.steps[${index}].request`,
        ) as unknown as GetLifeOpsGmailTriageRequest | undefined,
      };
    }
    if (kind === "get_gmail_unresponded") {
      return {
        kind,
        id,
        resultKey,
        request: normalizeOptionalRecord(
          step.request,
          `actionPlan.steps[${index}].request`,
        ) as unknown as GetLifeOpsGmailUnrespondedRequest | undefined,
      };
    }
    if (kind === "get_health_summary") {
      return {
        kind,
        id,
        resultKey,
        request: normalizeOptionalRecord(
          step.request,
          `actionPlan.steps[${index}].request`,
        ) as unknown as GetLifeOpsHealthSummaryRequest | undefined,
      };
    }
    if (kind === "dispatch_n8n_workflow") {
      return {
        kind,
        id,
        resultKey,
        workflowId: requireNonEmptyString(
          step.workflowId,
          `actionPlan.steps[${index}].workflowId`,
        ),
        payload: normalizeOptionalRecord(
          step.payload,
          `actionPlan.steps[${index}].payload`,
        ),
      };
    }
    if (kind === "summarize") {
      return {
        kind,
        id,
        resultKey,
        sourceKey: normalizeOptionalString(step.sourceKey),
        prompt: normalizeOptionalString(step.prompt),
      };
    }
    if (!Array.isArray(step.actions) || step.actions.length === 0) {
      fail(
        400,
        `actionPlan.steps[${index}].actions must contain at least one action`,
      );
    }
    return {
      kind,
      id,
      resultKey,
      sessionTitle: requireNonEmptyString(
        step.sessionTitle,
        `actionPlan.steps[${index}].sessionTitle`,
      ),
      actions: step.actions.map((action, actionIndex) =>
        normalizeBrowserActionInput(
          action,
          `actionPlan.steps[${index}].actions[${actionIndex}]`,
        ),
      ),
    };
  });
  return { steps };
}

export function normalizeWindowNames(
  value: unknown,
  field: string,
  windowPolicy: LifeOpsWindowPolicy,
): Array<LifeOpsTimeWindowDefinition["name"]> {
  if (!Array.isArray(value) || value.length === 0) {
    fail(400, `${field} must contain at least one time window`);
  }
  const allowedNames = new Set(
    windowPolicy.windows.map((window) => window.name),
  );
  const seen = new Set<string>();
  const windows: Array<LifeOpsTimeWindowDefinition["name"]> = [];
  for (const candidate of value) {
    const name = requireNonEmptyString(
      candidate,
      field,
    ) as LifeOpsTimeWindowDefinition["name"];
    if (!allowedNames.has(name)) {
      fail(400, `${field} contains unknown window "${name}"`);
    }
    if (!seen.has(name)) {
      seen.add(name);
      windows.push(name);
    }
  }
  return windows;
}

export function normalizeCadence(
  cadence: LifeOpsCadence,
  windowPolicy: LifeOpsWindowPolicy,
): LifeOpsCadence {
  const visibilityLeadMinutes = normalizeOptionalMinutes(
    cadence.visibilityLeadMinutes,
    "cadence.visibilityLeadMinutes",
  );
  const visibilityLagMinutes = normalizeOptionalMinutes(
    cadence.visibilityLagMinutes,
    "cadence.visibilityLagMinutes",
  );

  const withVisibility = <T extends object>(
    value: T,
  ): T & {
    visibilityLeadMinutes?: number;
    visibilityLagMinutes?: number;
  } => {
    const next: T & {
      visibilityLeadMinutes?: number;
      visibilityLagMinutes?: number;
    } = { ...value };
    if (visibilityLeadMinutes !== undefined) {
      next.visibilityLeadMinutes = visibilityLeadMinutes;
    }
    if (visibilityLagMinutes !== undefined) {
      next.visibilityLagMinutes = visibilityLagMinutes;
    }
    return next;
  };

  switch (cadence.kind) {
    case "once":
      return withVisibility({
        kind: "once",
        dueAt: normalizeIsoString(cadence.dueAt, "cadence.dueAt"),
      }) as LifeOpsCadence;
    case "daily":
      return withVisibility({
        kind: "daily",
        windows: normalizeWindowNames(
          cadence.windows,
          "cadence.windows",
          windowPolicy,
        ),
      }) as LifeOpsCadence;
    case "weekly": {
      if (!Array.isArray(cadence.weekdays) || cadence.weekdays.length === 0) {
        fail(400, "cadence.weekdays must contain at least one weekday");
      }
      const weekdays = [
        ...new Set(
          cadence.weekdays.map((weekday) =>
            Math.trunc(normalizeFiniteNumber(weekday, "cadence.weekdays")),
          ),
        ),
      ].sort((left, right) => left - right);
      if (weekdays.some((weekday) => weekday < 0 || weekday > 6)) {
        fail(400, "cadence.weekdays must use Sunday=0 through Saturday=6");
      }
      return withVisibility({
        kind: "weekly",
        weekdays,
        windows: normalizeWindowNames(
          cadence.windows,
          "cadence.windows",
          windowPolicy,
        ),
      }) as LifeOpsCadence;
    }
    case "times_per_day": {
      if (!Array.isArray(cadence.slots) || cadence.slots.length === 0) {
        fail(400, "cadence.slots must contain at least one slot");
      }
      const seen = new Set<string>();
      const slots = cadence.slots.map((slot, index) => {
        const key = requireNonEmptyString(
          slot.key,
          `cadence.slots[${index}].key`,
        );
        if (seen.has(key)) {
          fail(400, `cadence.slots contains duplicate key "${key}"`);
        }
        seen.add(key);
        const label = requireNonEmptyString(
          slot.label,
          `cadence.slots[${index}].label`,
        );
        const minuteOfDay = Math.trunc(
          normalizeFiniteNumber(
            slot.minuteOfDay,
            `cadence.slots[${index}].minuteOfDay`,
          ),
        );
        const durationMinutes = Math.trunc(
          normalizeFiniteNumber(
            slot.durationMinutes,
            `cadence.slots[${index}].durationMinutes`,
          ),
        );
        if (minuteOfDay < 0 || minuteOfDay >= DAY_MINUTES) {
          fail(
            400,
            `cadence.slots[${index}].minuteOfDay must be between 0 and 1439`,
          );
        }
        if (durationMinutes <= 0 || durationMinutes > DAY_MINUTES) {
          fail(
            400,
            `cadence.slots[${index}].durationMinutes must be between 1 and 1440`,
          );
        }
        return {
          key,
          label,
          minuteOfDay,
          durationMinutes,
        };
      });
      return withVisibility({
        kind: "times_per_day",
        slots,
      }) as LifeOpsCadence;
    }
    case "interval": {
      const everyMinutes = Math.trunc(
        normalizeFiniteNumber(cadence.everyMinutes, "cadence.everyMinutes"),
      );
      if (everyMinutes <= 0 || everyMinutes > DAY_MINUTES) {
        fail(400, "cadence.everyMinutes must be between 1 and 1440");
      }
      const windows = normalizeWindowNames(
        cadence.windows,
        "cadence.windows",
        windowPolicy,
      );
      const normalized: Extract<LifeOpsCadence, { kind: "interval" }> = {
        kind: "interval",
        everyMinutes,
        windows,
      };
      if (cadence.startMinuteOfDay !== undefined) {
        const startMinuteOfDay = Math.trunc(
          normalizeFiniteNumber(
            cadence.startMinuteOfDay,
            "cadence.startMinuteOfDay",
          ),
        );
        if (startMinuteOfDay < 0 || startMinuteOfDay >= DAY_MINUTES) {
          fail(400, "cadence.startMinuteOfDay must be between 0 and 1439");
        }
        normalized.startMinuteOfDay = startMinuteOfDay;
      }
      if (cadence.maxOccurrencesPerDay !== undefined) {
        const maxOccurrencesPerDay = normalizePositiveInteger(
          cadence.maxOccurrencesPerDay,
          "cadence.maxOccurrencesPerDay",
        );
        if (maxOccurrencesPerDay > Math.ceil(DAY_MINUTES / everyMinutes)) {
          fail(
            400,
            "cadence.maxOccurrencesPerDay is larger than the interval allows",
          );
        }
        normalized.maxOccurrencesPerDay = maxOccurrencesPerDay;
      }
      if (cadence.durationMinutes !== undefined) {
        const durationMinutes = Math.trunc(
          normalizeFiniteNumber(
            cadence.durationMinutes,
            "cadence.durationMinutes",
          ),
        );
        if (durationMinutes <= 0 || durationMinutes > DAY_MINUTES) {
          fail(400, "cadence.durationMinutes must be between 1 and 1440");
        }
        normalized.durationMinutes = durationMinutes;
      }
      return withVisibility(normalized) as LifeOpsCadence;
    }
    default:
      fail(400, "cadence.kind is not supported");
  }
}

export function normalizeWebsiteAccessPolicy(
  value: unknown,
  field: string,
): LifeOpsWebsiteAccessPolicy | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const record = requireRecord(value, field);
  const groupKey = requireNonEmptyString(record.groupKey, `${field}.groupKey`);
  if (!Array.isArray(record.websites) || record.websites.length === 0) {
    fail(400, `${field}.websites must contain at least one website`);
  }
  const seen = new Set<string>();
  const websites: string[] = [];
  for (const [index, candidate] of record.websites.entries()) {
    const website = requireNonEmptyString(
      candidate,
      `${field}.websites[${index}]`,
    ).toLowerCase();
    if (!seen.has(website)) {
      seen.add(website);
      websites.push(website);
    }
  }
  const rawUnlockMode =
    normalizeOptionalString(record.unlockMode) ?? "fixed_duration";
  const unlockMode =
    rawUnlockMode === "until_manual_lock" || rawUnlockMode === "until_callback"
      ? rawUnlockMode
      : rawUnlockMode === "fixed_duration"
        ? rawUnlockMode
        : fail(
            400,
            `${field}.unlockMode must be fixed_duration, until_manual_lock, or until_callback`,
          );
  const unlockDurationMinutes =
    unlockMode === "fixed_duration"
      ? normalizePositiveInteger(
          record.unlockDurationMinutes,
          `${field}.unlockDurationMinutes`,
        )
      : undefined;
  const callbackKey =
    unlockMode === "until_callback"
      ? requireNonEmptyString(record.callbackKey, `${field}.callbackKey`)
      : (normalizeOptionalString(record.callbackKey) ?? null);
  const reason =
    normalizeOptionalString(record.reason) ??
    "Access is locked until this routine earns another unlock.";
  return {
    groupKey,
    websites,
    unlockMode,
    ...(unlockDurationMinutes !== undefined ? { unlockDurationMinutes } : {}),
    ...(callbackKey ? { callbackKey } : {}),
    reason,
  };
}

export function normalizeProgressionRule(
  rule: LifeOpsProgressionRule | undefined,
): LifeOpsProgressionRule {
  if (!rule || rule.kind === "none") {
    return { kind: "none" };
  }
  if (rule.kind !== "linear_increment") {
    fail(400, "progressionRule.kind is not supported");
  }
  const metric = requireNonEmptyString(rule.metric, "progressionRule.metric");
  const start = normalizeFiniteNumber(rule.start, "progressionRule.start");
  const step = normalizeFiniteNumber(rule.step, "progressionRule.step");
  if (step <= 0) {
    fail(400, "progressionRule.step must be greater than 0");
  }
  const normalized: LifeOpsProgressionRule = {
    kind: "linear_increment",
    metric,
    start,
    step,
  };
  const unit = normalizeOptionalString(rule.unit);
  if (unit) {
    normalized.unit = unit;
  }
  return normalized;
}
