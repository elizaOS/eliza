/**
 * Unit tests for Google Workspace Gmail thread message sorting.
 */
import { describe, expect, it } from "vitest";

describe("Gmail thread message safe date sorting", () => {
  it("maintains strict total ordering when receivedAt contains invalid date strings", () => {
    const messages = [
      {
        id: "msg-valid-older",
        receivedAt: "2026-05-01T10:00:00.000Z",
      },
      {
        id: "msg-invalid",
        receivedAt: "invalid-date-string",
      },
      {
        id: "msg-valid-newer",
        receivedAt: "2026-05-01T12:00:00.000Z",
      },
    ];

    messages.sort((left, right) => {
      const leftTime = Number.isFinite(Date.parse(left.receivedAt))
        ? Date.parse(left.receivedAt)
        : 0;
      const rightTime = Number.isFinite(Date.parse(right.receivedAt))
        ? Date.parse(right.receivedAt)
        : 0;
      return leftTime - rightTime;
    });

    expect(messages).toHaveLength(3);
    expect(messages[0]?.id).toBe("msg-invalid"); // fallback 0 time
    expect(messages[1]?.id).toBe("msg-valid-older");
    expect(messages[2]?.id).toBe("msg-valid-newer");
  });
});
