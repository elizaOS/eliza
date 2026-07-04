/**
 * Per-origin spawn-cap key coverage for #8875 — the "weak model re-spawns one
 * request ~70x" loop, on Discord AND dashboard/web.
 *
 * The source-level fix (the completion evaluator treating a truncated/blocked
 * sub-agent completion as terminal) is transport-independent and covered by
 * `sub-agent-completion-finish-reason.test.ts`. This file pins the SECOND half
 * the issue explicitly called out: the defense-in-depth per-origin cap must be
 * ARMED on the connector-less dashboard/web path too, where it previously
 * no-op'd because the key was derived from a connector message id that web
 * never has.
 *
 * The two sides of the cap live in different modules and MUST agree on the key
 * for record (SubAgentRouter.recordOriginResult) + enforce (TASKS action) to
 * meet. We prove that agreement directly, plus the cap store's accumulate +
 * relay behavior, without standing up the whole spawn pipeline.
 */

import type { Memory } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  spawnOriginKeyFor as rawSpawnOriginKeyFor,
  spawnRootIdFor,
} from "../actions/tasks.ts";
import {
  SubAgentRouter,
  spawnRootIdFromMeta,
} from "../services/sub-agent-router.ts";

/** These fixtures always carry an id, so the key is always defined; assert that
 * once here so every callsite gets a concrete `string`. */
function spawnOriginKeyFor(
  message: Memory,
  content: Record<string, unknown>,
  agentType: string,
): string {
  const key = rawSpawnOriginKeyFor(message, content, agentType);
  if (!key) throw new Error("expected a defined spawn-origin key");
  return key;
}

const ROOT_MSG = "11111111-1111-4111-8111-111111111111";
const SYNTH_MSG_1 = "22222222-2222-4222-8222-222222222222";
const SYNTH_MSG_2 = "33333333-3333-4333-8333-333333333333";
const ROOM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

/** A minimal inbound Memory (spawnRootIdFor reads only `id` + `metadata`). */
function msg(id: string, metadata: Record<string, unknown> = {}): Memory {
  return { id, metadata } as unknown as Memory;
}

/** The session metadata tasks.ts persists at spawn time (the fields readOrigin
 * / spawnRootIdFromMeta consume), for a given derived root id. */
function spawnedSessionMeta(
  rootId: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    taskRoomId: ROOM,
    roomId: ROOM,
    messageId: ROOT_MSG,
    spawnRootMessageId: rootId,
    ...extra,
  };
}

describe("per-origin spawn cap key (#8875)", () => {
  describe("web / dashboard (no connector message id)", () => {
    it("arms the cap off the user message id on the first spawn", () => {
      // Before the fix this returned undefined → the whole cap block was skipped
      // on web and the ~70x loop ran unbounded.
      expect(spawnRootIdFor(msg(ROOT_MSG), { metadata: {} })).toBe(ROOT_MSG);
      expect(spawnOriginKeyFor(msg(ROOT_MSG), { metadata: {} }, "coder")).toBe(
        `${ROOT_MSG}\0coder`,
      );
    });

    it("stays anchored to the ROOT id across re-spawns (synthetic inbound churn)", () => {
      // Each re-injected completion is a fresh Memory with a NEW random id, but
      // SubAgentRouter re-stamps `spawnRootMessageId` = the original root. The
      // key must follow the root, not the synthetic per-hop id.
      const respawn1 = spawnOriginKeyFor(
        msg(SYNTH_MSG_1, {}),
        { metadata: { spawnRootMessageId: ROOT_MSG } },
        "coder",
      );
      const respawn2 = spawnOriginKeyFor(
        msg(SYNTH_MSG_2, {}),
        { metadata: { spawnRootMessageId: ROOT_MSG } },
        "coder",
      );
      const firstSpawn = spawnOriginKeyFor(
        msg(ROOT_MSG),
        { metadata: {} },
        "coder",
      );
      expect(respawn1).toBe(firstSpawn);
      expect(respawn2).toBe(firstSpawn);
    });

    it("would DRIFT (and never accumulate) if the root id were not propagated", () => {
      // Documents exactly why the propagated field is load-bearing: without it,
      // a synthetic inbound keys on its own fresh id and every hop is a new key.
      const drifted = spawnOriginKeyFor(
        msg(SYNTH_MSG_1, {}),
        { metadata: {} },
        "coder",
      );
      const firstSpawn = spawnOriginKeyFor(
        msg(ROOT_MSG),
        { metadata: {} },
        "coder",
      );
      expect(drifted).not.toBe(firstSpawn);
    });

    it("separates distinct agent types under the same request", () => {
      const coder = spawnOriginKeyFor(msg(ROOT_MSG), { metadata: {} }, "coder");
      const browser = spawnOriginKeyFor(
        msg(ROOT_MSG),
        { metadata: {} },
        "browser",
      );
      expect(coder).not.toBe(browser);
    });
  });

  describe("discord / connectors (connector message id present)", () => {
    it("keys on the connector message id (unchanged behavior)", () => {
      const discord = msg(ROOT_MSG, { discord: { messageId: "disc-987" } });
      expect(spawnRootIdFor(discord, { metadata: {} })).toBe("disc-987");
      expect(spawnOriginKeyFor(discord, { metadata: {} }, "coder")).toBe(
        "disc-987\0coder",
      );
    });

    it("prefers an explicit originConnectorMessageId in content metadata", () => {
      const key = spawnRootIdFor(msg(ROOT_MSG), {
        metadata: { originConnectorMessageId: "conn-root-1" },
      });
      expect(key).toBe("conn-root-1");
    });
  });

  describe("record (router) + enforce (action) agree on the key", () => {
    it("router readback of the persisted metadata equals the action's derived root — web", () => {
      const rootId = spawnRootIdFor(msg(ROOT_MSG), { metadata: {} });
      // What tasks.ts writes into the spawned session metadata:
      const meta = spawnedSessionMeta(rootId);
      // What the router reads back to key recordOriginResult:
      expect(spawnRootIdFromMeta(meta)).toBe(rootId);
    });

    it("agrees across a re-spawn hop — web", () => {
      const respawnRoot = spawnRootIdFor(msg(SYNTH_MSG_1, {}), {
        metadata: { spawnRootMessageId: ROOT_MSG },
      });
      expect(respawnRoot).toBe(ROOT_MSG);
      expect(spawnRootIdFromMeta(spawnedSessionMeta(respawnRoot))).toBe(
        ROOT_MSG,
      );
    });

    it("agrees on discord — connector id", () => {
      const discord = msg(ROOT_MSG, { discord: { messageId: "disc-987" } });
      const rootId = spawnRootIdFor(discord, { metadata: {} });
      const meta = spawnedSessionMeta(rootId, {
        originConnectorMessageId: "disc-987",
      });
      expect(spawnRootIdFromMeta(meta)).toBe("disc-987");
    });

    it("falls back to the session messageId for pre-fix sessions (no spawnRootMessageId)", () => {
      // A session spawned before this change persists messageId but not
      // spawnRootMessageId; it must still resolve to a stable id, not undefined.
      const legacyMeta = {
        taskRoomId: ROOM,
        roomId: ROOM,
        messageId: ROOT_MSG,
      };
      expect(spawnRootIdFromMeta(legacyMeta)).toBe(ROOT_MSG);
    });

    it("returns undefined for empty metadata", () => {
      expect(spawnRootIdFromMeta(undefined)).toBeUndefined();
      expect(spawnRootIdFromMeta({})).toBeUndefined();
    });
  });

  describe("cap store accumulates + relays for a web key", () => {
    const runtime = {
      agentId: "00000000-0000-4000-8000-000000000001",
      getSetting: () => undefined,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    } as never;

    it("counts serial re-spawns of one origin and keeps the best result", () => {
      const router = new SubAgentRouter(runtime);
      const key = spawnOriginKeyFor(msg(ROOT_MSG), { metadata: {} }, "coder");

      expect(router.spawnCountForOrigin(key)).toBe(0);
      router.noteSpawnForOrigin(key);
      router.noteSpawnForOrigin(key);
      router.noteSpawnForOrigin(key);
      expect(router.spawnCountForOrigin(key)).toBe(3);

      // A distinct request in the same room (different root id) is independent.
      const otherKey = spawnOriginKeyFor(
        msg(SYNTH_MSG_2, {}),
        { metadata: {} },
        "coder",
      );
      expect(router.spawnCountForOrigin(otherKey)).toBe(0);

      // Best result keeps the LONGEST non-empty completion (a subsequent truncated
      // stub must not clobber the fuller earlier answer).
      router.recordOriginResult(key, { text: "479" });
      router.recordOriginResult(key, { text: "479001600 (the full answer)" });
      router.recordOriginResult(key, { text: "x" });
      expect(router.bestResultFor(key)?.text).toBe(
        "479001600 (the full answer)",
      );
    });

    it("relays the recorded result at the cap for the SAME key a re-spawn resolves", () => {
      const router = new SubAgentRouter(runtime);
      const firstKey = spawnOriginKeyFor(
        msg(ROOT_MSG),
        { metadata: {} },
        "coder",
      );
      router.recordOriginResult(firstKey, {
        text: "final answer",
        deliverable: "42",
      });

      // A subsequent re-spawn hop derives the SAME key from the propagated root id,
      // so it finds the relayable result instead of spawning again.
      const respawnKey = spawnOriginKeyFor(
        msg(SYNTH_MSG_1, {}),
        { metadata: { spawnRootMessageId: ROOT_MSG } },
        "coder",
      );
      expect(respawnKey).toBe(firstKey);
      expect(router.bestResultFor(respawnKey)?.deliverable).toBe("42");
    });
  });
});
