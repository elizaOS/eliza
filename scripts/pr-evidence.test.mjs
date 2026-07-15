/**
 * Tests for the pr-evidence uploader's release-selection logic — the pure rule
 * that decides which `pr-evidence`/`pr-evidence-N` release receives an upload
 * once GitHub's 1000-asset cap forces overflow. Deterministic: the selection
 * function takes an observed release list, so no network or `gh` is touched.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ASSET_CAPACITY_THRESHOLD,
  MAX_ASSETS_PER_RELEASE,
  prEvidenceReleaseIndex,
  prEvidenceTagForIndex,
  selectPrEvidenceTarget,
} from "./pr-evidence.mjs";

describe("pr-evidence tag <-> sequence index", () => {
  it("maps the primary tag to index 1 and overflow tags to their number", () => {
    assert.equal(prEvidenceReleaseIndex("pr-evidence"), 1);
    assert.equal(prEvidenceReleaseIndex("pr-evidence-2"), 2);
    assert.equal(prEvidenceReleaseIndex("pr-evidence-10"), 10);
  });

  it("rejects non-family tags and the ambiguous pr-evidence-1", () => {
    assert.equal(prEvidenceReleaseIndex("pr-evidence-1"), null);
    assert.equal(prEvidenceReleaseIndex("pr-evidence-x"), null);
    assert.equal(prEvidenceReleaseIndex("v2.0.0"), null);
    assert.equal(prEvidenceReleaseIndex(""), null);
    assert.equal(prEvidenceReleaseIndex(undefined), null);
  });

  it("round-trips index -> tag", () => {
    assert.equal(prEvidenceTagForIndex(1), "pr-evidence");
    assert.equal(prEvidenceTagForIndex(2), "pr-evidence-2");
    assert.equal(prEvidenceTagForIndex(7), "pr-evidence-7");
    // Defensive: index 0 / negative collapse to the primary tag.
    assert.equal(prEvidenceTagForIndex(0), "pr-evidence");
  });
});

describe("selectPrEvidenceTarget", () => {
  const BELOW = ASSET_CAPACITY_THRESHOLD - 100; // comfortably has room
  const FULL = MAX_ASSETS_PER_RELEASE; // hard cap reached

  it("uploads to the primary release while it has room", () => {
    assert.deepEqual(
      selectPrEvidenceTarget([{ tag: "pr-evidence", count: BELOW }], 3),
      {
        tag: "pr-evidence",
        create: false,
      },
    );
  });

  it("packs into the highest-indexed existing release that has room", () => {
    const releases = [
      { tag: "pr-evidence", count: BELOW },
      { tag: "pr-evidence-2", count: BELOW },
      { tag: "pr-evidence-3", count: BELOW },
    ];
    assert.deepEqual(selectPrEvidenceTarget(releases, 2), {
      tag: "pr-evidence-3",
      create: false,
    });
  });

  it("skips a full primary to the existing overflow release with capacity", () => {
    const releases = [
      { tag: "pr-evidence", count: FULL },
      { tag: "pr-evidence-2", count: BELOW },
    ];
    assert.deepEqual(selectPrEvidenceTarget(releases, 4), {
      tag: "pr-evidence-2",
      create: false,
    });
  });

  it("creates pr-evidence-2 when only the full primary exists", () => {
    assert.deepEqual(
      selectPrEvidenceTarget([{ tag: "pr-evidence", count: FULL }], 1),
      {
        tag: "pr-evidence-2",
        create: true,
      },
    );
  });

  it("creates the next tag when every existing release is full", () => {
    const releases = [
      { tag: "pr-evidence", count: FULL },
      { tag: "pr-evidence-2", count: FULL },
    ];
    assert.deepEqual(selectPrEvidenceTarget(releases, 1), {
      tag: "pr-evidence-3",
      create: true,
    });
  });

  it("treats a release at/over the headroom threshold as having no room", () => {
    const releases = [{ tag: "pr-evidence", count: ASSET_CAPACITY_THRESHOLD }];
    assert.deepEqual(selectPrEvidenceTarget(releases, 1), {
      tag: "pr-evidence-2",
      create: true,
    });
  });

  it("rolls over when a large batch would exceed the hard cap even below threshold", () => {
    // Under the soft threshold, but the batch itself would push past 1000.
    const count = ASSET_CAPACITY_THRESHOLD - 5; // < threshold, so threshold alone allows it
    const neededSlots = 20; // count + neededSlots > MAX_ASSETS_PER_RELEASE
    assert.ok(count < ASSET_CAPACITY_THRESHOLD);
    assert.ok(count + neededSlots > MAX_ASSETS_PER_RELEASE);
    assert.deepEqual(
      selectPrEvidenceTarget([{ tag: "pr-evidence", count }], neededSlots),
      { tag: "pr-evidence-2", create: true },
    );
  });

  it("ignores non-family releases entirely", () => {
    const releases = [
      { tag: "v2.0.0-beta.1", count: 5 },
      { tag: "pr-evidence", count: BELOW },
    ];
    assert.deepEqual(selectPrEvidenceTarget(releases, 1), {
      tag: "pr-evidence",
      create: false,
    });
  });

  it("creates the primary when no pr-evidence release exists yet", () => {
    assert.deepEqual(selectPrEvidenceTarget([], 1), {
      tag: "pr-evidence",
      create: true,
    });
    assert.deepEqual(selectPrEvidenceTarget([{ tag: "v1.0.0", count: 1 }], 1), {
      tag: "pr-evidence",
      create: true,
    });
  });
});
