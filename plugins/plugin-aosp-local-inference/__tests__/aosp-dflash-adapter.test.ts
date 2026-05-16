import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildDflashAdapter,
  shouldRouteViaDflash,
} from "../src/aosp-dflash-adapter";

function withEnv<T>(
  overrides: Record<string, string | undefined>,
  run: () => T,
): T {
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(overrides)) {
    previous.set(key, process.env[key]);
    const value = overrides[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function mkExecutableServerDir(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "aosp-dflash-adapter-"));
  const abiDir = path.join(root, "arm64-v8a");
  mkdirSync(abiDir, { recursive: true });
  const server = path.join(abiDir, "llama-server");
  writeFileSync(server, "#!/system/bin/sh\nexit 0\n");
  chmodSync(server, 0o755);
  return root;
}

describe("legacy DFlash server-spawn gate", () => {
  it("does not treat ELIZA_DFLASH as permission to spawn llama-server", () => {
    withEnv(
      {
        ELIZA_DFLASH: "1",
        ELIZA_DFLASH_SERVER_SPAWN: undefined,
      },
      () => {
        expect(shouldRouteViaDflash({ draftModelPath: "/tmp/draft.gguf" })).toBe(
          false,
        );
        expect(buildDflashAdapter("arm64", mkExecutableServerDir())).toBeNull();
      },
    );
  });

  it("keeps server spawn available as an explicit diagnostic escape hatch", () => {
    withEnv(
      {
        ELIZA_DFLASH: undefined,
        ELIZA_DFLASH_SERVER_SPAWN: "1",
      },
      () => {
        expect(shouldRouteViaDflash({ draftModelPath: "/tmp/draft.gguf" })).toBe(
          true,
        );
        expect(buildDflashAdapter("arm64", mkExecutableServerDir())).not.toBeNull();
      },
    );
  });
});
