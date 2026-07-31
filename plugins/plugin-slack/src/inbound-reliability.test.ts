/**
 * Unit-level proof for the keying and lane state machine in
 * `inbound-reliability.ts`.
 *
 * The production-path proof (real bolt handlers, duplicate agent runs, race
 * interleavings) lives in `service-inbound-reliability.test.ts`. This file
 * covers the keying rules and the admit/settle algebra directly, because the
 * subtle cases (maybe-thread isolation, DM channel scoping, twin release on
 * skip) are much easier to state here than through the full handler.
 */
import { describe, expect, it } from "vitest";
import {
  buildSlackDebounceKey,
  buildSlackTopLevelConversationKey,
  extractSlackEventId,
  extractSlackRetryNum,
  type SlackInboundEventLike,
  SlackInboundReliability,
} from "./inbound-reliability";

const ACCOUNT = "default";

function message(
  overrides: Partial<SlackInboundEventLike> = {},
): SlackInboundEventLike {
  return {
    channel: "C123",
    user: "U456",
    ts: "1709000000.000100",
    ...overrides,
  };
}

describe("buildSlackDebounceKey", () => {
  it("returns null when the event has no sender", () => {
    expect(
      buildSlackDebounceKey(
        message({ user: undefined, bot_id: undefined }),
        ACCOUNT,
      ),
    ).toBeNull();
  });

  it("falls back to bot_id as the sender", () => {
    expect(
      buildSlackDebounceKey(
        message({ user: undefined, bot_id: "B999" }),
        ACCOUNT,
      ),
    ).toBe("slack:default:C123:1709000000.000100:B999");
  });

  it("scopes thread replies by thread_ts so a thread is one lane", () => {
    expect(
      buildSlackDebounceKey(
        message({ thread_ts: "1709000000.000001" }),
        ACCOUNT,
      ),
    ).toBe("slack:default:C123:1709000000.000001:U456");
  });

  it("isolates unresolved thread replies behind a maybe-thread prefix", () => {
    // parent_user_id present but thread_ts not yet resolved: must not collide
    // with the channel's top-level lane.
    const key = buildSlackDebounceKey(
      message({ parent_user_id: "U789", ts: "1709000000.000200" }),
      ACCOUNT,
    );
    expect(key).toBe("slack:default:C123:maybe-thread:1709000000.000200:U456");
    expect(key).not.toBe(
      buildSlackDebounceKey(message({ ts: "1709000000.000200" }), ACCOUNT),
    );
  });

  it("scopes top-level channel messages by their own ts", () => {
    const a = buildSlackDebounceKey(
      message({ ts: "1709000000.000100" }),
      ACCOUNT,
    );
    const b = buildSlackDebounceKey(
      message({ ts: "1709000000.000200" }),
      ACCOUNT,
    );
    expect(a).not.toBe(b);
  });

  it("keeps top-level DMs channel-scoped so consecutive lines share a lane", () => {
    const a = buildSlackDebounceKey(
      message({ channel: "D123", ts: "1709000000.000100" }),
      ACCOUNT,
    );
    const b = buildSlackDebounceKey(
      message({ channel: "D123", ts: "1709000000.000200" }),
      ACCOUNT,
    );
    expect(a).toBe("slack:default:D123:U456");
    expect(a).toBe(b);
  });

  it("scopes lanes per account so two workspaces never share one", () => {
    expect(buildSlackDebounceKey(message(), "acct-a")).not.toBe(
      buildSlackDebounceKey(message(), "acct-b"),
    );
  });
});

describe("buildSlackTopLevelConversationKey", () => {
  it("returns a key for top-level messages", () => {
    expect(buildSlackTopLevelConversationKey(message(), ACCOUNT)).toBe(
      "slack:default:C123:U456",
    );
  });

  it("returns null for thread replies", () => {
    expect(
      buildSlackTopLevelConversationKey(
        message({ thread_ts: "1709000000.000001" }),
        ACCOUNT,
      ),
    ).toBeNull();
  });
});

describe("SlackInboundReliability event_id dedupe", () => {
  it("admits an event_id once and rejects redeliveries", () => {
    const r = new SlackInboundReliability();
    expect(r.admitEventId("Ev123")).toBe(true);
    expect(r.admitEventId("Ev123")).toBe(false);
    expect(r.admitEventId("Ev123")).toBe(false);
    expect(r.stats().duplicatesDropped).toBe(2);
  });

  it("admits a missing event_id rather than dropping a possibly-real event", () => {
    const r = new SlackInboundReliability();
    expect(r.admitEventId(null)).toBe(true);
    expect(r.admitEventId(undefined)).toBe(true);
  });

  it("forgets event ids after the TTL", () => {
    let now = 1_000;
    const r = new SlackInboundReliability({
      eventIdTtlMs: 500,
      now: () => now,
    });
    expect(r.admitEventId("Ev1")).toBe(true);
    now = 1_400;
    expect(r.admitEventId("Ev1")).toBe(false);
    now = 2_000;
    expect(r.admitEventId("Ev1")).toBe(true);
  });
});

describe("SlackInboundReliability lane admission", () => {
  it("rejects a second event on the same lane from the same source", () => {
    const r = new SlackInboundReliability();
    const first = r.admit({
      accountId: ACCOUNT,
      source: "message",
      event: message(),
    });
    expect(first.admitted).toBe(true);
    const second = r.admit({
      accountId: ACCOUNT,
      source: "message",
      event: message(),
    });
    expect(second.admitted).toBe(false);
    expect(second.reason).toBe("duplicate-same-source");
  });

  it("admits the app_mention twin alongside the message twin", () => {
    const r = new SlackInboundReliability();
    r.admit({ accountId: ACCOUNT, source: "message", event: message() });
    const mention = r.admit({
      accountId: ACCOUNT,
      source: "app_mention",
      event: message(),
    });
    expect(mention.admitted).toBe(true);
    expect(mention.reason).toBe("mention-preempts-message");
  });

  it("rejects the twin once the other source has dispatched", () => {
    const r = new SlackInboundReliability();
    const mention = r.admit({
      accountId: ACCOUNT,
      source: "app_mention",
      event: message(),
    });
    r.settle(mention.key, "app_mention", "dispatched");
    const twin = r.admit({
      accountId: ACCOUNT,
      source: "message",
      event: message(),
    });
    expect(twin.admitted).toBe(false);
    expect(twin.reason).toBe("twin-already-dispatched");
  });

  it("frees the lane on failure so Slack redelivery is a real retry", () => {
    const r = new SlackInboundReliability();
    const first = r.admit({
      accountId: ACCOUNT,
      source: "message",
      event: message(),
    });
    r.settle(first.key, "message", "failed");
    const retry = r.admit({
      accountId: ACCOUNT,
      source: "message",
      event: message(),
    });
    expect(retry.admitted).toBe(true);
  });

  it("admits events with no sender rather than deduping them together", () => {
    const r = new SlackInboundReliability();
    const a = r.admit({
      accountId: ACCOUNT,
      source: "message",
      event: message({ user: undefined, bot_id: undefined }),
    });
    const b = r.admit({
      accountId: ACCOUNT,
      source: "message",
      event: message({ user: undefined, bot_id: undefined }),
    });
    expect(a.admitted).toBe(true);
    expect(a.reason).toBe("unkeyed");
    expect(b.admitted).toBe(true);
  });
});

describe("SlackInboundReliability twin resolution", () => {
  it("suppresses the message twin when the mention dispatched", async () => {
    const r = new SlackInboundReliability();
    const mention = r.admit({
      accountId: ACCOUNT,
      source: "app_mention",
      event: message(),
    });
    const twin = r.admit({
      accountId: ACCOUNT,
      source: "message",
      event: message(),
    });
    const pending = r.awaitMentionTwin(twin.key);
    r.settle(mention.key, "app_mention", "dispatched");
    await expect(pending).resolves.toEqual({
      proceed: false,
      reason: "twin-dispatched",
    });
  });

  it("releases the message twin when the mention skipped", async () => {
    // The drop bug: mention bails (gated, no memory), and on the old code the
    // message twin had already returned, so the turn was lost entirely.
    const r = new SlackInboundReliability();
    const mention = r.admit({
      accountId: ACCOUNT,
      source: "app_mention",
      event: message(),
    });
    const twin = r.admit({
      accountId: ACCOUNT,
      source: "message",
      event: message(),
    });
    const pending = r.awaitMentionTwin(twin.key);
    r.settle(mention.key, "app_mention", "skipped");
    await expect(pending).resolves.toEqual({
      proceed: true,
      reason: "twin-released",
    });
  });

  it("releases the message twin when the mention threw", async () => {
    const r = new SlackInboundReliability();
    const mention = r.admit({
      accountId: ACCOUNT,
      source: "app_mention",
      event: message(),
    });
    const twin = r.admit({
      accountId: ACCOUNT,
      source: "message",
      event: message(),
    });
    const pending = r.awaitMentionTwin(twin.key);
    r.settle(mention.key, "app_mention", "failed");
    await expect(pending).resolves.toEqual({
      proceed: true,
      reason: "twin-released",
    });
  });

  it("proceeds after the grace window when no mention ever arrives", async () => {
    const r = new SlackInboundReliability({ mentionGraceMs: 5 });
    const only = r.admit({
      accountId: ACCOUNT,
      source: "message",
      event: message(),
    });
    await expect(r.awaitMentionTwin(only.key)).resolves.toEqual({
      proceed: true,
      reason: "grace-expired",
    });
  });

  it("waits for a mention that arrives inside the grace window", async () => {
    const r = new SlackInboundReliability({ mentionGraceMs: 50 });
    const twin = r.admit({
      accountId: ACCOUNT,
      source: "message",
      event: message(),
    });
    const pending = r.awaitMentionTwin(twin.key);
    const mention = r.admit({
      accountId: ACCOUNT,
      source: "app_mention",
      event: message(),
    });
    r.settle(mention.key, "app_mention", "dispatched");
    await expect(pending).resolves.toEqual({
      proceed: false,
      reason: "twin-dispatched",
    });
  });
});

describe("envelope field extraction", () => {
  it("reads event_id from the envelope", () => {
    expect(extractSlackEventId({ event_id: "Ev0PV52K21" })).toBe("Ev0PV52K21");
    expect(extractSlackEventId({})).toBeNull();
    expect(extractSlackEventId(null)).toBeNull();
  });

  it("reads the retry counter from every surface Slack uses", () => {
    expect(extractSlackRetryNum({ retry_num: 2 })).toBe(2);
    expect(extractSlackRetryNum({ retry_attempt: 3 })).toBe(3);
    expect(extractSlackRetryNum({}, { retryNum: 1 })).toBe(1);
    expect(extractSlackRetryNum({})).toBeUndefined();
  });
});
