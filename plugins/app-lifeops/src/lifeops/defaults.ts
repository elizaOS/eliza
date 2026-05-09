import type { ActivityProfile } from "../activity-profile/types";
import type {
  LifeOpsReminderStep,
  LifeOpsTimeWindowDefinition,
  LifeOpsWindowPolicy,
} from "../contracts/index.js";

export const DEFAULT_TIME_WINDOWS: LifeOpsTimeWindowDefinition[] = [
  {
    name: "morning",
    label: "Morning",
    startMinute: 5 * 60,
    endMinute: 12 * 60,
  },
  {
    name: "afternoon",
    label: "Afternoon",
    startMinute: 12 * 60,
    endMinute: 17 * 60,
  },
  {
    name: "evening",
    label: "Evening",
    startMinute: 17 * 60,
    endMinute: 22 * 60,
  },
  {
    name: "night",
    label: "Night",
    startMinute: 22 * 60,
    endMinute: 28 * 60,
  },
];

export const DEFAULT_REMINDER_STEPS: LifeOpsReminderStep[] = [
  {
    channel: "in_app",
    offsetMinutes: 0,
    label: "In-app reminder",
  },
];

export function resolveDefaultTimeZone(): string {
  const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return resolved && resolved.trim().length > 0 ? resolved : "UTC";
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function normalizeTimeZone(timeZone?: string | null): string {
  const candidate = typeof timeZone === "string" ? timeZone.trim() : "";
  if (candidate && isValidTimeZone(candidate)) {
    return candidate;
  }
  return resolveDefaultTimeZone();
}

export function resolveDefaultWindowPolicy(
  timeZone?: string | null,
): LifeOpsWindowPolicy {
  const timezone = normalizeTimeZone(timeZone);
  return {
    timezone,
    windows: DEFAULT_TIME_WINDOWS.map((window) => ({ ...window })),
  };
}

/**
 * Returns true when the given window policy's windows match the static
 * `DEFAULT_TIME_WINDOWS` by name and minute boundaries — i.e. the user
 * has not customized them.
 */
export function windowPolicyMatchesDefaults(
  policy: LifeOpsWindowPolicy | null | undefined,
): boolean {
  if (!policy || !Array.isArray(policy.windows)) return false;
  if (policy.windows.length !== DEFAULT_TIME_WINDOWS.length) return false;
  for (let i = 0; i < DEFAULT_TIME_WINDOWS.length; i++) {
    const def = DEFAULT_TIME_WINDOWS[i];
    const win = policy.windows[i];
    if (!def || !win) {
      return false;
    }
    if (
      win.name !== def.name ||
      win.startMinute !== def.startMinute ||
      win.endMinute !== def.endMinute
    ) {
      return false;
    }
  }
  return true;
}

/** Floor value for the morning window start (4:00 AM in minutes). */
const ADAPTIVE_MORNING_FLOOR_MINUTES = 4 * 60;
/** Ceiling value for the morning window end (2:00 PM in minutes). */
const ADAPTIVE_MORNING_END_CAP_MINUTES = 14 * 60;
/** Ceiling value for the afternoon window end (8:00 PM in minutes). */
const ADAPTIVE_AFTERNOON_END_CAP_MINUTES = 20 * 60;
/** Ceiling value for the evening window end (4:00 AM next day in minutes). */
const ADAPTIVE_EVENING_END_CAP_MINUTES = 28 * 60;
/** How long before typical wake/first-active to start the morning window. */
const ADAPTIVE_LEAD_HOURS = 0.5;
/** Standard span of the morning and afternoon windows. */
const ADAPTIVE_WINDOW_SPAN_HOURS = 5;
/** How long after typical last active to end the evening window. */
const ADAPTIVE_LAST_ACTIVE_LAG_HOURS = 1;

/**
 * Compute a `LifeOpsWindowPolicy` whose boundaries are shifted to match
 * the user's actual rhythm as captured by the activity profile.
 *
 * Pure function — no runtime dependency.  If the profile has no usable
 * rhythm data the returned policy equals `DEFAULT_TIME_WINDOWS`.
 */
export function computeAdaptiveWindowPolicy(
  profile: Pick<
    ActivityProfile,
    | "typicalWakeHour"
    | "typicalFirstActiveHour"
    | "typicalLastActiveHour"
    | "typicalSleepHour"
  >,
  timezone?: string | null,
): LifeOpsWindowPolicy {
  const tz = normalizeTimeZone(timezone);

  // Determine morning start from wake or first-active data.
  const wakeSource = profile.typicalWakeHour ?? profile.typicalFirstActiveHour;
  if (wakeSource === null || wakeSource === undefined) {
    // No rhythm data — return defaults unchanged.
    return {
      timezone: tz,
      windows: DEFAULT_TIME_WINDOWS.map((w) => ({ ...w })),
    };
  }

  const morningStartMinute = Math.max(
    Math.round((wakeSource - ADAPTIVE_LEAD_HOURS) * 60),
    ADAPTIVE_MORNING_FLOOR_MINUTES,
  );

  const morningEndMinute = Math.min(
    morningStartMinute + ADAPTIVE_WINDOW_SPAN_HOURS * 60,
    ADAPTIVE_MORNING_END_CAP_MINUTES,
  );

  const afternoonStartMinute = morningEndMinute;
  const afternoonEndMinute = Math.min(
    afternoonStartMinute + ADAPTIVE_WINDOW_SPAN_HOURS * 60,
    ADAPTIVE_AFTERNOON_END_CAP_MINUTES,
  );

  const eveningStartMinute = afternoonEndMinute;

  let eveningEndMinute: number;
  if (
    profile.typicalSleepHour !== null &&
    profile.typicalSleepHour !== undefined
  ) {
    // typicalSleepHour can exceed 24 (e.g. 25 = 1 AM next day).
    eveningEndMinute = Math.min(
      Math.round(profile.typicalSleepHour * 60),
      ADAPTIVE_EVENING_END_CAP_MINUTES,
    );
  } else if (
    profile.typicalLastActiveHour !== null &&
    profile.typicalLastActiveHour !== undefined
  ) {
    eveningEndMinute = Math.min(
      Math.round(
        (profile.typicalLastActiveHour + ADAPTIVE_LAST_ACTIVE_LAG_HOURS) * 60,
      ),
      ADAPTIVE_EVENING_END_CAP_MINUTES,
    );
  } else {
    const defaultEveningWindow = DEFAULT_TIME_WINDOWS[2];
    if (!defaultEveningWindow) {
      throw new Error("[lifeops-defaults] missing default evening window");
    }
    eveningEndMinute = defaultEveningWindow.endMinute;
  }

  // Guard: evening end must be strictly after evening start.
  if (eveningEndMinute <= eveningStartMinute) {
    eveningEndMinute = eveningStartMinute + 60;
  }

  // Night wraps from evening end to morning start + 24.
  const nightStartMinute = eveningEndMinute;
  const nightEndMinute = morningStartMinute + 24 * 60;

  return {
    timezone: tz,
    windows: [
      {
        name: "morning",
        label: "Morning",
        startMinute: morningStartMinute,
        endMinute: morningEndMinute,
      },
      {
        name: "afternoon",
        label: "Afternoon",
        startMinute: afternoonStartMinute,
        endMinute: afternoonEndMinute,
      },
      {
        name: "evening",
        label: "Evening",
        startMinute: eveningStartMinute,
        endMinute: eveningEndMinute,
      },
      {
        name: "night",
        label: "Night",
        startMinute: nightStartMinute,
        endMinute: nightEndMinute,
      },
    ],
  };
}

export function normalizeWindowPolicy(
  policy: LifeOpsWindowPolicy | null | undefined,
  timeZone?: string | null,
): LifeOpsWindowPolicy {
  const fallback = resolveDefaultWindowPolicy(timeZone);
  if (!policy) return fallback;
  const timezone = normalizeTimeZone(
    policy.timezone || timeZone || fallback.timezone,
  );
  const windows = Array.isArray(policy.windows)
    ? policy.windows
        .map((window) => {
          const name = window?.name ?? "custom";
          const label =
            typeof window?.label === "string" && window.label.trim().length > 0
              ? window.label.trim()
              : name;
          const startMinute = Number(window?.startMinute);
          const endMinute = Number(window?.endMinute);
          if (!Number.isFinite(startMinute) || !Number.isFinite(endMinute)) {
            return null;
          }
          if (endMinute <= startMinute) {
            return null;
          }
          return {
            name,
            label,
            startMinute,
            endMinute,
          } satisfies LifeOpsTimeWindowDefinition;
        })
        .filter(
          (window): window is LifeOpsTimeWindowDefinition => window !== null,
        )
    : [];
  if (windows.length === 0) {
    return fallback;
  }
  return {
    timezone,
    windows,
  };
}

/**
 * Default number of recent conversation lines to include in
 * LifeOps extraction prompts. Override at runtime via
 * `ELIZA_LIFEOPS_CONTEXT_WINDOW`.
 */
const DEFAULT_LIFEOPS_CONTEXT_WINDOW = 16;

/**
 * Resolve the number of recent conversation lines to include in
 * LifeOps extraction prompts.
 *
 * Reads `ELIZA_LIFEOPS_CONTEXT_WINDOW` from the environment. Falls
 * back to {@link DEFAULT_LIFEOPS_CONTEXT_WINDOW} (16) when unset or invalid.
 */
export function resolveContextWindow(): number {
  const envValue = process.env.ELIZA_LIFEOPS_CONTEXT_WINDOW;
  if (envValue) {
    const parsed = parseInt(envValue, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_LIFEOPS_CONTEXT_WINDOW;
}
