import { describe, expect, it } from "vitest";
import {
  removeSignalConnectorConfig,
  upsertSignalConnectorConfig,
} from "../src/lifeops/signal-runtime-config.js";

describe("signal runtime config helpers", () => {
  it("upserts the runtime connector config while preserving existing options", () => {
    const config = {
      connectors: {
        signal: {
          cliPath: "/opt/bin/signal-cli",
        },
      },
    };

    const changed = upsertSignalConnectorConfig(config, {
      authDir: "/tmp/signal-auth",
      account: "+15551234567",
    });

    expect(changed).toBe(true);
    expect(config).toEqual({
      connectors: {
        signal: {
          cliPath: "/opt/bin/signal-cli",
          authDir: "/tmp/signal-auth",
          account: "+15551234567",
          enabled: true,
        },
      },
    });
  });

  it("does not delete an unrelated Signal connector config", () => {
    const config = {
      connectors: {
        signal: {
          authDir: "/tmp/other",
          account: "+15550000000",
          enabled: true,
        },
      },
    };

    const changed = removeSignalConnectorConfig(config, {
      authDir: "/tmp/signal-auth",
      account: "+15551234567",
    });

    expect(changed).toBe(false);
    expect(config.connectors.signal).toBeDefined();
  });
});
