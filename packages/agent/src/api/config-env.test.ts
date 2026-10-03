/**
 * The agent and the cloud plugin write the same `${stateDir}/config.env`.
 * They must share one writer (one in-process mutex); two independent promise
 * chains interleave read-modify-write cycles and silently drop updates.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as pluginConfigEnv from "@elizaos/plugin-elizacloud/lib/config-env";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as agentConfigEnv from "./config-env.ts";

// fsync-per-write is slow on a loaded CI host; the assertions are not timing-based.
const FS_TIMEOUT_MS = 60_000;

let stateDir: string;

beforeEach(async () => {
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-config-env-"));
});

afterEach(async () => {
  await fs.rm(stateDir, { recursive: true, force: true });
});

describe("config.env writer ownership", () => {
  it("agent and plugin-elizacloud share one writer", () => {
    expect(agentConfigEnv.persistConfigEnv).toBe(
      pluginConfigEnv.persistConfigEnv,
    );
  });

  it(
    "interleaved agent and plugin writes lose no updates",
    async () => {
      const keys = Array.from(
        { length: 16 },
        (_, i) => `ELIZA_TEST_SHARED_CONFIG_ENV_${i}`,
      );
      await Promise.all(
        keys.map((key, i) =>
          (i % 2 === 0 ? agentConfigEnv : pluginConfigEnv).persistConfigEnv(
            key,
            `v${i}`,
            { stateDir },
          ),
        ),
      );
      const onDisk = await agentConfigEnv.readConfigEnv(stateDir);
      for (const [i, key] of keys.entries()) {
        expect(onDisk[key]).toBe(`v${i}`);
        delete process.env[key];
      }
    },
    FS_TIMEOUT_MS,
  );
});
