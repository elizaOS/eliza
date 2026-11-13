import type { Maneuver, RouteStep } from "./contracts.ts";
import type { RouteProgress } from "./route-distance.ts";

/** 24px stroke icons (prototype `.i` style) for each provider-neutral maneuver. */
export const MANEUVER_ICONS: Record<Maneuver, string> = {
  depart: "M12 20V4M6 10l6-6 6 6",
  continue: "M12 20V4M6 10l6-6 6 6",
  "slight-left": "M15 21v-7L8 7M8 13V7h6",
  left: "M18 21v-8a3 3 0 0 0-3-3H5M9 6l-4 4 4 4",
  "sharp-left": "M17 21V8L7 18M7 12v6h6",
  "slight-right": "M9 21v-7l7-7M16 13V7h-6",
  right: "M6 21v-8a3 3 0 0 1 3-3h10M15 6l4 4-4 4",
  "sharp-right": "M7 21V8l10 10M17 12v6h-6",
  "keep-left": "M15 21v-6c0-2-1-3-3-5L8 6M8 11V6h5",
  "keep-right": "M9 21v-6c0-2 1-3 3-5l4-4M16 11V6h-5",
  "u-turn": "M8 21V9a4 4 0 0 1 8 0v5M13 11l3 3 3-3",
  roundabout: "M12 21v-5M12 16a4 4 0 1 1 4-4M16 12V6M13 9l3-3 3 3",
  arrive:
    "M20 10c0 6-8 11-8 11S4 16 4 10a8 8 0 1 1 16 0zM15 10a3 3 0 1 1-6 0a3 3 0 1 1 6 0z",
};
/** Steps from a provider without a maneuver still show a neutral straight arrow. */
export const maneuverIcon = (maneuver?: Maneuver) =>
  MANEUVER_ICONS[maneuver || "continue"];

/** Distance for guidance: 5 m steps below 100 m, 10 m below 1 km, then 0.1 km. */
export function guidanceDistance(meters: number): string {
  if (!Number.isFinite(meters) || meters < 0) return "";
  if (meters < 100) return `${Math.max(0, Math.round(meters / 5) * 5)} m`;
  if (meters < 1000) return `${Math.round(meters / 10) * 10} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}
export function guidanceDuration(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60));
  return minutes < 60
    ? `${minutes} min`
    : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}
/** Progress with the upcoming maneuver fixed to `index`: a maneuver counts as reached only
 * once the device has come near it, so a sparse or jumping fix never skips an instruction. */
export function atStep(
  progress: RouteProgress,
  steps: readonly RouteStep[],
  index: number,
): RouteProgress {
  const along = progress.maneuverAlongMeters;
  const next =
    index < steps.length
      ? {
          index,
          step: steps[index],
          distanceMeters: Math.max(
            0,
            (along[index] ?? progress.alongMeters) - progress.alongMeters,
          ),
        }
      : undefined;
  const then =
    index + 1 < steps.length
      ? { index: index + 1, step: steps[index + 1] }
      : undefined;
  const { next: _next, then: _then, ...rest } = progress;
  return { ...rest, ...(next ? { next } : {}), ...(then ? { then } : {}) };
}
/** Presentation of one progress reading for the navigation sheet, voice and notification. */
export function guidanceView(progress: RouteProgress, now = new Date()) {
  const next = progress.next,
    then = progress.then;
  const arrival = new Date(now.getTime() + progress.remainingSeconds * 1000);
  const clock = arrival.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  const distance = next ? guidanceDistance(next.distanceMeters) : "";
  const instruction = next?.step.instruction || "Continue to the destination";
  return {
    icon: maneuverIcon(next?.step.maneuver),
    distance,
    instruction,
    hasThen: !!then,
    thenIcon: then ? maneuverIcon(then.step.maneuver) : "",
    thenText: then?.step.instruction || "",
    remainingTime: guidanceDuration(progress.remainingSeconds),
    remaining: `${guidanceDistance(progress.remainingMeters)} · arrive ${clock} · no live traffic`,
    /** One utterance per upcoming step: the provider's own instruction text. */
    spoken: next ? instruction : "",
    notificationTitle: next ? `${distance} · ${instruction}` : instruction,
    notificationText: `${guidanceDuration(progress.remainingSeconds)} · ${guidanceDistance(progress.remainingMeters)} remaining`,
  };
}
