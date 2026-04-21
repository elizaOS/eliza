/**
 * Provider snapshot tests — exercise the real enable-state readers
 * against env vars + filesystem, no mocks. Asserts that each provider
 * reports enabled/disabled correctly given controlled environment state.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BUILT_IN_PROVIDERS, snapshotProviders } from "./providers";

const ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GROK_API_KEY",
  "XAI_API_KEY",
  "ELIZA_CLOUD_TOKEN",
  "ELIZACLOUD_TOKEN",
  "ELIZAOS_API_KEY",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "MISTRAL_API_KEY",
  "ELIZA_DEVICE_BRIDGE_ENABLED",
  "ELIZA_STATE_DIR",
];

describe("provider snapshot (real env-state readers)", () => {
  let saved: Record<string, string | undefined>;
  let savedCapacitor:
    | { isNativePlatform?: () => boolean; getPlatform?: () => string }
    | undefined;
  let tmpState: string;

  beforeEach(async () => {
    tmpState = await fs.mkdtemp(path.join(os.tmpdir(), "milady-provider-"));
    saved = {};
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    savedCapacitor = (
      globalThis as {
        Capacitor?: {
          isNativePlatform?: () => boolean;
          getPlatform?: () => string;
        };
      }
    ).Capacitor;
    delete (
      globalThis as {
        Capacitor?: {
          isNativePlatform?: () => boolean;
          getPlatform?: () => string;
        };
      }
    ).Capacitor;
    process.env.ELIZA_STATE_DIR = tmpState;
  });

  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
    if (savedCapacitor) {
      (
        globalThis as {
          Capacitor?: {
            isNativePlatform?: () => boolean;
            getPlatform?: () => string;
          };
        }
      ).Capacitor = savedCapacitor;
    } else {
      delete (
        globalThis as {
          Capacitor?: {
            isNativePlatform?: () => boolean;
            getPlatform?: () => string;
          };
        }
      ).Capacitor;
    }
    await fs.rm(tmpState, { recursive: true, force: true });
  });

  it("exposes every expected provider id", async () => {
    const ids = BUILT_IN_PROVIDERS.map((p) => p.id);
    for (const expected of [
      "milady-local-inference",
      "milady-device-bridge",
      "capacitor-llama",
      "anthropic",
      "openai",
      "grok",
      "google",
      "mistral",
      "elizacloud",
    ]) {
      expect(ids).toContain(expected);
    }
  });

  it("anthropic is disabled without ANTHROPIC_API_KEY", async () => {
    const snap = await snapshotProviders();
    const p = snap.find((s) => s.id === "anthropic");
    expect(p?.enableState.enabled).toBe(false);
  });

  it("anthropic is enabled when ANTHROPIC_API_KEY is set", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const snap = await snapshotProviders();
    const p = snap.find((s) => s.id === "anthropic");
    expect(p?.enableState.enabled).toBe(true);
  });

  it("grok accepts either GROK_API_KEY or XAI_API_KEY", async () => {
    process.env.XAI_API_KEY = "xai-test";
    const snap = await snapshotProviders();
    expect(snap.find((s) => s.id === "grok")?.enableState.enabled).toBe(true);
  });

  it("google accepts either GOOGLE_API_KEY or GEMINI_API_KEY", async () => {
    process.env.GEMINI_API_KEY = "gemini-test";
    const snap = await snapshotProviders();
    expect(snap.find((s) => s.id === "google")?.enableState.enabled).toBe(true);
  });

  it("device-bridge requires ELIZA_DEVICE_BRIDGE_ENABLED=1", async () => {
    let snap = await snapshotProviders();
    expect(
      snap.find((s) => s.id === "milady-device-bridge")?.enableState.enabled,
    ).toBe(false);

    process.env.ELIZA_DEVICE_BRIDGE_ENABLED = "1";
    snap = await snapshotProviders();
    expect(
      snap.find((s) => s.id === "milady-device-bridge")?.enableState.enabled,
    ).toBe(true);
  });

  it("capacitor-llama is enabled only inside a native Capacitor runtime", async () => {
    let snap = await snapshotProviders();
    expect(snap.find((s) => s.id === "capacitor-llama")?.enableState.enabled).toBe(
      false,
    );

    (
      globalThis as {
        Capacitor?: {
          isNativePlatform?: () => boolean;
          getPlatform?: () => string;
        };
      }
    ).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => "ios",
    };

    snap = await snapshotProviders();
    const provider = snap.find((s) => s.id === "capacitor-llama");
    expect(provider?.enableState.enabled).toBe(true);
    expect(provider?.enableState.reason).toContain("Native Capacitor");
  });

  it("local is enabled only when a GGUF exists under the state dir", async () => {
    // No file yet → disabled
    let snap = await snapshotProviders();
    expect(
      snap.find((s) => s.id === "milady-local-inference")?.enableState.enabled,
    ).toBe(false);

    // Drop a real .gguf file in place
    const modelsDir = path.join(tmpState, "local-inference", "models");
    await fs.mkdir(modelsDir, { recursive: true });
    await fs.writeFile(
      path.join(modelsDir, "test.gguf"),
      Buffer.from("GGUF\x00\x00\x00\x00"),
    );

    snap = await snapshotProviders();
    expect(
      snap.find((s) => s.id === "milady-local-inference")?.enableState.enabled,
    ).toBe(true);
  });

  it("every provider declares at least one supported slot", async () => {
    const snap = await snapshotProviders();
    for (const p of snap) {
      expect(p.supportedSlots.length).toBeGreaterThan(0);
    }
  });
});
