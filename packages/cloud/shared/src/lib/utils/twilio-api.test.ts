/**
 * Coverage for twilio-api pure helpers.
 */
import { describe, expect, it } from "vitest";
import {
  extractMediaUrls,
  isE164PhoneNumber,
  isValidMediaUrl,
  parseTwilioWebhookEvent,
} from "./twilio-api.js";

describe("twilio-api helpers", () => {
  it("validates E164", () => {
    expect(isE164PhoneNumber("+14155552671")).toBe(true);
    expect(isE164PhoneNumber("4155552671")).toBe(false);
    expect(isE164PhoneNumber("+0")).toBe(false);
  });
  it("validates media url domain and https", () => {
    expect(isValidMediaUrl("https://api.twilio.com/img.jpg")).toBe(true);
    expect(isValidMediaUrl("https://media.twiliocdn.com/img.jpg")).toBe(true);
    expect(isValidMediaUrl("https://example.com/img.jpg")).toBe(false);
    expect(isValidMediaUrl("http://api.twilio.com/img.jpg")).toBe(false);
    expect(isValidMediaUrl("not-a-url")).toBe(false);
  });
  it("extracts media urls respecting NumMedia", () => {
    const ev = {
      NumMedia: "2",
      MediaUrl0: "https://api.twilio.com/1",
      MediaUrl1: "https://api.twilio.com/2",
    } as any;
    expect(extractMediaUrls(ev)).toEqual(["https://api.twilio.com/1", "https://api.twilio.com/2"]);
    expect(extractMediaUrls({ NumMedia: "0" } as any)).toEqual([]);
    expect(extractMediaUrls({ NumMedia: "1", MediaUrl0: "https://evil.com/1" } as any)).toEqual([]);
  });
  it("parses webhook event", () => {
    const ev = parseTwilioWebhookEvent({
      MessageSid: "SM1",
      AccountSid: "AC1",
      From: "+1",
      To: "+2",
    });
    expect(ev.MessageSid).toBe("SM1");
  });
});
