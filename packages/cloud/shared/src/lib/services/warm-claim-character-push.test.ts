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

/**
 * The payload crosses an HTTP boundary as `JSON.stringify(payload)` and the
 * container applies it to the live runtime, persists it via `updateAgent`
 * metadata and journals it to character history. So every projected string has
 * to be well-formed UTF-16 by the time it leaves this builder: a lone surrogate
 * survives JSON (it is escaped as `\ud83d`) and only turns into a permanent
 * U+FFFD when the container UTF-8 encodes it for storage, and it throws
 * `URIError` in any downstream that re-encodes it into a URI. [sol-warmpool]
 */
describe("buildWarmClaimCharacterPayload — surrogate-safe projection", () => {
  const ROCKET = "🚀"; // U+1F680, one surrogate pair (2 UTF-16 code units)

  test("a cap landing mid-pair backs off one code unit instead of splitting it", () => {
    const payload = buildWarmClaimCharacterPayload({
      name: `${"a".repeat(99)}${ROCKET}`, // 101 units, NAME_MAX = 100
      username: `${"u".repeat(49)}${ROCKET}`, // 51 units, USERNAME_MAX = 50
      system: `${"s".repeat(9999)}${ROCKET}`, // 10001 units, SYSTEM_MAX = 10000
      adjectives: [`${"j".repeat(99)}${ROCKET}`], // 101 units, LIST_ITEM_MAX = 100
      topics: [`${"t".repeat(99)}${ROCKET}`],
    }) as {
      name: string;
      username: string;
      system: string;
      adjectives: string[];
      topics: string[];
    } | null;

    expect(payload).not.toBeNull();
    if (!payload) return;

    expect(payload.name).toBe("a".repeat(99));
    expect(payload.username).toBe("u".repeat(49));
    expect(payload.system).toBe("s".repeat(9999));
    expect(payload.adjectives[0]).toBe("j".repeat(99));
    expect(payload.topics[0]).toBe("t".repeat(99));

    for (const value of [
      payload.name,
      payload.username,
      payload.system,
      payload.adjectives[0],
      payload.topics[0],
    ]) {
      expect(value.isWellFormed()).toBe(true);
      // The whole point: no unpaired half rides onto the wire.
      expect(value.endsWith("\ud83d")).toBe(false);
    }
  });

  test("a lone surrogate already in agent_config is normalised, not forwarded", () => {
    const payload = buildWarmClaimCharacterPayload({
      name: "agent\ud83d",
      username: "\udc00user",
      system: "sys\ud83dtem",
      bio: "bio\ud83d",
      topics: ["topic\ud83d"],
      style: { all: ["style\ud83d"] },
      postExamples: ["post\ud83d"],
      messageExamples: [
        {
          examples: [
            { name: "who\ud83d", content: { text: "what\ud83d", actions: ["REPLY\ud83d"] } },
          ],
        },
      ],
    });

    expect(payload).not.toBeNull();
    if (!payload) return;

    const strings: string[] = [];
    const collect = (value: unknown): void => {
      if (typeof value === "string") strings.push(value);
      else if (Array.isArray(value)) for (const item of value) collect(item);
      else if (value && typeof value === "object")
        for (const item of Object.values(value)) collect(item);
    };
    collect(payload);

    expect(strings.length).toBeGreaterThan(0);
    for (const value of strings) {
      expect(value.isWellFormed()).toBe(true);
    }
    expect(payload.name).toBe("agent�");
    expect(payload.username).toBe("�user");
    expect(payload.system).toBe("sys�tem");
  });

  test("the projected name survives the wire and the container's UTF-8 persist", () => {
    const payload = buildWarmClaimCharacterPayload({
      name: `${"a".repeat(99)}${ROCKET}`,
    }) as { name: string } | null;
    expect(payload).not.toBeNull();
    if (!payload) return;

    // What `pushClaimedWarmContainerCharacter` puts on the wire, and what the
    // container gets back out of it before storing it.
    const received = JSON.parse(JSON.stringify(payload)) as { name: string };
    const persisted = Buffer.from(received.name, "utf8").toString("utf8");
    expect(persisted).toBe(payload.name);
    expect(persisted.includes("�")).toBe(false);
    // Any downstream that re-encodes the stored name into a URI must not throw.
    expect(() => encodeURIComponent(persisted)).not.toThrow();
  });

  test("ASCII and BMP values under and at the cap are unchanged", () => {
    const config = {
      name: "Nyx",
      username: "nyx",
      system: "You are Nyx. 漢字 кириллица é ☃",
      bio: ["Nyx is a night owl. 漢字"],
      adjectives: ["nocturnal", "é".repeat(100)],
      topics: ["astronomy"],
      style: { all: ["terse ☃"] },
      postExamples: ["hello 漢字"],
    };
    expect(buildWarmClaimCharacterPayload(config)).toEqual({
      name: "Nyx",
      username: "nyx",
      system: "You are Nyx. 漢字 кириллица é ☃",
      bio: ["Nyx is a night owl. 漢字"],
      adjectives: ["nocturnal", "é".repeat(100)],
      topics: ["astronomy"],
      style: { all: ["terse ☃"] },
      postExamples: ["hello 漢字"],
    });
  });
});
