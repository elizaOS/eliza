import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  buildNotificationUnsubscribeUrl,
  createNotificationUnsubscribeToken,
  verifyNotificationUnsubscribeToken,
} from "../services/notification-email-service";

describe("Notification Email Service", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.NOTIFICATION_EMAIL_UNSUBSCRIBE_SECRET = "test-unsub-secret";
    process.env.NEXT_PUBLIC_APP_URL = "https://feed.market";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("creates and verifies a valid unsubscribe token", () => {
    const token = createNotificationUnsubscribeToken({
      userId: "user-123",
      email: "user@example.com",
      ttlSeconds: 60,
    });

    expect(token).toBeTruthy();
    const payload = verifyNotificationUnsubscribeToken(token!);

    expect(payload).toBeTruthy();
    expect(payload?.userId).toBe("user-123");
    expect(payload?.email).toBe("user@example.com");
  });

  it("returns null for tampered token signature", () => {
    const token = createNotificationUnsubscribeToken({
      userId: "user-123",
      email: "user@example.com",
      ttlSeconds: 60,
    });

    expect(token).toBeTruthy();
    const [payload] = token?.split(".");
    const tamperedToken = `${payload}.invalidsignature`;
    const decoded = verifyNotificationUnsubscribeToken(tamperedToken);

    expect(decoded).toBeNull();
  });

  it("returns null for expired tokens", async () => {
    const token = createNotificationUnsubscribeToken({
      userId: "user-123",
      email: "user@example.com",
      ttlSeconds: 0,
    });

    expect(token).toBeTruthy();
    const decoded = verifyNotificationUnsubscribeToken(token!);

    expect(decoded).toBeNull();
  });

  it("builds unsubscribe url with token", () => {
    const url = buildNotificationUnsubscribeUrl({
      userId: "user-123",
      email: "user@example.com",
    });

    expect(url).toContain(
      "https://feed.market/api/notifications/email/unsubscribe?token=",
    );
  });
});
