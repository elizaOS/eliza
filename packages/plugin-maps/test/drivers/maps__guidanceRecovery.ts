// spec/maps/guidanceRecovery.md, "Story: Move on to the next step only when I have really passed the turn"
import type { Driver, Options } from "../../gen/maps__guidanceRecovery.conformance.ts";
import type { GuidanceProgress } from "../../gen/maps__guidanceRecovery.ts";
import { advanceStep, type StepHold } from "@elizaos/plugin-maps-client";
import { routeProgress } from "@elizaos/plugin-maps-client";

type View = Pick<GuidanceProgress, "step" | "cleared">;

const start = { latitude: 37.7946, longitude: -122.3999 };
const turn = { latitude: 37.7986, longitude: -122.3999 };
const end = { latitude: 37.7986, longitude: -122.3899 };
const past = { latitude: 37.7986, longitude: -122.3969 };
const route = { geometry: [start, turn, end], durationSeconds: 600, steps: [
  { instruction: "Turn right", coordinate: turn, distanceMeters: 880, maneuver: "right" as const },
  { instruction: "Arrive", coordinate: end, distanceMeters: 0, maneuver: "arrive" as const },
] };

const holds = new Map<string, StepHold>();
const holdOf = (key: string): StepHold => holds.get(key) ?? { index: 0, cleared: 0 };

export const driver: Driver<View> = {
  reset() {
    holds.clear();
  },
  dispatch(key, event) {
    const hold = holdOf(key);
    if (hold.index >= route.steps.length - 1) return "refused";
    const at = event.type === "nearPosition" ? turn : past;
    const fix = { coordinate: at, accuracyMeters: 5 };
    holds.set(key, advanceStep(hold, route, routeProgress(at, route), fix, event.type !== "resetEvidence"));
    return "accepted";
  },
  observe(key) {
    const hold = holdOf(key);
    return { step: hold.index >= route.steps.length - 1 ? "ArrivalStep" : "PendingManeuver", cleared: hold.cleared };
  },
};

export const options: Options<View> = { view: ({ step, cleared }) => ({ step, cleared }), keys: ["route"] };
