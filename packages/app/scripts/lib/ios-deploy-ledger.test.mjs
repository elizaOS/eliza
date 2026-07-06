/**
 * Unit tests for the physical-iPhone deploy ledger and the deploy-side
 * renderer-freshness compare (issue #14337). Exercises the real read/write/
 * update round-trip against a temp JSONL file and the pure stamp comparison
 * against fresh/stale manifest fixtures — no device, no simulator. Runs in the
 * packages/app vitest suite (`bun run --cwd packages/app test`, root
 * test:client lane).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendDeployRecord,
  buildDeployRecord,
  deployStatusForDevice,
  evaluateStagedRendererFreshness,
  latestDeployByUdid,
  parseDeployLedger,
  readDeployLedger,
  resolveDeployLedgerPath,
  resolveLedgerStateDir,
} from "./ios-deploy-ledger.mjs";
import {
  freshRendererManifestPath,
  readRendererManifest,
  rendererManifestPathFromAppPath,
} from "./ios-renderer-stamp.mjs";

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-ledger-"));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("resolveLedgerStateDir precedence", () => {
  const home = () => "/home/tester";
  it("prefers ELIZA_DEVICES_STATUS_DIR over every other source", () => {
    expect(
      resolveLedgerStateDir({
        env: {
          ELIZA_DEVICES_STATUS_DIR: "/d/state",
          MILADY_STATE_DIR: "/m/state",
          ELIZA_STATE_DIR: "/e/state",
        },
        homedir: home,
      }),
    ).toBe("/d/state");
  });
  it("prefers MILADY_STATE_DIR over ELIZA_STATE_DIR", () => {
    expect(
      resolveLedgerStateDir({
        env: { MILADY_STATE_DIR: "/m/state", ELIZA_STATE_DIR: "/e/state" },
        homedir: home,
      }),
    ).toBe("/m/state");
  });
  it("falls back to ELIZA_STATE_DIR", () => {
    expect(
      resolveLedgerStateDir({
        env: { ELIZA_STATE_DIR: "/e/state" },
        homedir: home,
      }),
    ).toBe("/e/state");
  });
  it("honors XDG_STATE_HOME + namespace", () => {
    expect(
      resolveLedgerStateDir({
        env: { XDG_STATE_HOME: "/xdg", ELIZA_NAMESPACE: "milady" },
        homedir: home,
      }),
    ).toBe(path.join("/xdg", "milady"));
  });
  it("defaults to ~/.local/state/eliza", () => {
    expect(resolveLedgerStateDir({ env: {}, homedir: home })).toBe(
      path.join("/home/tester", ".local", "state", "eliza"),
    );
  });
  it("resolveDeployLedgerPath appends the canonical ledger filename", () => {
    expect(
      resolveDeployLedgerPath({
        env: { ELIZA_STATE_DIR: "/e/state" },
        homedir: home,
      }),
    ).toBe(path.join("/e/state", "ios-device-deploy-ledger.jsonl"));
  });
});

describe("buildDeployRecord validation", () => {
  it("throws without a udid", () => {
    expect(() => buildDeployRecord({ buildId: "abc" })).toThrow(
      /udid is required/,
    );
  });
  it("throws without a buildId", () => {
    expect(() => buildDeployRecord({ udid: "UDID-1" })).toThrow(
      /buildId is required/,
    );
  });
  it("normalizes optionals and stamps deployedAt", () => {
    const record = buildDeployRecord({
      udid: "  UDID-1  ",
      buildId: " build-abc ",
      name: " iPhone 16 ",
      commit: "  ",
      skippedAppexes: true,
    });
    expect(record.udid).toBe("UDID-1");
    expect(record.buildId).toBe("build-abc");
    expect(record.name).toBe("iPhone 16");
    expect(record.commit).toBeNull();
    expect(record.skippedAppexes).toBe(true);
    expect(typeof record.deployedAt).toBe("string");
    expect(record.schema).toBe("elizaos.device.deploy-ledger/v1");
  });
});

describe("ledger write → read → update round-trip", () => {
  it("appends, reads back, and collapses to the latest per device", () => {
    const ledgerPath = path.join(tmpDir, "state", "device-deploy-ledger.jsonl");
    expect(readDeployLedger(ledgerPath)).toEqual([]); // missing file = empty

    appendDeployRecord(
      ledgerPath,
      buildDeployRecord({
        udid: "UDID-A",
        buildId: "build-1",
        commit: "commit-1",
        deployedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    appendDeployRecord(
      ledgerPath,
      buildDeployRecord({
        udid: "UDID-B",
        buildId: "build-9",
        deployedAt: "2026-01-01T01:00:00.000Z",
      }),
    );
    // Re-deploy to UDID-A with a newer build — the update path.
    appendDeployRecord(
      ledgerPath,
      buildDeployRecord({
        udid: "UDID-A",
        buildId: "build-2",
        commit: "commit-2",
        deployedAt: "2026-01-02T00:00:00.000Z",
      }),
    );

    const records = readDeployLedger(ledgerPath);
    expect(records).toHaveLength(3);

    const latest = latestDeployByUdid(records);
    expect(latest.get("UDID-A").buildId).toBe("build-2");
    expect(latest.get("UDID-A").commit).toBe("commit-2");
    expect(latest.get("UDID-B").buildId).toBe("build-9");
  });

  it("creates the state dir if absent", () => {
    const ledgerPath = path.join(tmpDir, "nested", "deep", "ledger.jsonl");
    appendDeployRecord(
      ledgerPath,
      buildDeployRecord({ udid: "UDID-C", buildId: "b" }),
    );
    expect(fs.existsSync(ledgerPath)).toBe(true);
  });
});

describe("deployStatusForDevice honest unknown path", () => {
  it("reports unknown for a device with no ledger entry", () => {
    const records = [buildDeployRecord({ udid: "UDID-A", buildId: "b1" })];
    const status = deployStatusForDevice(records, "UDID-UNSEEN");
    expect(status.known).toBe(false);
    expect(status.reason).toMatch(/unknown — no ledger entry/);
  });
  it("reports the latest record for a known device", () => {
    const records = [
      buildDeployRecord({
        udid: "UDID-A",
        buildId: "b1",
        deployedAt: "2026-01-01T00:00:00Z",
      }),
      buildDeployRecord({
        udid: "UDID-A",
        buildId: "b2",
        deployedAt: "2026-01-02T00:00:00Z",
      }),
    ];
    const status = deployStatusForDevice(records, "UDID-A");
    expect(status.known).toBe(true);
    expect(status.record.buildId).toBe("b2");
  });
  it("throws on an empty udid", () => {
    expect(() => deployStatusForDevice([], "  ")).toThrow(/udid is required/);
  });
});

describe("parseDeployLedger fail-closed on corruption", () => {
  it("skips blank lines only", () => {
    const text =
      '{"udid":"A","buildId":"b"}\n\n  \n{"udid":"B","buildId":"c"}\n';
    expect(parseDeployLedger(text)).toHaveLength(2);
  });
  it("throws with a line number on malformed JSONL", () => {
    const text = '{"udid":"A","buildId":"b"}\nnot-json\n';
    expect(() => parseDeployLedger(text)).toThrow(/line 2/);
  });
});

describe("evaluateStagedRendererFreshness", () => {
  it("passes when buildIds match", () => {
    const v = evaluateStagedRendererFreshness(
      { buildId: "build-abc" },
      { buildId: "build-abc" },
    );
    expect(v.fresh).toBe(true);
    expect(v.reason).toMatch(/matches freshly built/);
  });
  it("fails on a stale staged buildId with an actionable message", () => {
    const v = evaluateStagedRendererFreshness(
      { buildId: "build-OLD0" },
      { buildId: "build-NEW9" },
    );
    expect(v.fresh).toBe(false);
    expect(v.reason).toMatch(/STALE UI/);
    expect(v.reason).toMatch(/#9309/);
  });
  it("fails when the staged bundle has no buildId", () => {
    const v = evaluateStagedRendererFreshness(null, { buildId: "build-NEW9" });
    expect(v.fresh).toBe(false);
    expect(v.reason).toMatch(/no renderer buildId/);
  });
  it("fails when the fresh dist has no buildId", () => {
    const v = evaluateStagedRendererFreshness({ buildId: "build-abc" }, null);
    expect(v.fresh).toBe(false);
    expect(v.reason).toMatch(/freshly built dist has no renderer buildId/);
  });
});

describe("evaluateStagedRendererFreshness against real stamp fixtures", () => {
  function writeManifest(dir, manifest) {
    const target = path.join(dir, "eliza-renderer-build.json");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(target, JSON.stringify(manifest));
    return target;
  }

  // Reads real staged + fresh stamps through the shared ios-renderer-stamp lib,
  // then runs the ledger's freshness verdict over them — the end-to-end deploy
  // path (read staged, read fresh, decide) without a device.
  it("verdicts fresh when a real staged stamp matches the fresh dist stamp", () => {
    const appPublic = path.join(tmpDir, "App.app", "public");
    const dist = path.join(tmpDir, "dist");
    const stagedPath = writeManifest(appPublic, {
      buildId: "build-XYZ",
      commit: "deadbeef",
      variant: "device",
      runtimeMode: "local",
      builtAt: "2026-01-01T00:00:00Z",
    });
    writeManifest(dist, {
      buildId: "build-XYZ",
      commit: "deadbeef",
      variant: "device",
      runtimeMode: "local",
    });

    expect(rendererManifestPathFromAppPath(path.join(tmpDir, "App.app"))).toBe(
      stagedPath,
    );
    const staged = readRendererManifest(stagedPath, "staged");
    const fresh = readRendererManifest(
      freshRendererManifestPath({
        repoRoot: "/unused-repo-root",
        rendererDist: dist,
      }),
      "fresh",
    );
    expect(staged.buildId).toBe("build-XYZ");
    expect(staged.commit).toBe("deadbeef");
    expect(evaluateStagedRendererFreshness(staged, fresh).fresh).toBe(true);
  });
});
