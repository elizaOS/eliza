import { describe, expect, it } from "vitest";
import { upsertSignalConnectorConfig } from "./signal-runtime-config.ts";

describe("upsertSignalConnectorConfig", () => {
  it("creates the connector config when absent", () => {
    const config: Record<string, unknown> = {};
    const changed = upsertSignalConnectorConfig(config, {
      authDir: "/tmp/signal",
      account: "+123",
    });
    expect(changed).toBe(true);
    const signal = config.connectors?.signal as Record<string, unknown>;
    expect(signal.authDir).toBe("/tmp/signal");
    expect(signal.account).toBe("+123");
    expect(signal.enabled).toBe(true);
  });

  it("updates when values differ", () => {
    const config = {
      connectors: { signal: { authDir: "/old", account: "+1", enabled: true } },
    };
    const changed = upsertSignalConnectorConfig(config, {
      authDir: "/new",
      account: "+2",
    });
    expect(changed).toBe(true);
    expect(config.connectors.signal.authDir).toBe("/new");
  });

  it("returns false when nothing changed", () => {
    const config = {
      connectors: { signal: { authDir: "/s", account: "+1", enabled: true } },
    };
    const changed = upsertSignalConnectorConfig(config, {
      authDir: "/s",
      account: "+1",
    });
    expect(changed).toBe(false);
  });

  it("ignores malformed existing connector config", () => {
    const config = { connectors: { signal: "not-an-object" } };
    const changed = upsertSignalConnectorConfig(config, {
      authDir: "/s",
      account: "+1",
    });
    expect(changed).toBe(true);
    expect(config.connectors.signal).toEqual({
      authDir: "/s",
      account: "+1",
      enabled: true,
    });
  });
});
