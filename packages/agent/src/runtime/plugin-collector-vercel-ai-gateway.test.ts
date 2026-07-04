/**
 * Verifies collectPluginNames() enables the Vercel AI Gateway plugin purely from
 * an AI_GATEWAY_API_KEY env signal, recording the load reason without probing
 * cwd-relative or node_modules package paths. Deterministic — a real temp cwd
 * asserted to be package-free, no live model.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ElizaConfig } from "../config/config.ts";
import {
  collectPluginNames,
  type PluginLoadReasons,
} from "./plugin-collector.ts";

const ENV_KEYS = [
  "AI_GATEWAY_API_KEY",
  "AIGATEWAY_API_KEY",
  "ELIZAOS_CLOUD_API_KEY",
  "ELIZAOS_CLOUD_ENABLED",
  "ELIZA_CLOUD_PROVISIONED",
] as const;

let originalCwd: string;
let tempDir: string | null = null;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  originalCwd = process.cwd();
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  process.chdir(originalCwd);
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("collectPluginNames Vercel AI Gateway provider", () => {
  it("records env intent without probing for a cwd-relative package", () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "eliza-vercel-ai-gateway-"));
    process.chdir(tempDir);
    process.env.AI_GATEWAY_API_KEY = "test-gateway-key";

    expect(
      existsSync(path.join(tempDir, "plugins/plugin-vercel-ai-gateway")),
    ).toBe(false);
    expect(
      existsSync(
        path.join(tempDir, "node_modules/@elizaos/plugin-vercel-ai-gateway"),
      ),
    ).toBe(false);

    const reasons: PluginLoadReasons = new Map();
    const plugins = collectPluginNames({} as ElizaConfig, reasons);

    expect(plugins.has("@elizaos/plugin-vercel-ai-gateway")).toBe(true);
    expect(reasons.get("@elizaos/plugin-vercel-ai-gateway")).toBe(
      "env: AI_GATEWAY_API_KEY",
    );
  });
});
