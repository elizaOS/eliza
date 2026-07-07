// @vitest-environment jsdom
/**
 * The transient banner queue: newest-first cap and the groupKey/id coalescing
 * that keeps a superseding burst from stacking one banner per arrival. Pure
 * store — no React, no timers; assertions read the live queue snapshot.
 */
import type { AgentNotification } from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  __getBannersForTests,
  __resetNotificationBannersForTests,
  dismissNotificationBanner,
  pushNotificationBanner,
} from "./notification-banner-store";

let seq = 0;
function make(overrides: Partial<AgentNotification> = {}): AgentNotification {
  seq += 1;
  return {
    id: overrides.id ?? `id-${seq}`,
    title: overrides.title ?? `n${seq}`,
    category: "general",
    priority: "high",
    source: "test",
    createdAt: 1_700_000_000_000 + seq,
    readAt: null,
    ...overrides,
  };
}

afterEach(() => {
  seq = 0;
  __resetNotificationBannersForTests();
});

describe("notification-banner-store", () => {
  it("coalesces same-groupKey arrivals into one banner, keeping the newest", () => {
    pushNotificationBanner(
      make({ id: "a", title: "1 file", groupKey: "files" }),
    );
    pushNotificationBanner(
      make({ id: "b", title: "2 files", groupKey: "files" }),
    );
    pushNotificationBanner(
      make({ id: "c", title: "3 files", groupKey: "files" }),
    );
    const q = __getBannersForTests();
    // One banner for the whole "files" burst, and it's the newest arrival.
    expect(q).toHaveLength(1);
    expect(q[0]?.id).toBe("c");
    expect(q[0]?.title).toBe("3 files");
  });

  it("keeps distinct groups as separate banners, newest first", () => {
    pushNotificationBanner(make({ id: "a", groupKey: "files" }));
    pushNotificationBanner(make({ id: "b", groupKey: "mail" }));
    const q = __getBannersForTests();
    expect(q.map((b) => b.id)).toEqual(["b", "a"]);
  });

  it("dedupes by id when there is no groupKey", () => {
    pushNotificationBanner(make({ id: "x", title: "first" }));
    pushNotificationBanner(make({ id: "x", title: "second" }));
    const q = __getBannersForTests();
    expect(q).toHaveLength(1);
    expect(q[0]?.title).toBe("second");
  });

  it("caps the queue at three, dropping the oldest", () => {
    for (let i = 0; i < 5; i++) pushNotificationBanner(make({ id: `q${i}` }));
    const q = __getBannersForTests();
    expect(q.map((b) => b.id)).toEqual(["q4", "q3", "q2"]);
  });

  it("dismiss removes the matching banner and is a no-op for a gone id", () => {
    pushNotificationBanner(make({ id: "keep" }));
    pushNotificationBanner(make({ id: "drop" }));
    dismissNotificationBanner("drop");
    expect(__getBannersForTests().map((b) => b.id)).toEqual(["keep"]);
    dismissNotificationBanner("drop"); // no-op, must not throw or clear "keep"
    expect(__getBannersForTests().map((b) => b.id)).toEqual(["keep"]);
  });
});
