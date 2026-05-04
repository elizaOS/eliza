import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface IsolatedConfigEnv {
  configPath: string;
  restore: () => Promise<void>;
}

export function useIsolatedConfigEnv(
  prefix = "eliza-test-config-",
): IsolatedConfigEnv {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const configPath = path.join(tempDir, "eliza.json");
  const previousElizaConfigPath = process.env.ELIZA_CONFIG_PATH;

  process.env.ELIZA_CONFIG_PATH = configPath;

  return {
    configPath,
    restore: async () => {
      if (previousElizaConfigPath === undefined) {
        delete process.env.ELIZA_CONFIG_PATH;
      } else {
        process.env.ELIZA_CONFIG_PATH = previousElizaConfigPath;
      }

      await fsp
        .rm(tempDir, { recursive: true, force: true })
        .catch(() => undefined);
    },
  };
}
