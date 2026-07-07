/**
 * Inbox triage config loader tests.
 *
 * Covers the runtime setting projection used when the inbox plugin runs without
 * importing the agent config package. The harness supplies only `getSetting` so
 * the test stays on the plugin boundary and proves malformed JSON fails closed
 * to the default disabled triage configuration.
 */

import { describe, expect, it } from "vitest";
import { loadInboxTriageConfig } from "../src/inbox/config.ts";

const SETTING = "ELIZA_INBOX_TRIAGE_CONFIG_JSON";

function runtimeWithSetting(value: string | null) {
  return {
    getSetting(name: string): string | null {
      return name === SETTING ? value : null;
    },
  };
}

describe("loadInboxTriageConfig", () => {
  it("deep-merges runtime JSON overrides onto default safety thresholds", () => {
    const config = loadInboxTriageConfig(
      runtimeWithSetting(
        JSON.stringify({
          enabled: true,
          channels: ["gmail"],
          autoReply: { enabled: true },
          triageRules: { alwaysUrgent: ["ceo@example.com"] },
        }),
      ),
    );

    expect(config.enabled).toBe(true);
    expect(config.channels).toEqual(["gmail"]);
    expect(config.autoReply.enabled).toBe(true);
    expect(config.autoReply.confidenceThreshold).toBe(0.85);
    expect(config.autoReply.maxAutoRepliesPerHour).toBe(5);
    expect(config.triageRules.alwaysUrgent).toEqual(["ceo@example.com"]);
    expect(config.triageRules.alwaysIgnore).toEqual([]);
    expect(config.retentionDays).toBe(30);
  });

  it("returns the disabled default config for malformed runtime JSON", () => {
    const config = loadInboxTriageConfig(runtimeWithSetting("{not json"));

    expect(config.enabled).toBe(false);
    expect(config.autoReply.enabled).toBe(false);
    expect(config.channels).toContain("gmail");
    expect(config.retentionDays).toBe(30);
  });
});
