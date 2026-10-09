import type { Coordinate } from "./contracts.ts";

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
