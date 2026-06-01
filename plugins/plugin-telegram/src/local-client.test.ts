import { describe, expect, it } from "vitest";
import { TELEGRAM_LOCAL_MOCK_SESSION_PREFIX } from "./local-client";

describe("Telegram local client constants", () => {
  it("keeps simulator mock sessions namespaced outside real Telegram sessions", () => {
    expect(TELEGRAM_LOCAL_MOCK_SESSION_PREFIX).toBe("mock-lifeops-simulator:");
  });
});
