/**
 * Verifies manifest schema, referential integrity, fixture safety, canonical
 * hashing, deterministic seeds, and declarative overlays in-process.
 */
import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  DeterministicRandom,
  payloadHash,
  stableFixtureId,
} from "./canonical.ts";
import { parseWorldManifest, UnsafeFixtureError } from "./manifest.ts";
import { applyWorldOverlay } from "./overlay.ts";
import { testManifest } from "./test-fixture.ts";

describe("synthetic-world manifest", () => {
  it("validates a complete shared-domain world", () => {
    const parsed = parseWorldManifest(testManifest());
    expect(parsed.data.messages).toHaveLength(1);
    expect(parsed.data.backgroundJobs).toHaveLength(1);
  });

  it("rejects unknown references and duplicate stable IDs", () => {
    const manifest = testManifest();
    manifest.data.messages.push({
      ...manifest.data.messages[0],
      roomId: "missing",
    });
    expect(() => parseWorldManifest(manifest)).toThrow(
      /duplicate id message-one/,
    );
    expect(() => parseWorldManifest(manifest)).toThrow(
      /unknown reference missing/,
    );
  });

  it("rejects unsafe PII, URLs, and credential-like values", () => {
    const manifest = testManifest();
    manifest.data.identities[0].email = "person@production.example.org";
    manifest.data.identities[0].phone = "+1-415-867-5309";
    manifest.data.extensions = {
      apiKey: "secret-production-value",
      url: "https://production.example.org/data",
    };
    expect(() => parseWorldManifest(manifest)).toThrow(UnsafeFixtureError);
    expect(() => parseWorldManifest(manifest)).toThrow(
      /email domain is not allowed/,
    );
    expect(() => parseWorldManifest(manifest)).toThrow(
      /reserved 555 synthetic number/,
    );
    expect(() => parseWorldManifest(manifest)).toThrow(
      /credential-like fields/,
    );
  });

  it("canonicalizes object keys and reproduces seeded values", () => {
    expect(canonicalJson({ z: 1, a: { y: true, b: false } })).toBe(
      '{"a":{"b":false,"y":true},"z":1}',
    );
    expect(payloadHash({ b: 2, a: 1 })).toBe(payloadHash({ a: 1, b: 2 }));
    expect(stableFixtureId("world", "message", "one")).toBe(
      stableFixtureId("world", "message", "one"),
    );
    const first = new DeterministicRandom("seed");
    const second = new DeterministicRandom("seed");
    expect([first.next(), first.integer(1, 10)]).toEqual([
      second.next(),
      second.integer(1, 10),
    ]);
  });

  it("merges overlay entities by stable ID without mutating the base", () => {
    const base = testManifest();
    const overlaid = applyWorldOverlay(base, {
      data: {
        tasks: [
          { ...base.data.tasks[0], status: "completed" },
          {
            id: "task-two",
            ownerIdentityId: "person-peer",
            title: "Review",
            status: "pending",
          },
        ],
      },
    });
    expect(base.data.tasks[0].status).toBe("pending");
    expect(overlaid.data.tasks).toMatchObject([
      { id: "task-one", status: "completed" },
      { id: "task-two", status: "pending" },
    ]);
  });
});
