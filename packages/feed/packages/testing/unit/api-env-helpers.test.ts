import { afterEach, describe, expect, it } from "bun:test";

import { getNotificationEmailFromEnv, getTrimmedEnv } from "../../api/src/env";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("api env helpers", () => {
  it("getTrimmedEnv returns undefined for missing or whitespace values", () => {
    delete process.env.NOTIFICATION_EMAIL_FROM;
    expect(getTrimmedEnv("NOTIFICATION_EMAIL_FROM")).toBeUndefined();

    process.env.NOTIFICATION_EMAIL_FROM = "   ";
    expect(getTrimmedEnv("NOTIFICATION_EMAIL_FROM")).toBeUndefined();
  });

  it("getTrimmedEnv trims configured values", () => {
    process.env.NOTIFICATION_EMAIL_FROM = "  notify@feed.market  ";
    expect(getTrimmedEnv("NOTIFICATION_EMAIL_FROM")).toBe("notify@feed.market");
  });

  it("getNotificationEmailFromEnv prefers NOTIFICATION_EMAIL_FROM and falls back to EMAIL_FROM", () => {
    process.env.NOTIFICATION_EMAIL_FROM = "notify@feed.market";
    process.env.EMAIL_FROM = "legacy@feed.market";
    expect(getNotificationEmailFromEnv()).toBe("notify@feed.market");

    delete process.env.NOTIFICATION_EMAIL_FROM;
    expect(getNotificationEmailFromEnv()).toBe("legacy@feed.market");
  });
});
