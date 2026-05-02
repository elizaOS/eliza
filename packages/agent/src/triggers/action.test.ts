import { describe, expect, it } from "vitest";
import { looksLikeTriggerIntent } from "./action.js";

describe("looksLikeTriggerIntent", () => {
  it("matches freeform 'every N <unit>' phrasings the keyword list does not cover", () => {
    expect(
      looksLikeTriggerIntent("every 2 minutes, write 'ping' to the log"),
    ).toBe(true);
    expect(looksLikeTriggerIntent("every 30 seconds do X")).toBe(true);
    expect(looksLikeTriggerIntent("every 6 hours, ping Discord")).toBe(true);
    expect(looksLikeTriggerIntent("every 3 days collect the digest")).toBe(
      true,
    );
  });

  it("still matches prompts handled by the existing keyword list", () => {
    expect(looksLikeTriggerIntent("please schedule a reminder")).toBe(true);
    expect(looksLikeTriggerIntent("set an alarm for 7am")).toBe(true);
    expect(looksLikeTriggerIntent("daily morning summary")).toBe(true);
  });

  it("rejects text that is neither keyword-matching nor a schedule phrase", () => {
    expect(looksLikeTriggerIntent("hello")).toBe(false);
    expect(looksLikeTriggerIntent("")).toBe(false);
    expect(looksLikeTriggerIntent("   ")).toBe(false);
  });

  it("does not match 'every' without a quantified unit", () => {
    expect(looksLikeTriggerIntent("every so often I want to")).toBe(false);
    expect(looksLikeTriggerIntent("every time you say that")).toBe(false);
  });
});
