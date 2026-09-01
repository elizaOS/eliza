/**
 * Verifies environment and connector-config activation for the iMessage plugin.
 */

import { describe, expect, it } from "vitest";
import { shouldEnable } from "../auto-enable.js";

function context(env: Record<string, string | undefined>, connectors?: Record<string, unknown>) {
  return { env, config: connectors ? { connectors } : {} } as Parameters<typeof shouldEnable>[0];
}

describe("plugin-imessage auto enable", () => {
  it("enables a Blooio transport configured entirely through environment variables", () => {
    expect(shouldEnable(context({ IMESSAGE_TRANSPORT: "blooio" }))).toBe(true);
  });

  it("honors an explicit disable over transport configuration", () => {
    expect(shouldEnable(context({ IMESSAGE_TRANSPORT: "blooio", IMESSAGE_ENABLED: "false" }))).toBe(
      false
    );
  });

  it("preserves connector-block activation", () => {
    expect(shouldEnable(context({}, { imessage: { enabled: true } }))).toBe(true);
    expect(shouldEnable(context({}, { imessage: { enabled: false } }))).toBe(false);
  });
});
