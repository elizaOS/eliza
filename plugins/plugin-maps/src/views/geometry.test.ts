/**
 * Deterministic unit coverage for polyline decoding and viewBox projection —
 * pure functions, no mocks.
 */

import { describe, expect, it } from "vitest";
import { decodePolyline, projectToViewBox } from "./geometry.js";

describe("decodePolyline", () => {
  it("decodes the canonical Google example", () => {
    expect(decodePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@")).toEqual([
      { latitude: 38.5, longitude: -120.2 },
      { latitude: 40.7, longitude: -120.95 },
      { latitude: 43.252, longitude: -126.453 },
    ]);
  });

  it("returns an empty path for an empty string", () => {
    expect(decodePolyline("")).toEqual([]);
  });

  it("throws on truncated input instead of yielding a partial path", () => {
    expect(() => decodePolyline("_p~iF")).toThrow(/truncated/);
  });

  it("throws on characters outside the polyline alphabet", () => {
    expect(() => decodePolyline("!!")).toThrow(/invalid character/);
  });
});

describe("projectToViewBox", () => {
  it("maps the bounding box corners onto the padded viewBox", () => {
    const projected = projectToViewBox(
      [
        { latitude: 0, longitude: 0 },
        { latitude: 10, longitude: 20 },
      ],
      100,
      60,
      10,
    );
    // North (higher latitude) renders toward the top of the SVG.
    expect(projected).toEqual([
      { x: 10, y: 50 },
      { x: 90, y: 10 },
    ]);
  });

  it("centers a single point instead of dividing by a zero span", () => {
    expect(
      projectToViewBox([{ latitude: 5, longitude: 5 }], 100, 60, 10),
    ).toEqual([{ x: 50, y: 30 }]);
  });

  it("returns an empty projection for no points", () => {
    expect(projectToViewBox([], 100, 60, 10)).toEqual([]);
  });
});
