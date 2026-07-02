import { describe, expect, it } from "vitest";

import { codingSessionChangesProvider } from "../../src/providers/coding-session-changes.js";
import type { SessionInfo } from "../../src/services/types.js";
import {
  memory,
  runtimeWith,
  serviceMock,
  state,
} from "../../src/test-utils/action-test-utils.js";

let counter = 0;
function uuid(): string {
  counter += 1;
  const h = counter.toString(16).padStart(12, "0");
  return `00000000-0000-0000-0000-${h}`;
}

function session(
  createdMsAgo: number,
  changeSet?: { files: string[]; capturedMsAgo: number },
  metadata: Record<string, unknown> = {},
): SessionInfo {
  const now = Date.now();
  return {
    id: uuid(),
    name: "task",
    agentType: "opencode",
    workdir: "/home/example/projects/custom-apps",
    status: "ready",
    approvalPreset: "standard",
    createdAt: new Date(now - createdMsAgo),
    lastActivityAt: new Date(now - createdMsAgo),
    metadata: {
      label: "task",
      roomId: "room1",
      ...metadata,
      ...(changeSet
        ? {
            lastChangeSet: {
              changedFiles: changeSet.files,
              diffStat: `${changeSet.files.length} file(s) changed`,
              diff: changeSet.files.map((f) => `+++ b/${f}`).join("\n"),
              truncated: false,
              capturedAt: now - changeSet.capturedMsAgo,
            },
          }
        : {}),
    },
  } satisfies SessionInfo;
}

describe("codingSessionChangesProvider — staleness guard", () => {
  it("surfaces the recent change set when it is the latest coding task", async () => {
    const svc = serviceMock({
      listSessions: () => [
        session(90_000, {
          files: ["data/apps/coffee-site/index.html"],
          capturedMsAgo: 60_000,
        }),
      ],
    });
    const r = await codingSessionChangesProvider.get(
      runtimeWith(svc),
      memory(),
      state,
    );
    expect(r.text).toContain("data/apps/coffee-site/index.html");
  });

  it("does NOT surface an older change set when a newer task ran since — grounds honestly", async () => {
    // Reproduces the dogsite leak: task A (bitcoin) captured a diff; task B
    // (the footer edit) ran AFTER but produced no captured diff. "what did you
    // change?" must not surface A's stale, unrelated diff.
    const svc = serviceMock({
      listSessions: () => [
        session(300_000, {
          files: ["fetch_bitcoin_price.py"],
          capturedMsAgo: 240_000,
        }),
        session(60_000), // newer task, no captured change set
      ],
    });
    const r = await codingSessionChangesProvider.get(
      runtimeWith(svc),
      memory(),
      state,
    );
    expect(r.text).not.toContain("fetch_bitcoin_price.py");
    expect(r.text).toContain("don't have a captured diff");
  });

  it("treats serialized createdAt strings as newer task timestamps", async () => {
    const now = Date.now();
    const olderWithDiff = session(300_000, {
      files: ["fetch_bitcoin_price.py"],
      capturedMsAgo: 240_000,
    });
    const newerNoDiff = {
      ...session(60_000),
      createdAt: new Date(now - 60_000).toISOString(),
    } as unknown as SessionInfo;
    const svc = serviceMock({
      listSessions: () => [olderWithDiff, newerNoDiff],
    });
    const r = await codingSessionChangesProvider.get(
      runtimeWith(svc),
      memory(),
      state,
    );
    expect(r.text).not.toContain("fetch_bitcoin_price.py");
    expect(r.text).toContain("don't have a captured diff");
  });

  it("does not leak a recent change set from a different task room", async () => {
    const svc = serviceMock({
      listSessions: () => [
        session(
          60_000,
          {
            files: ["other-room-site/index.html"],
            capturedMsAgo: 30_000,
          },
          { roomId: "room-other", taskRoomId: "room-other" },
        ),
      ],
    });
    const r = await codingSessionChangesProvider.get(
      runtimeWith(svc),
      memory(),
      state,
    );
    expect(r.text).toBe("");
  });

  it("still surfaces the change set when the other session is older than the capture", async () => {
    const svc = serviceMock({
      listSessions: () => [
        session(300_000, {
          files: ["data/apps/tea-site/index.html"],
          capturedMsAgo: 240_000,
        }),
        session(360_000), // older sibling, spawned before the capture
      ],
    });
    const r = await codingSessionChangesProvider.get(
      runtimeWith(svc),
      memory(),
      state,
    );
    expect(r.text).toContain("data/apps/tea-site/index.html");
  });

  it("returns empty when no recent coding session has a change set", async () => {
    const svc = serviceMock({ listSessions: () => [session(60_000)] });
    const r = await codingSessionChangesProvider.get(
      runtimeWith(svc),
      memory(),
      state,
    );
    expect(r.text).toBe("");
  });
});
