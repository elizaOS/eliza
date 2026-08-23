/**
 * Deterministic contract tests for the unsupported Signal boundary. The real
 * plugin object is exercised without replacing its initialization path.
 */
import { describe, expect, it } from "vitest";
import signalPlugin, { SIGNAL_DIRECT_TRANSPORT_UNAVAILABLE, signalUnsupportedError } from "./index";

describe("Signal direct transport cutover", () => {
  it("publishes no false runtime capability", () => {
    expect(signalPlugin.actions).toEqual([]);
    expect(signalPlugin.providers).toEqual([]);
    expect(signalPlugin.services).toEqual([]);
    expect(signalPlugin.routes).toEqual([]);
    expect(signalPlugin.connectorSources).toBeUndefined();
    expect(signalPlugin.autoEnable).toBeUndefined();
  });

  it("fails explicit imports with a typed unsupported error", async () => {
    await expect(signalPlugin.init?.({}, {} as never)).rejects.toMatchObject({
      code: SIGNAL_DIRECT_TRANSPORT_UNAVAILABLE,
      severity: "fatal",
      context: {
        requiredTransport: "in-process",
        externalProcessesAllowed: false,
      },
    });
    expect(signalUnsupportedError().message).toContain("unsupported");
  });
});
