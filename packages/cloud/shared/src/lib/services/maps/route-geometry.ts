/**
 * Bounds route geometry before it leaves Cloud. Routers can return tens of
 * thousands of points for a long route, and alternatives multiply that; the
 * phone draws and projects the line, so a few metres of tolerance is invisible.
 * Douglas-Peucker keeps both endpoints and every step coordinate, so each
 * maneuver stays on the line.
 */
import type { MapsCoordinate, MapsRouteStep } from "./contract";

/** Largest perpendicular deviation, in metres, a dropped point may have. */
export const ROUTE_GEOMETRY_TOLERANCE_METERS = 5;
/** Hard cap on points per route; the tolerance grows until a route fits. */
export const ROUTE_GEOMETRY_MAX_POINTS = 10_000;

const METERS_PER_DEGREE_LATITUDE = 110_574;
const METERS_PER_DEGREE_LONGITUDE_AT_EQUATOR = 111_320;

/** Points in metres on a flat projection around the first point; routes are local. */
function project(geometry: MapsCoordinate[]): { x: Float64Array; y: Float64Array } {
  const origin = geometry[0];
  const lonScale =
    METERS_PER_DEGREE_LONGITUDE_AT_EQUATOR * Math.cos((origin.latitude * Math.PI) / 180);
  const x = new Float64Array(geometry.length);
  const y = new Float64Array(geometry.length);
  for (let i = 0; i < geometry.length; i += 1) {
    x[i] = (geometry[i].longitude - origin.longitude) * lonScale;
    y[i] = (geometry[i].latitude - origin.latitude) * METERS_PER_DEGREE_LATITUDE;
  }
  return { x, y };
}

/** Marks the points Douglas-Peucker keeps between each pair of anchors. */
function simplify(
  { x, y }: { x: Float64Array; y: Float64Array },
  anchors: number[],
  toleranceMeters: number,
): Uint8Array {
  const keep = new Uint8Array(x.length);
  for (const index of anchors) keep[index] = 1;
  const stack: number[] = [];
  for (let i = 1; i < anchors.length; i += 1) stack.push(anchors[i - 1], anchors[i]);
  while (stack.length > 0) {
    const end = stack.pop() as number;
    const start = stack.pop() as number;
    const bx = x[end] - x[start];
    const by = y[end] - y[start];
    const lengthSquared = bx * bx + by * by;
    let farthest = -1;
    let farthestSquared = toleranceMeters * toleranceMeters;
    for (let i = start + 1; i < end; i += 1) {
      const px = x[i] - x[start];
      const py = y[i] - y[start];
      // Distance to the segment, not the infinite line, so loops are kept.
      const t =
        lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, (px * bx + py * by) / lengthSquared));
      const dx = px - t * bx;
      const dy = py - t * by;
      const distanceSquared = dx * dx + dy * dy;
      if (distanceSquared > farthestSquared) {
        farthest = i;
        farthestSquared = distanceSquared;
      }
    }
    if (farthest === -1) continue;
    keep[farthest] = 1;
    stack.push(start, farthest, farthest, end);
  }
  return keep;
}

/**
 * Returns `geometry` with points within the tolerance of the line removed. The
 * first and last points and every point a step starts at are always kept; when
 * the result is still over {@link ROUTE_GEOMETRY_MAX_POINTS}, the tolerance
 * doubles until it fits (or only those kept points remain).
 */
export function simplifyRouteGeometry(
  geometry: MapsCoordinate[],
  steps: Pick<MapsRouteStep, "coordinate">[],
): MapsCoordinate[] {
  if (geometry.length <= 2) return geometry;
  const stepPoints = new Set(
    steps.map(({ coordinate }) => `${coordinate.latitude},${coordinate.longitude}`),
  );
  const anchors: number[] = [];
  for (let i = 0; i < geometry.length; i += 1) {
    if (
      i === 0 ||
      i === geometry.length - 1 ||
      stepPoints.has(`${geometry[i].latitude},${geometry[i].longitude}`)
    )
      anchors.push(i);
  }
  const points = project(geometry);
  let tolerance = ROUTE_GEOMETRY_TOLERANCE_METERS;
  let simplified: MapsCoordinate[];
  do {
    const keep = simplify(points, anchors, tolerance);
    simplified = geometry.filter((_, index) => keep[index] === 1);
    tolerance *= 2;
  } while (simplified.length > ROUTE_GEOMETRY_MAX_POINTS && simplified.length > anchors.length);
  return simplified;
}
