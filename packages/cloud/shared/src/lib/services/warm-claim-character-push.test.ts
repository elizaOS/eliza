/**
 * Warm-pool claim → character push payload builder + boot-coupled env merge.
 *
 * The push payload must satisfy the agent's STRICT `PUT /api/character`
 * CharacterSchema (unknown keys rejected at parse time), so the builder is the
 * single seam that keeps a loose user `agent_config` (plugins, settings,
 * secrets, connectors, ...) from 422-ing the push — or worse, from leaking
 * secrets to an HTTP surface that never needs them. The env merge pins that a
 * claimed container's boot credentials (ELIZA_API_TOKEN et al) follow the
 * container onto the user row, or every authenticated call after the claim
 * checks the wrong token. [sol-warmpool]
 */

import { describe, expect, test } from "bun:test";
import {
  buildWarmClaimCharacterPayload,
  mergeWarmClaimEnvironmentVars,
} from "./warm-claim-character-push";

describe("buildWarmClaimCharacterPayload", () => {
  test("projects a full agent_config down to exactly the strict schema's keys", () => {
    const payload = buildWarmClaimCharacterPayload(
      {
        name: "Nyx",
        username: "nyx",
        system: "You are Nyx.",
        bio: ["Nyx is a night owl."],
        topics: ["astronomy"],
        adjectives: ["nocturnal"],
        style: { all: ["terse"], chat: ["lowercase"], post: [] },
        postExamples: ["gm from the dark side"],
        // Keys the strict schema REJECTS — must all be dropped.
        plugins: ["@elizaos/plugin-sql"],
        settings: { secrets: { OPENAI_API_KEY: "sk-REDACT" } },
        secrets: { token: "nope" },
        connectors: { discord: { token: "nope" } },
        knowledge: ["doc.md"],
        id: "some-uuid",
      },
      "fallback-name",
    );

    expect(payload).toEqual({
      name: "Nyx",
      username: "nyx",
      system: "You are Nyx.",
      bio: ["Nyx is a night owl."],
      adjectives: ["nocturnal"],
      topics: ["astronomy"],
      // Empty `post` array dropped, non-empty kept.
      style: { all: ["terse"], chat: ["lowercase"] },
      postExamples: ["gm from the dark side"],
    });
    // Secrets must NEVER ride along on the push.
    expect(JSON.stringify(payload)).not.toContain("sk-REDACT");
  });

  test("falls back to agent_name when the config has no name", () => {
    const payload = buildWarmClaimCharacterPayload({}, "Bnancy");
    expect(payload).toEqual({ name: "Bnancy" });
  });

  test("returns null when there is no name anywhere (nothing to push)", () => {
    expect(buildWarmClaimCharacterPayload({}, null)).toBeNull();
    expect(buildWarmClaimCharacterPayload(undefined, "   ")).toBeNull();
    expect(buildWarmClaimCharacterPayload(null, undefined)).toBeNull();
  });

  test("string bio is wrapped into the array form the schema accepts", () => {
    const payload = buildWarmClaimCharacterPayload({ name: "A", bio: "one-liner" }, null);
    expect(payload?.bio).toEqual(["one-liner"]);
  });

  test("oversized fields are truncated instead of 422-ing the whole push", () => {
    const payload = buildWarmClaimCharacterPayload(
      {
        name: "N".repeat(300),
        username: "u".repeat(90),
        system: "s".repeat(20_000),
        adjectives: ["a".repeat(250)],
      },
      null,
    );
    if (!payload) throw new Error("expected a payload");
    expect((payload.name as string).length).toBe(100);
    expect((payload.username as string).length).toBe(50);
    expect((payload.system as string).length).toBe(10_000);
    expect((payload.adjectives as string[])[0]?.length).toBe(100);
  });

  test("strict-form messageExamples pass through with unknown content keys stripped", () => {
    const payload = buildWarmClaimCharacterPayload(
      {
        name: "A",
        messageExamples: [
          {
            examples: [
              {
                name: "{{user1}}",
                content: { text: "hi", extraneous: "drop-me" },
              },
              {
                name: "A",
                content: { text: "hello", actions: ["REPLY"] },
              },
            ],
          },
        ],
      },
      null,
    );
    expect(payload?.messageExamples).toEqual([
      {
        examples: [
          { name: "{{user1}}", content: { text: "hi" } },
          { name: "A", content: { text: "hello", actions: ["REPLY"] } },
        ],
      },
    ]);
  });

  test("legacy [[{user,content}]] messageExamples are omitted (boot path normalises later)", () => {
    const payload = buildWarmClaimCharacterPayload(
      {
        name: "A",
        messageExamples: [[{ user: "u", content: { text: "hi" } }]],
      },
      null,
    );
    expect(payload).not.toBeNull();
    expect(payload?.messageExamples).toBeUndefined();
  });
});

describe("mergeWarmClaimEnvironmentVars", () => {
  test("pool boot-coupled keys override; user keys otherwise win/persist", () => {
    const merged = mergeWarmClaimEnvironmentVars(
      {
        ELIZA_API_TOKEN: "agent_user_stale",
        MY_CUSTOM_SECRET: "keep-me",
      },
      {
        ELIZA_API_TOKEN: "agent_pool_live",
        JWT_SECRET: "pool-jwt",
        AGENT_SERVER_SHARED_SECRET: "pool-shared",
        SOME_POOL_ONLY_KEY: "must-not-leak",
      },
    );
    expect(merged).toEqual({
      // The container is RUNNING with the pool token — it must win.
      ELIZA_API_TOKEN: "agent_pool_live",
      JWT_SECRET: "pool-jwt",
      AGENT_SERVER_SHARED_SECRET: "pool-shared",
      ELIZA_CLOUD_PAIR_DIRECT_RELAY: "0",
      MY_CUSTOM_SECRET: "keep-me",
    });
  });

  test("a historical direct-relay value cannot survive the warm-claim merge", () => {
    expect(
      mergeWarmClaimEnvironmentVars(
        { ELIZA_CLOUD_PAIR_DIRECT_RELAY: "1", USER_SETTING: "keep" },
        { ELIZA_CLOUD_PAIR_DIRECT_RELAY: "1" },
      ),
    ).toEqual({
      ELIZA_CLOUD_PAIR_DIRECT_RELAY: "0",
      USER_SETTING: "keep",
    });
  });

  test("null/absent pool env preserves user values plus the remote pairing invariant", () => {
    expect(mergeWarmClaimEnvironmentVars({ A: "1" }, null)).toEqual({
      A: "1",
      ELIZA_CLOUD_PAIR_DIRECT_RELAY: "0",
    });
    expect(mergeWarmClaimEnvironmentVars(null, null)).toEqual({
      ELIZA_CLOUD_PAIR_DIRECT_RELAY: "0",
    });
  });
});
