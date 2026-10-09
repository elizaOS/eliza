/**
 * Pure admission policy for the managed daily dossier. Proposed metadata must
 * be committed through the canonical task store's compare-and-swap boundary.
 * Trusted activity comes from authenticated server ingress, never signal metadata.
 */
import { ElizaError, stableStringify } from "@elizaos/core";
import type { ScheduledTask } from "@elizaos/plugin-scheduling";
import { z } from "zod";
import {
  addDaysToLocalDate,
  getLocalDateKey,
  getZonedDateParts,
} from "../time.js";

export const DOSSIER_ACTIVITY_METADATA_KEY = "dossierActivity";
export const DOSSIER_ACTIVITY_ANCHOR_KEY = "dossier.owner_activity";

const iso = z.iso.datetime({ offset: true });
const dayKey = z.iso.date();
const daySchema = z
  .object({
    timezone: z.string().min(1),
    boundaryMinutes: z.number().int().min(0).max(1439),
  })
  .strict();
const stateSchema = z
  .object({
    version: z.literal(1),
    generation: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    enabled: z.boolean(),
    enabledAtIso: iso,
    day: daySchema,
    admitted: z
      .object({
        dayKey,
        atIso: iso,
        signalId: z.string().min(1),
        principalId: z.string().min(1),
      })
      .strict()
      .nullable(),
    consumedDay: dayKey.nullable(),
  })
  .strict();

export type DossierDay = z.infer<typeof daySchema>;
export type DossierActivityState = z.infer<typeof stateSchema>;
export type DossierActivityTask = Pick<
  ScheduledTask,
  "idempotencyKey" | "source" | "trigger" | "state" | "metadata"
>;

/** Construct this only after server-side principal and event validation. */
export interface TrustedDossierActivity {
  authenticated: boolean;
  principalId: string;
  ownerPrincipalId: string;
  receivedAtIso: string;
  signalId: string;
  kind: "foreground" | "unlock" | "other";
}

function invalid(message: string): never {
  throw new ElizaError(message, { code: "DOSSIER_ACTIVITY_STATE_INVALID" });
}

function instant(value: string): Date {
  if (!iso.safeParse(value).success)
    invalid("Dossier activity requires an ISO timestamp");
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()))
    invalid("Dossier activity timestamp is invalid");
  return date;
}

/** Configured civil day, independent of the health domain's inferred sleep/wake day. */
export function dossierOwnerDay(atIso: string, day: DossierDay): string {
  if (!daySchema.safeParse(day).success)
    invalid("Dossier owner-day configuration is invalid");
  const date = instant(atIso);
  try {
    // Validate before the canonical helper's compatibility normalization; an
    // invalid persisted zone must not silently become the deployment zone.
    new Intl.DateTimeFormat("en-US", { timeZone: day.timezone });
    const parts = getZonedDateParts(date, day.timezone);
    const beforeBoundary =
      (parts.hour % 24) * 60 + parts.minute < day.boundaryMinutes;
    return getLocalDateKey(
      beforeBoundary ? addDaysToLocalDate(parts, -1) : parts,
    );
  } catch (cause) {
    // error-policy:J2 Preserve invalid timezone context at the policy boundary.
    throw new ElizaError("Dossier owner timezone is invalid", {
      code: "DOSSIER_ACTIVITY_TIMEZONE_INVALID",
      cause,
      context: { timezone: day.timezone },
    });
  }
}

/** Recognize only the two existing managed identities, not matching prose. */
export function isManagedDossierTask(task: DossierActivityTask): boolean {
  return (
    (task.source === "first_run" &&
      task.idempotencyKey === "lifeops:first-run:default:morning-brief") ||
    (task.source === "default_pack" &&
      task.idempotencyKey === "default-pack:morning-brief:assembler")
  );
}

export function readDossierActivityState(
  metadata: ScheduledTask["metadata"],
): DossierActivityState | null {
  if (!metadata || !Object.hasOwn(metadata, DOSSIER_ACTIVITY_METADATA_KEY))
    return null;
  const parsed = stateSchema.safeParse(metadata[DOSSIER_ACTIVITY_METADATA_KEY]);
  if (!parsed.success)
    invalid("Persisted dossier activity metadata is malformed");
  const state = parsed.data;
  dossierOwnerDay(state.enabledAtIso, state.day);
  if (
    state.admitted &&
    (!state.enabled ||
      instant(state.admitted.atIso).getTime() <
        instant(state.enabledAtIso).getTime() ||
      dossierOwnerDay(state.admitted.atIso, state.day) !==
        state.admitted.dayKey ||
      (state.consumedDay !== null &&
        state.admitted.dayKey <= state.consumedDay))
  ) {
    invalid(
      "Persisted dossier activity admission contradicts its control state",
    );
  }
  return state;
}

/** Called inside the same conditional write as an edit/dismiss/reopen or migration. */
export function updateDossierActivityControl(args: {
  previous: DossierActivityTask | null;
  next: DossierActivityTask;
  nowIso: string;
  day: DossierDay;
}): DossierActivityState | null {
  if (!isManagedDossierTask(args.next)) return null;
  dossierOwnerDay(args.nowIso, args.day);
  const prior = readDossierActivityState(args.previous?.metadata);
  const enabled =
    args.next.trigger.kind !== "manual" &&
    args.next.state.status !== "dismissed";
  const reopened =
    args.next.state.status === "scheduled" &&
    args.previous !== null &&
    ["completed", "failed", "skipped", "expired", "dismissed"].includes(
      args.previous.state.status,
    );
  if (
    prior &&
    !reopened &&
    prior.enabled === enabled &&
    prior.day.timezone === args.day.timezone &&
    prior.day.boundaryMinutes === args.day.boundaryMinutes &&
    stableStringify(args.previous?.trigger) ===
      stableStringify(args.next.trigger)
  )
    return prior;
  const generation = prior ? prior.generation + 1 : 1;
  if (!Number.isSafeInteger(generation))
    invalid("Dossier enable generation is exhausted");
  return {
    version: 1,
    generation,
    enabled,
    enabledAtIso: args.nowIso,
    day: { ...args.day },
    admitted: null,
    consumedDay: prior?.consumedDay ?? null,
  };
}

/** Returns a proposal; racing devices must retry against the committed task state. */
export function admitDossierActivity(
  state: DossierActivityState,
  activity: TrustedDossierActivity,
): DossierActivityState {
  if (
    !state.enabled ||
    !activity.authenticated ||
    !activity.principalId ||
    activity.principalId !== activity.ownerPrincipalId ||
    activity.kind === "other"
  )
    return state;
  if (!activity.signalId)
    invalid("Trusted dossier activity requires a signal identity");
  const receivedAt = instant(activity.receivedAtIso);
  if (receivedAt.getTime() < instant(state.enabledAtIso).getTime())
    return state;
  const day = dossierOwnerDay(activity.receivedAtIso, state.day);
  if (
    (state.consumedDay !== null && day <= state.consumedDay) ||
    (state.admitted !== null && day <= state.admitted.dayKey)
  )
    return state;
  return {
    ...state,
    admitted: {
      dayKey: day,
      atIso: activity.receivedAtIso,
      signalId: activity.signalId,
      principalId: activity.principalId,
    },
  };
}

export function resolveDossierActivityAnchor(
  state: DossierActivityState,
  nowIso: string,
): string | null {
  if (
    !state.enabled ||
    !state.admitted ||
    state.admitted.dayKey !== dossierOwnerDay(nowIso, state.day) ||
    instant(state.admitted.atIso).getTime() > instant(nowIso).getTime()
  )
    return null;
  return state.admitted.atIso;
}

/** Commit with the automatic fire claim, not with manual refresh or a read. */
export function consumeDossierActivity(
  state: DossierActivityState,
  nowIso: string,
): DossierActivityState {
  if (!resolveDossierActivityAnchor(state, nowIso) || !state.admitted) {
    invalid("Dossier automatic fire requires a current activity admission");
  }
  return { ...state, consumedDay: state.admitted.dayKey, admitted: null };
}
