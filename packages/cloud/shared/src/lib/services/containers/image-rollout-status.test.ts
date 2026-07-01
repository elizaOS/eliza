/**
 * Characterization tests for the image-rollout pure helpers.
 *
 * These parse container image references and decide whether the warm pool is
 * on the desired image — the gate that protects ready-pool replacement during
 * an agent image rollout. They were untested; this pins the digest/tag pinning
 * rules and the rollout state machine so a "productionSafe" judgement or a
 * stale-row count can't drift silently.
 */

import { describe, expect, test } from "bun:test";
import {
  describeImageReference,
  imageMatchesDesired,
  type RolloutPoolRow,
  summarizeImageRollout,
} from "./image-rollout-status";

const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;
const REPO = "ghcr.io/elizaos/agent";

describe("describeImageReference — pinning + production safety", () => {
  test("a full sha256 digest is production-safe with no warning", () => {
    const r = describeImageReference(`${REPO}@${DIGEST_A}`);
    expect(r.pinning).toBe("digest");
    expect(r.digest).toBe(DIGEST_A);
    expect(r.repository).toBe(REPO);
    expect(r.productionSafe).toBe(true);
    expect(r.warning).toBeNull();
  });

  test("a malformed digest is rejected as not production-safe", () => {
    const r = describeImageReference(`${REPO}@sha256:tooshort`);
    expect(r.pinning).toBe("digest");
    expect(r.productionSafe).toBe(false);
    expect(r.warning).toMatch(/full sha256/);
  });

  test("an explicit mutable tag is not production-safe", () => {
    const r = describeImageReference(`${REPO}:v1.2.3`);
    expect(r.pinning).toBe("tag");
    expect(r.tag).toBe("v1.2.3");
    expect(r.repository).toBe(REPO);
    expect(r.productionSafe).toBe(false);
    expect(r.warning).toMatch(/mutable without a digest/);
  });

  test("no tag and no digest resolves to implicit mutable latest", () => {
    const r = describeImageReference(REPO);
    expect(r.pinning).toBe("implicit-latest");
    expect(r.tag).toBe("latest");
    expect(r.productionSafe).toBe(false);
    expect(r.warning).toMatch(/mutable latest/);
  });

  test("a registry host:port is not mistaken for a tag", () => {
    const r = describeImageReference("registry.local:5000/elizaos/agent");
    expect(r.pinning).toBe("implicit-latest");
    expect(r.repository).toBe("registry.local:5000/elizaos/agent");
    expect(r.tag).toBe("latest");
  });

  test("a registry host:port WITH a tag parses repository and tag correctly", () => {
    const r = describeImageReference("registry.local:5000/elizaos/agent:v2");
    expect(r.pinning).toBe("tag");
    expect(r.repository).toBe("registry.local:5000/elizaos/agent");
    expect(r.tag).toBe("v2");
  });

  test("digest pinning wins even when a tag is also present", () => {
    const r = describeImageReference(`${REPO}:v1@${DIGEST_A}`);
    expect(r.pinning).toBe("digest");
    expect(r.digest).toBe(DIGEST_A);
    expect(r.productionSafe).toBe(true);
  });

  test("trims surrounding whitespace", () => {
    const r = describeImageReference(`  ${REPO}@${DIGEST_A}  `);
    expect(r.reference).toBe(`${REPO}@${DIGEST_A}`);
  });
});

describe("imageMatchesDesired", () => {
  test("a null current image never matches", () => {
    expect(imageMatchesDesired(null, `${REPO}@${DIGEST_A}`)).toBe(false);
  });

  test("digest-desired matches purely by digest (repository/tag noise ignored)", () => {
    expect(imageMatchesDesired(`${REPO}@${DIGEST_A}`, `${REPO}@${DIGEST_A}`)).toBe(true);
    expect(imageMatchesDesired(`other/repo@${DIGEST_A}`, `${REPO}@${DIGEST_A}`)).toBe(true);
    expect(imageMatchesDesired(`${REPO}@${DIGEST_B}`, `${REPO}@${DIGEST_A}`)).toBe(false);
  });

  test("a tagged current image does not match a digest-desired image", () => {
    expect(imageMatchesDesired(`${REPO}:v1`, `${REPO}@${DIGEST_A}`)).toBe(false);
  });

  test("tag-desired matches by exact reference", () => {
    expect(imageMatchesDesired(`${REPO}:v1`, `${REPO}:v1`)).toBe(true);
    expect(imageMatchesDesired(`${REPO}:v2`, `${REPO}:v1`)).toBe(false);
  });
});

function row(id: string, image: string | null): RolloutPoolRow {
  return { id, docker_image: image, node_id: null, pool_ready_at: null, health_url: null };
}

const DESIRED = `${REPO}@${DIGEST_A}`;

describe("summarizeImageRollout — status state machine", () => {
  test("disabled pool short-circuits regardless of rows", () => {
    const s = summarizeImageRollout({
      desiredImage: DESIRED,
      enabled: false,
      rows: [row("a", DESIRED)],
    });
    expect(s.status).toBe("disabled");
    expect(s.safeNextAction).toBe("noop_pool_disabled");
  });

  test("an unpinned desired image is blocked from rollout", () => {
    const s = summarizeImageRollout({ desiredImage: `${REPO}:latest`, enabled: true, rows: [] });
    expect(s.status).toBe("blocked_unpinned_desired_image");
    expect(s.safeNextAction).toBe("configure_pinned_desired_image");
  });

  test("a pinned desired image with no ready rows needs replenish", () => {
    const s = summarizeImageRollout({ desiredImage: DESIRED, enabled: true, rows: [] });
    expect(s.status).toBe("no_ready_pool");
    expect(s.safeNextAction).toBe("replenish_pool");
    expect(s.counts.totalReady).toBe(0);
  });

  test("all rows on the desired image ⇒ current, no action", () => {
    const s = summarizeImageRollout({
      desiredImage: DESIRED,
      enabled: true,
      rows: [row("a", DESIRED), row("b", DESIRED)],
    });
    expect(s.status).toBe("current");
    expect(s.safeNextAction).toBe("none");
    expect(s.counts).toMatchObject({
      totalReady: 2,
      matchingDesired: 2,
      stale: 0,
      unknownImage: 0,
    });
  });

  test("a stale-image row triggers a rollout and is reported as stale", () => {
    const s = summarizeImageRollout({
      desiredImage: DESIRED,
      enabled: true,
      rows: [row("ok", DESIRED), row("old", `${REPO}@${DIGEST_B}`)],
    });
    expect(s.status).toBe("needs_rollout");
    expect(s.safeNextAction).toBe("replace_stale_pool_entries");
    expect(s.counts).toMatchObject({
      totalReady: 2,
      matchingDesired: 1,
      stale: 1,
      unknownImage: 0,
    });
    expect(s.staleRows.map((r) => r.id)).toEqual(["old"]);
  });

  test("a null-image row counts as unknown + stale", () => {
    const s = summarizeImageRollout({
      desiredImage: DESIRED,
      enabled: true,
      rows: [row("ok", DESIRED), row("mystery", null)],
    });
    expect(s.status).toBe("needs_rollout");
    expect(s.counts).toMatchObject({
      totalReady: 2,
      matchingDesired: 1,
      stale: 1,
      unknownImage: 1,
    });
    const mystery = s.staleRows.find((r) => r.id === "mystery");
    expect(mystery?.currentImage).toBeNull();
  });

  test("currentImages aggregates duplicates and sorts by image name", () => {
    const s = summarizeImageRollout({
      desiredImage: DESIRED,
      enabled: true,
      rows: [row("a", `${REPO}@${DIGEST_B}`), row("b", `${REPO}@${DIGEST_B}`), row("c", DESIRED)],
    });
    expect(s.currentImages).toHaveLength(2);
    expect(s.currentImages.map((c) => c.image)).toEqual(
      [...s.currentImages.map((c) => c.image)].sort((x, y) => x.localeCompare(y)),
    );
    const dup = s.currentImages.find((c) => c.image === `${REPO}@${DIGEST_B}`);
    expect(dup?.count).toBe(2);
  });

  test("canary stays unsupported; rollback is an operator-gated supported action", () => {
    const s = summarizeImageRollout({
      desiredImage: DESIRED,
      enabled: true,
      rows: [row("a", DESIRED)],
    });
    // canary remains unsupported until cohort routing + health gates exist.
    expect(s.unsupportedActions.map((a) => a.action)).toEqual(["canary"]);
    // rollback is now supported but never automatic — it is operator-gated and
    // backed by the persisted previous_image_digest / executeDowngrade.
    expect(s.supportedActions.map((a) => a.action)).toEqual(["rollback"]);
    expect(s.supportedActions[0]?.requiresOperatorApproval).toBe(true);
  });
});
