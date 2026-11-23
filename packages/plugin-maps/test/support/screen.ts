// spec/maps/navigation.md, "Story: Plan directions and keep me in control of guidance"
import { Effect } from "effect";
import { MapsFailure, type Coordinate, type Place, type ProviderConfig, type Route, type TravelMode } from "../../src/client/contracts.vibe";
import { deviceMapsNavigation, type ActiveGuidance, type DeviceMapsNavigation, type MapsNavigationSurface, type RoutePlanReceipt } from "../../src/client/device-navigation.vibe";
import type { Position } from "../../src/client/location.vibe";
import { gate, type Gate } from "./gates.ts";

const here = { latitude: 37.7946, longitude: -122.3999 };
const config: ProviderConfig = { status: "configured", providerId: "google", connectionId: "conn_0123456789abcdef", revision: "2026-11", capabilities: {
  map: false, search: true, placeDetails: true, modes: ["drive", "walk", "bicycle", "transit"], traffic: "live", transit: "scheduled",
  offline: { map: false, search: false, routing: false }, alternatives: true,
} };

/** Where a named test destination lies. */
export function coordinateOf(name: string): Coordinate {
  const code = [...name].reduce((sum, character) => sum + character.charCodeAt(0), 0) % 100;
  return { latitude: 37.7 + code / 1000, longitude: -122.4 + code / 1000 };
}

/** A route the screen planned to `to` by `mode`. */
export function routeTo(id: string, to: Coordinate, mode: TravelMode): Route {
  return {
    providerId: "google", id, from: here, to, mode, geometry: [here, to], distanceMeters: 1000, durationSeconds: 600,
    steps: [], attribution: "Google", fetchedAt: Date.now(), traffic: "live",
  };
}

/** A device fix of the given age, accuracy and precision. */
export function positionOf(age: number, accuracy: number, precise: boolean): Position {
  const beyond = age > 30_000 ? age + 1_000 : age < -5_000 ? age - 1_000 : age;
  return { coordinate: here, accuracyMeters: accuracy, timestamp: Date.now() - beyond, precision: precise ? "precise" : "approximate" };
}

/** The Maps screen as a driver holds it: each answer the screen gives the agent waits for the driver. */
export function heldScreen() {
  const shown: { place?: Place; mode: TravelMode; revision: number; route?: Route; guidance: ActiveGuidance | null } = { mode: "drive", revision: 1, guidance: null };
  const grants: Gate<boolean, never>[] = [];
  const fixes: Gate<Position, MapsFailure>[] = [];
  const plans: Gate<Route | undefined, never>[] = [];
  const reroutes: Gate<RoutePlanReceipt | undefined, MapsFailure>[] = [];
  const held = <A, E>(list: Gate<A, E>[]) => {
    const next = gate<A, E>();
    list.push(next);
    return next.wait;
  };
  const surface: MapsNavigationSurface = {
    present: () => Effect.succeed(true),
    snapshot: () => ({
      provider: config,
      selection: shown.place === undefined ? { phase: "idle", value: null, error: null } : { phase: "ready", value: shown.place, error: null },
      route: shown.route === undefined ? { phase: "idle", value: null, error: null } : { phase: "ready", value: shown.route, error: null },
      revision: shown.revision,
      mode: shown.mode,
    }),
    showPlace: (place) => Effect.sync(() => { shown.place = place; }),
    showDirections: (place, mode) => Effect.sync(() => {
      shown.place = place;
      shown.mode = mode;
      shown.route = undefined;
    }),
    locationGranted: () => held(grants),
    locate: () => held(fixes),
    planFrom: () => Effect.map(held(plans), (route) => { shown.route = route; }),
    guidance: () => shown.guidance,
    reroute: () => held(reroutes),
    stop: () => Effect.sync(() => { shown.guidance = null; }),
  };
  const phone: DeviceMapsNavigation = Effect.runSync(deviceMapsNavigation(surface, { providerId: "google", attribution: "Google", current: () => true }, "10 seconds"));
  return { phone, shown, grants, fixes, plans, reroutes };
}

/** One held Maps screen. */
export type HeldScreen = ReturnType<typeof heldScreen>;
