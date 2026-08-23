/**
 * Coverage for secrets.
 */
import { describe, expect, it } from "vitest";
import { BLOOIO_API_KEY, TELEGRAM_BOT_TOKEN, TWILIO_ACCOUNT_SID } from "./secrets.js";

describe("secrets", () => {
  it("exposes twilio constants", () => {
    expect(TWILIO_ACCOUNT_SID).toBe("TWILIO_ACCOUNT_SID");
    expect(TELEGRAM_BOT_TOKEN).toBe("TELEGRAM_BOT_TOKEN");
  });
  it("exposes blooio constants", () => {
    expect(BLOOIO_API_KEY).toBe("BLOOIO_API_KEY");
  });
});
