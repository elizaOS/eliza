import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { downloadAospVoiceAsset } from "../src/aosp-voice-download.js";
import {
  DEFAULT_NETWORK_POLICY_PREFERENCES,
  type RawNetworkState,
} from "../src/model-catalog/network-policy.js";

const roots: string[] = [];
const bytes = Buffer.from("complete model fixture");
const asset = {
  url: "https://huggingface.co/fixture/pinned/model",
  sizeBytes: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
};
const allowed = async (): Promise<RawNetworkState> => ({
  connectionType: "wifi",
  metered: false,
});
function destination() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "aosp-voice-download-"));
  roots.push(dir);
  return path.join(dir, "model");
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("AOSP automatic voice download", () => {
  it("retains the complete verified bytes on an allowed network", async () => {
    const target = destination();
    let probes = 0;
    await downloadAospVoiceAsset(asset, target, {
      preferences: { ...DEFAULT_NETWORK_POLICY_PREFERENCES, quietHours: [] },
      probe: async () => {
        probes++;
        return allowed();
      },
      fetchImpl: (async () => new Response(bytes)) as typeof fetch,
    });
    expect(readFileSync(target)).toEqual(bytes);
    expect(probes).toBeGreaterThanOrEqual(2);
  });
  for (const state of [
    { connectionType: "wifi", metered: true },
    { connectionType: "unknown", metered: null },
    { connectionType: "none", metered: null },
  ] as const) {
    it(`does not fetch on ${state.connectionType}/${state.metered}`, async () => {
      const target = destination();
      let fetched = false;
      await expect(
        downloadAospVoiceAsset(asset, target, {
          preferences: {
            ...DEFAULT_NETWORK_POLICY_PREFERENCES,
            quietHours: [],
          },
          probe: async () => state,
          fetchImpl: (async () => {
            fetched = true;
            return new Response(bytes);
          }) as typeof fetch,
        }),
      ).rejects.toThrow("allowed network");
      expect(fetched).toBe(false);
      expect(existsSync(target)).toBe(false);
    });
  }
  it("rejects changed network state before completing publication", async () => {
    let probes = 0;
    await expect(
      downloadAospVoiceAsset(asset, destination(), {
        preferences: { ...DEFAULT_NETWORK_POLICY_PREFERENCES, quietHours: [] },
        probe: async () =>
          ++probes === 1
            ? allowed()
            : { connectionType: "wifi", metered: true },
        now: (() => {
          let clock = 0;
          return () => (clock += 1001);
        })(),
        fetchImpl: (async () => new Response(bytes)) as typeof fetch,
      }),
    ).rejects.toThrow("allowed network");
    expect(probes).toBe(2);
  });
  it("rejects host loss during transfer", async () => {
    let probes = 0;
    await expect(
      downloadAospVoiceAsset(asset, destination(), {
        preferences: { ...DEFAULT_NETWORK_POLICY_PREFERENCES, quietHours: [] },
        probe: async () => {
          if (++probes > 1) throw new Error("host unavailable");
          return allowed();
        },
        now: (() => {
          let clock = 0;
          return () => (clock += 1001);
        })(),
        fetchImpl: (async () => new Response(bytes)) as typeof fetch,
      }),
    ).rejects.toThrow("host unavailable");
  });
  for (const received of [
    Buffer.from("incomplete"),
    Buffer.alloc(bytes.length),
    Buffer.alloc(bytes.length + 1),
  ]) {
    it(`rejects corrupt or incorrectly sized bytes (${received.length})`, async () => {
      await expect(
        downloadAospVoiceAsset(asset, destination(), {
          preferences: {
            ...DEFAULT_NETWORK_POLICY_PREFERENCES,
            quietHours: [],
          },
          probe: allowed,
          fetchImpl: (async () => new Response(received)) as typeof fetch,
        }),
      ).rejects.toThrow();
    });
  }
});
