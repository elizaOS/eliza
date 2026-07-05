/**
 * Device renderer-status tests cover the pure freshness decisions that gate
 * stale mobile installs before adb, simctl, or devicectl touch real hardware.
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendIosDeployLedgerEntry,
  commitsMatch,
  decideAndroidInstall,
  evaluateRendererFreshness,
  latestIosDeployLedgerEntry,
  readIosDeployLedgerEntries,
} from "../scripts/lib/device-renderer-status.mjs";

describe("device renderer status", () => {
  it("accepts matching build ids and develop commits", () => {
    expect(
      evaluateRendererFreshness({
        installed: { buildId: "same", commit: "abcdef1234567890" },
        fresh: { buildId: "same" },
        developHead: "abcdef1234567890",
      }),
    ).toEqual({
      verdict: "FRESH",
      reason: "installed buildId matches fresh buildId same",
    });
  });

  it("flags mismatched build ids as stale", () => {
    expect(
      evaluateRendererFreshness({
        installed: { buildId: "old", commit: "abcdef" },
        fresh: { buildId: "new" },
      }),
    ).toEqual({
      verdict: "STALE",
      reason: "installed buildId old != fresh buildId new",
    });
  });

  it("flags missing installed stamps as unknown", () => {
    expect(evaluateRendererFreshness({ fresh: { buildId: "new" } })).toEqual({
      verdict: "UNKNOWN",
      reason: "app is not installed or no installed stamp is available",
    });
  });

  it("compares full and shortened commits", () => {
    expect(commitsMatch("abcdef1234567890", "abcdef123456")).toBe(true);
    expect(commitsMatch("abcdef123456", "abcdef1234567890")).toBe(true);
    expect(commitsMatch("abcdef123456", "fedcba123456")).toBe(false);
  });

  it("lets Android skip install only when installed matches fresh", () => {
    expect(
      decideAndroidInstall({
        installed: { buildId: "same" },
        fresh: { buildId: "same" },
      }),
    ).toEqual({
      install: false,
      status: {
        verdict: "FRESH",
        reason: "installed buildId matches fresh buildId same",
      },
    });
  });

  it("fails Android skip-build when installed is stale", () => {
    expect(
      decideAndroidInstall({
        installed: { buildId: "old" },
        fresh: { buildId: "new" },
        skipBuild: true,
      }),
    ).toEqual({
      install: false,
      status: {
        verdict: "STALE",
        reason: "installed buildId old != fresh buildId new",
      },
      error:
        "--skip-build requires installed renderer == fresh dist; installed buildId old != fresh buildId new",
    });
  });

  it("round-trips the latest physical iOS deploy ledger entry", () => {
    const stateDir = mkdtempSync(path.join(os.tmpdir(), "device-status-"));
    try {
      appendIosDeployLedgerEntry({
        stateDir,
        device: { identifier: "dev-1", udid: "UDID-1", name: "Phone" },
        bundleId: "ai.elizaos.app",
        stamp: { buildId: "old", commit: "aaa" },
        deployedAt: "2026-07-05T00:00:00.000Z",
      });
      appendIosDeployLedgerEntry({
        stateDir,
        device: { identifier: "dev-1", udid: "UDID-1", name: "Phone" },
        bundleId: "ai.elizaos.app",
        stamp: { buildId: "new", commit: "bbb" },
        deployedAt: "2026-07-05T01:00:00.000Z",
      });

      const latest = latestIosDeployLedgerEntry({
        entries: readIosDeployLedgerEntries({ stateDir }),
        udid: "udid-1",
        bundleId: "ai.elizaos.app",
      });
      expect(latest?.buildId).toBe("new");
      expect(latest?.commit).toBe("bbb");
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
