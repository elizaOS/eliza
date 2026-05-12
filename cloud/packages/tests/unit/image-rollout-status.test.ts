import { describe, expect, test } from "bun:test";
import {
  describeImageReference,
  imageMatchesDesired,
  summarizeImageRollout,
} from "@/lib/services/containers/image-rollout-status";

describe("image rollout status", () => {
  const digest = `sha256:${"a".repeat(64)}`;
  const oldDigest = `sha256:${"b".repeat(64)}`;
  const newDigest = `sha256:${"c".repeat(64)}`;

  test("classifies digest-pinned images as production safe", () => {
    const image = describeImageReference(`ghcr.io/elizaos/eliza:v2@${digest}`);
    expect(image.repository).toBe("ghcr.io/elizaos/eliza");
    expect(image.tag).toBe("v2");
    expect(image.digest).toBe(digest);
    expect(image.productionSafe).toBe(true);
    expect(image.warning).toBeNull();
  });

  test("rejects malformed digest references as production unsafe", () => {
    const image = describeImageReference("ghcr.io/elizaos/eliza:v2@sha256:abc123");
    expect(image.pinning).toBe("digest");
    expect(image.productionSafe).toBe(false);
    expect(image.warning).toContain("full sha256");
  });

  test("blocks mutable latest as a rollout decision input", () => {
    const summary = summarizeImageRollout({
      desiredImage: "ghcr.io/elizaos/eliza:latest",
      enabled: true,
      rows: [
        {
          id: "pool-1",
          docker_image: `ghcr.io/elizaos/eliza:v1@${oldDigest}`,
          node_id: "node-1",
          pool_ready_at: new Date("2026-05-06T12:00:00.000Z"),
          health_url: "https://pool-1.test/health",
        },
      ],
    });

    expect(summary.status).toBe("blocked_unpinned_desired_image");
    expect(summary.safeNextAction).toBe("configure_pinned_desired_image");
    expect(summary.desired.warning).toContain("mutable");
  });

  test("reports stale rows and the safe replacement action for digest rollouts", () => {
    const desired = `ghcr.io/elizaos/eliza:v2@${newDigest}`;
    const summary = summarizeImageRollout({
      desiredImage: desired,
      enabled: true,
      rows: [
        {
          id: "stale",
          docker_image: `ghcr.io/elizaos/eliza:v1@${oldDigest}`,
          node_id: "node-1",
          pool_ready_at: new Date("2026-05-06T12:00:00.000Z"),
          health_url: "https://stale.test/health",
        },
        {
          id: "fresh",
          docker_image: `ghcr.io/elizaos/eliza:v2@${newDigest}`,
          node_id: "node-2",
          pool_ready_at: new Date("2026-05-06T12:05:00.000Z"),
          health_url: "https://fresh.test/health",
        },
      ],
    });

    expect(summary.status).toBe("needs_rollout");
    expect(summary.safeNextAction).toBe("replace_stale_pool_entries");
    expect(summary.counts).toEqual({
      totalReady: 2,
      matchingDesired: 1,
      stale: 1,
      unknownImage: 0,
    });
    expect(summary.staleRows[0]).toMatchObject({
      id: "stale",
      currentTag: "v1",
      currentDigest: oldDigest,
      nodeId: "node-1",
    });
  });

  test("matches desired by digest instead of mutable tag text", () => {
    expect(
      imageMatchesDesired(
        `ghcr.io/elizaos/eliza:previous@${digest}`,
        `ghcr.io/elizaos/eliza:current@${digest}`,
      ),
    ).toBe(true);
  });
});
