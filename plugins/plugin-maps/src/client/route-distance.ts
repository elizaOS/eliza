import type { Coordinate, RouteStep } from "./contracts.ts";

const radians = Math.PI / 180;
const earthRadius = 6371000;
function angle(a: Coordinate, b: Coordinate): number {
  const lat = (b.latitude - a.latitude) * radians;
  const lon = (b.longitude - a.longitude) * radians;
  return (
    2 *
    Math.asin(
      Math.min(
        1,
        Math.sqrt(
          Math.sin(lat / 2) ** 2 +
            Math.cos(a.latitude * radians) *
              Math.cos(b.latitude * radians) *
              Math.sin(lon / 2) ** 2,
        ),
      ),
    )
  );
}
function bearing(a: Coordinate, b: Coordinate): number {
  const latA = a.latitude * radians,
    latB = b.latitude * radians;
  const lon = (b.longitude - a.longitude) * radians;
  return Math.atan2(
    Math.sin(lon) * Math.cos(latB),
    Math.cos(latA) * Math.sin(latB) -
      Math.sin(latA) * Math.cos(latB) * Math.cos(lon),
  );
}
/** Distance to the nearest point on the route's bounded great-circle segments. */
export function distanceToRoute(
  point: Coordinate,
  geometry: readonly Coordinate[],
): number {
  let nearest = Infinity;
  for (let i = 0; i < geometry.length; i++) {
    const start = geometry[i],
      fromStart = angle(start, point);
    nearest = Math.min(nearest, fromStart);
    if (i + 1 === geometry.length) continue;
    const end = geometry[i + 1],
      length = angle(start, end);
    // Coincident and antipodal endpoints do not define a unique segment.
    if (length < 1e-12 || Math.PI - length < 1e-12) continue;
    const deltaBearing = bearing(start, point) - bearing(start, end);
    const along = Math.atan2(
      Math.sin(fromStart) * Math.cos(deltaBearing),
      Math.cos(fromStart),
    );
    if (along >= 0 && along <= length) {
      const cross = Math.asin(
        Math.max(-1, Math.min(1, Math.sin(fromStart) * Math.sin(deltaBearing))),
      );
      nearest = Math.min(nearest, Math.abs(cross));
    }
  }
  return nearest * earthRadius;
}

export type RouteGeometry = Readonly<{
  geometry: readonly Coordinate[];
  steps: readonly RouteStep[];
  durationSeconds: number;
}>;
export type RouteProgress = Readonly<{
  /** Distance from the point to the nearest position on the route line. */
  offRouteMeters: number;
  /** Distance travelled along the route line at that nearest position. */
  alongMeters: number;
  remainingMeters: number;
  /** Provider duration scaled by the remaining share of distance (no live traffic). */
  remainingSeconds: number;
  /** Index of the step currently being travelled. */
  stepIndex: number;
  /** Where each step's maneuver lies along the line, in metres from its start. */
  maneuverAlongMeters: readonly number[];
  /** The upcoming maneuver and the distance along the route to it. */
  next?: Readonly<{ index: number; step: RouteStep; distanceMeters: number }>;
  /** The maneuver after `next`, if any. */
  then?: Readonly<{ index: number; step: RouteStep }>;
}>;
type Projection = { distance: number; along: number };
/** Nearest position on the line at or beyond `minimumAlong` metres from its start. */
function project(
  point: Coordinate,
  line: readonly Coordinate[],
  lengths: readonly number[],
  minimumAlong = 0,
): Projection {
  let best: Projection = {
    distance:
      lengths.length || !line.length
        ? Infinity
        : angle(line[0], point) * earthRadius,
    along: 0,
  };
  let travelled = 0;
  for (let i = 0; i < lengths.length; i++) {
    const length = lengths[i];
    if (travelled + length >= minimumAlong) {
      const start = line[i],
        end = line[i + 1];
      const arc = length / earthRadius;
      const minimum = Math.max(
        0,
        Math.min(arc, (minimumAlong - travelled) / earthRadius),
      );
      // Coincident or antipodal endpoints do not define a unique great-circle arc.
      if (arc < 1e-12 || Math.PI - arc < 1e-12) {
        for (const [endpoint, offset] of [
          [start, 0],
          [end, length],
        ] as const) {
          if (travelled + offset < minimumAlong) continue;
          const distance = angle(endpoint, point) * earthRadius;
          if (distance < best.distance)
            best = { distance, along: travelled + offset };
        }
        travelled += length;
        continue;
      }
      const fromStart = angle(start, point);
      const deltaBearing = bearing(start, point) - bearing(start, end);
      const along = Math.max(
        minimum,
        Math.min(
          arc,
          Math.atan2(
            Math.sin(fromStart) * Math.cos(deltaBearing),
            Math.cos(fromStart),
          ),
        ),
      );
      for (const candidateAlong of [minimum, along, arc]) {
        const t = candidateAlong / arc;
        // Spherical interpolation preserves the short arc across the date line and poles.
        const a = Math.sin(arc - candidateAlong) / Math.sin(arc);
        const b = Math.sin(candidateAlong) / Math.sin(arc);
        const latA = start.latitude * radians,
          lonA = start.longitude * radians;
        const latB = end.latitude * radians,
          lonB = end.longitude * radians;
        const x =
          a * Math.cos(latA) * Math.cos(lonA) +
          b * Math.cos(latB) * Math.cos(lonB);
        const y =
          a * Math.cos(latA) * Math.sin(lonA) +
          b * Math.cos(latB) * Math.sin(lonB);
        const z = a * Math.sin(latA) + b * Math.sin(latB);
        const projected = {
          latitude: Math.atan2(z, Math.hypot(x, y)) / radians,
          longitude: Math.atan2(y, x) / radians,
        };
        const distance = angle(projected, point) * earthRadius;
        if (distance < best.distance)
          best = { distance, along: travelled + t * length };
      }
    }
    travelled += length;
  }
  return best;
}
/** Locate a point on a route: nearest position, distance along it, and the next two maneuvers.
 * Each step's maneuver is placed where its coordinate meets the line, in route order. */
export function routeProgress(
  point: Coordinate,
  route: RouteGeometry,
): RouteProgress {
  const line = route.geometry;
  const lengths: number[] = [];
  let total = 0;
  for (let i = 0; i + 1 < line.length; i++) {
    const length = angle(line[i], line[i + 1]) * earthRadius;
    lengths.push(length);
    total += length;
  }
  const here = project(point, line, lengths);
  const along = here.along;
  // Maneuvers never move backwards along the line, so a route that revisits a
  // street still orders its steps correctly.
  const starts: number[] = [];
  for (const step of route.steps)
    starts.push(
      project(step.coordinate, line, lengths, starts.at(-1) ?? 0).along,
    );
  // A maneuver counts as reached within a metre, absorbing projection rounding.
  let stepIndex = 0;
  for (let i = 0; i < starts.length; i++)
    if (starts[i] <= along + 1) stepIndex = i;
  const remainingMeters = Math.max(0, total - along);
  const nextIndex = stepIndex + 1;
  const next =
    nextIndex < route.steps.length
      ? {
          index: nextIndex,
          step: route.steps[nextIndex],
          distanceMeters: Math.max(0, starts[nextIndex] - along),
        }
      : undefined;
  const then =
    nextIndex + 1 < route.steps.length
      ? { index: nextIndex + 1, step: route.steps[nextIndex + 1] }
      : undefined;
  return {
    offRouteMeters: here.distance,
    alongMeters: along,
    remainingMeters,
    remainingSeconds:
      total > 0 ? (route.durationSeconds * remainingMeters) / total : 0,
    stepIndex,
    maneuverAlongMeters: starts,
    ...(next ? { next } : {}),
    ...(then ? { then } : {}),
  };
}
