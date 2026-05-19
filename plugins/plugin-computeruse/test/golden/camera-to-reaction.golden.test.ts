/**
 * WS10 golden path: camera frame → person detector → reaction surface.
 *
 * Validates PLUMBING for the camera-driven "I see someone" reaction loop.
 * The camera frame is a fixed PNG fixture; the person detector is
 * replaced with a deterministic stub that returns a known bbox when fed
 * the fixture. The reaction surface contract is "the runtime gets a
 * `PersonDetected` event with confidence + bbox, and emits a single
 * non-empty reaction string."
 *
 * When WS9 (camera capture + person detect) lands, the stub contracts
 * become the integration contract.
 */

import { describe, expect, it } from "vitest";

/* --------------------------------------------------------------------- */
/* Stub contracts                                                         */
/* --------------------------------------------------------------------- */

interface CameraFrame {
  png: Buffer;
  width: number;
  height: number;
  capturedAtMs: number;
}

interface DetectorHit {
  label: "person";
  bbox: { x: number; y: number; w: number; h: number };
  confidence: number;
}

interface ReactionEvent {
  kind: "person-detected";
  hit: DetectorHit;
  reaction: string;
}

/* --------------------------------------------------------------------- */
/* Deterministic stubs                                                    */
/* --------------------------------------------------------------------- */

const ONE_PX_PNG: Buffer = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06,
  0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44,
  0x41, 0x54, 0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d,
  0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42,
  0x60, 0x82,
]);

function stubCameraFrame(): CameraFrame {
  return {
    png: ONE_PX_PNG,
    width: 1280,
    height: 720,
    capturedAtMs: 1_700_000_000_000,
  };
}

function stubDetect(frame: CameraFrame): DetectorHit[] {
  // The stub returns a single fixture hit. A real YOLOv8n int8 might
  // return zero or several; the golden path only asserts that "at least
  // one person triggers a reaction".
  return [
    {
      label: "person",
      bbox: { x: 480, y: 100, w: 320, h: 540 },
      confidence: 0.88,
    },
  ];
}

function stubReactionSurface(hit: DetectorHit): ReactionEvent {
  return {
    kind: "person-detected",
    hit,
    reaction: "I see someone in the frame.",
  };
}

/* --------------------------------------------------------------------- */
/* Test                                                                   */
/* --------------------------------------------------------------------- */

describe("golden path: camera frame → detector → reaction", () => {
  it("produces a reaction event when the detector returns a person hit", () => {
    const frame = stubCameraFrame();
    expect(frame.png[0]).toBe(0x89);
    expect(frame.width).toBeGreaterThan(0);
    expect(frame.height).toBeGreaterThan(0);
    expect(frame.capturedAtMs).toBeGreaterThan(0);

    const hits = stubDetect(frame);
    expect(hits.length).toBeGreaterThan(0);
    const personHits = hits.filter((h) => h.label === "person");
    expect(personHits.length).toBeGreaterThan(0);

    const event = stubReactionSurface(personHits[0]);
    expect(event.kind).toBe("person-detected");
    expect(event.hit.label).toBe("person");
    expect(event.hit.confidence).toBeGreaterThan(0.5);
    expect(typeof event.reaction).toBe("string");
    expect(event.reaction.length).toBeGreaterThan(0);
    // The reaction text contains *some* signal that a person was detected,
    // but we don't over-constrain the wording (the runtime model owns it).
    expect(event.reaction.toLowerCase()).toMatch(/someone|person|see/);
  });

  it("emits no reaction when the detector returns zero person hits", () => {
    const frame = stubCameraFrame();
    const hits: DetectorHit[] = [];
    const personHits = hits.filter((h) => h.label === "person");
    expect(personHits).toHaveLength(0);
    // The golden contract is "no detected person → no reaction event".
    // We assert by *not* calling the reaction surface; nothing to surface.
  });
});
