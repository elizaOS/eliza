/**
 * Deterministic client-side map geometry: Google encoded-polyline decoding and
 * equirectangular projection of coordinates into an SVG viewBox. Pure functions
 * with no provider or DOM dependencies so the rendered map pane is exactly
 * reproducible in tests and audits.
 */

import type { Coordinates } from "../types.js";

/**
 * Decodes a Google encoded polyline (precision 1e-5) into coordinates.
 * Malformed input throws instead of yielding a silently truncated path.
 */
export function decodePolyline(encoded: string): Coordinates[] {
  const points: Coordinates[] = [];
  let index = 0;
  let latitude = 0;
  let longitude = 0;
  const readDelta = (): number => {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      if (index >= encoded.length) {
        throw new Error("Encoded polyline is truncated.");
      }
      byte = encoded.charCodeAt(index++) - 63;
      if (byte < 0 || byte > 63) {
        throw new Error("Encoded polyline contains an invalid character.");
      }
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (index < encoded.length) {
    latitude += readDelta();
    longitude += readDelta();
    points.push({ latitude: latitude / 1e5, longitude: longitude / 1e5 });
  }
  return points;
}

export interface ProjectedPoint {
  x: number;
  y: number;
}

/**
 * Projects coordinates into a width x height viewBox with uniform padding,
 * preserving relative geometry. A single point (or identical points) lands at
 * the center rather than dividing by a zero-sized span.
 */
export function projectToViewBox(
  points: readonly Coordinates[],
  width: number,
  height: number,
  padding: number,
): ProjectedPoint[] {
  if (points.length === 0) return [];
  const latitudes = points.map((point) => point.latitude);
  const longitudes = points.map((point) => point.longitude);
  const minLat = Math.min(...latitudes);
  const maxLat = Math.max(...latitudes);
  const minLng = Math.min(...longitudes);
  const maxLng = Math.max(...longitudes);
  const latSpan = maxLat - minLat;
  const lngSpan = maxLng - minLng;
  const innerWidth = width - padding * 2;
  const innerHeight = height - padding * 2;
  return points.map((point) => ({
    x:
      lngSpan === 0
        ? width / 2
        : padding + ((point.longitude - minLng) / lngSpan) * innerWidth,
    y:
      latSpan === 0
        ? height / 2
        : padding + ((maxLat - point.latitude) / latSpan) * innerHeight,
  }));
}
