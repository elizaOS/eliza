import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadElizaConfig } from "./config.js";

describe("loadElizaConfig", () => {
  const originalEnv = { ...process.env };
  let stateDir: string;
  let configPath: string;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "milady-config-"));
    configPath = path.join(stateDir, "milady.json");
    process.env = {
      ...originalEnv,
      MILADY_STATE_DIR: stateDir,
      MILADY_CONFIG_PATH: configPath,
    };
    delete process.env.WALLET_SOURCE_EVM;
    delete process.env.MILADY_CLOUD_EVM_ADDRESS;
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
  });

  it("hydrates persisted config.env values into process.env only, not the config object", async () => {
    await fs.writeFile(
      configPath,
      JSON.stringify({
        logging: { level: "error" },
        env: {
          WALLET_SOURCE_EVM: "local",
        },
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(stateDir, "config.env"),
      `${[
        "WALLET_SOURCE_EVM=cloud",
        "MILADY_CLOUD_EVM_ADDRESS=0x1234567890abcdef1234567890abcdef12345678",
      ].join("\n")}\n`,
      "utf8",
    );

    const config = loadElizaConfig();

    // config.env values from file should be in process.env
    expect(process.env.WALLET_SOURCE_EVM).toBe("cloud");
    expect(process.env.MILADY_CLOUD_EVM_ADDRESS).toBe(
      "0x1234567890abcdef1234567890abcdef12345678",
    );

    // Security: config.env secrets should NOT be merged into config.env
    // (they're process-env-only to avoid serializing sensitive values to milady.json)
    expect(
      (config.env as Record<string, string | undefined>).WALLET_SOURCE_EVM,
    ).toBe("local"); // from config file, not overridden by config.env
    expect(
      (config.env as Record<string, string | undefined>)
        .MILADY_CLOUD_EVM_ADDRESS,
    ).toBeUndefined(); // NOT in config, only in process.env
  });
});
