/**
 * Covers collectPluginNames' birdclaw gate: off by default on a hermetic host
 * (no binary on PATH, no data root), forced on/off by ELIZA_BIRDCLAW, auto-loaded
 * when BIRDCLAW_HOME points at an existing data root, config birdclaw:true/false
 * overriding auto-detection, and never loaded on mobile even when env forces it.
 * Deterministic, env-var driven with a nonexistent HOME/PATH; saves and restores
 * process.env.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ElizaConfig } from "../config/config.ts";
import { collectPluginNames } from "./plugin-collector.ts";

const BIRDCLAW = "@elizaos/plugin-birdclaw";

const ENV_KEYS = [
  "ELIZA_PLATFORM",
  "ELIZA_BIRDCLAW",
  "BIRDCLAW_BIN",
  "BIRDCLAW_HOME",
  "HOME",
  "PATH",
] as const;

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  // A hermetic host: no birdclaw binary on PATH, no ~/.birdclaw, no overrides.
  delete process.env.ELIZA_BIRDCLAW;
  delete process.env.BIRDCLAW_BIN;
  delete process.env.BIRDCLAW_HOME;
  process.env.HOME = "/nonexistent-home-for-birdclaw-test";
  process.env.PATH = "/nonexistent-bin-for-birdclaw-test";
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("collectPluginNames birdclaw gate", () => {
  it("stays off when the host has no birdclaw binary or data root", () => {
    const names = collectPluginNames({} as ElizaConfig);
    expect(names.has(BIRDCLAW)).toBe(false);
  });

  it("loads on ELIZA_BIRDCLAW=1 even without auto-detection", () => {
    process.env.ELIZA_BIRDCLAW = "1";
    const names = collectPluginNames({} as ElizaConfig);
    expect(names.has(BIRDCLAW)).toBe(true);
  });

  it("stays off on ELIZA_BIRDCLAW=0 even when a data root exists", () => {
    process.env.ELIZA_BIRDCLAW = "0";
    // Point BIRDCLAW_HOME at a directory that certainly exists.
    process.env.BIRDCLAW_HOME = process.cwd();
    const names = collectPluginNames({} as ElizaConfig);
    expect(names.has(BIRDCLAW)).toBe(false);
  });

  it("auto-loads when BIRDCLAW_HOME points at an existing data root", () => {
    process.env.BIRDCLAW_HOME = process.cwd();
    const names = collectPluginNames({} as ElizaConfig);
    expect(names.has(BIRDCLAW)).toBe(true);
  });

  it("config birdclaw:true wins over a missing host install", () => {
    const config = {
      agents: { defaults: { birdclaw: true } },
    } as unknown as ElizaConfig;
    const names = collectPluginNames(config);
    expect(names.has(BIRDCLAW)).toBe(true);
  });

  it("config birdclaw:false wins over auto-detection", () => {
    process.env.BIRDCLAW_HOME = process.cwd();
    const config = {
      agents: { defaults: { birdclaw: false } },
    } as unknown as ElizaConfig;
    const names = collectPluginNames(config);
    expect(names.has(BIRDCLAW)).toBe(false);
  });

  it("never loads on mobile even when forced by env", () => {
    process.env.ELIZA_PLATFORM = "android";
    process.env.ELIZA_BIRDCLAW = "1";
    const names = collectPluginNames({} as ElizaConfig);
    expect(names.has(BIRDCLAW)).toBe(false);
  });
});
