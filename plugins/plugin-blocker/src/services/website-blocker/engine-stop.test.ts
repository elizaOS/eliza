import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isWebsiteBlockedByPolicy,
  reconcileSelfControlBlockState,
  resetSelfControlStatusCache,
  startSelfControlBlock,
  stopSelfControlBlock,
} from "./engine.ts";

/**
 * Tests for the website-blocker UNBLOCK path (#8801 / #9943). The status
 * returned by `stopSelfControlBlock` is what clients render and what
 * `isWebsiteBlockedByPolicy` is asked about, so the policy fields have to be
 * reset along with `active`. A temp hosts file keeps this off the real
 * `/etc/hosts` — no elevation is needed because the temp file is writable.
 */
describe("stopSelfControlBlock", () => {
  let tmpDir: string;
  let hostsFilePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-blocker-stop-"));
    hostsFilePath = path.join(tmpDir, "hosts");
    fs.writeFileSync(hostsFilePath, "127.0.0.1 localhost\n", "utf8");
    resetSelfControlStatusCache();
  });

  afterEach(() => {
    resetSelfControlStatusCache();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns an empty policy so the removed block no longer matches", async () => {
    const config = { hostsFilePath, validateSystemResolution: false };
    const started = await startSelfControlBlock(
      { websites: ["example.com"], durationMinutes: null },
      config,
    );
    expect(started.success).toBe(true);

    const stopped = await stopSelfControlBlock(config);
    if (stopped.success !== true) {
      throw new Error(stopped.error);
    }

    expect(stopped.removed).toBe(true);
    expect(stopped.status.active).toBe(false);
    expect(stopped.status.websites).toEqual([]);
    expect(stopped.status.blockedWebsites).toEqual([]);
    expect(stopped.status.allowedWebsites).toEqual([]);
    expect(stopped.status.requestedWebsites).toEqual([]);
    expect(isWebsiteBlockedByPolicy(stopped.status, "example.com")).toBe(false);
    expect(isWebsiteBlockedByPolicy(stopped.status, "www.example.com")).toBe(
      false,
    );
  });

  it("keeps the capability fields from the reconciled status", async () => {
    const config = { hostsFilePath, validateSystemResolution: false };
    await startSelfControlBlock(
      { websites: ["example.com"], durationMinutes: null },
      config,
    );

    const stopped = await stopSelfControlBlock(config);
    if (stopped.success !== true) {
      throw new Error(stopped.error);
    }

    expect(stopped.status.available).toBe(true);
    expect(stopped.status.hostsFilePath).toBe(hostsFilePath);
    expect(stopped.status.canUnblockEarly).toBe(true);
    expect(stopped.status.engine).toBe("hosts-file");
  });
});

/**
 * The hosts-file block is the primary mechanism; resolved-IP sinkholing is
 * supplementary (see `lookupResolvedAddressesForWebsiteBlock`). A target whose
 * name does not resolve — offline host, DNS outage, a typo — produced no
 * address at all, which is not evidence that the block is ineffective, and must
 * not lift a standing block.
 */
describe("reconcileSelfControlBlockState resolution validation", () => {
  let tmpDir: string;
  let hostsFilePath: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-blocker-resolve-"));
    hostsFilePath = path.join(tmpDir, "hosts");
    fs.writeFileSync(hostsFilePath, "127.0.0.1 localhost\n", "utf8");
    resetSelfControlStatusCache();
    const started = await startSelfControlBlock(
      { websites: ["example.com"], durationMinutes: null },
      { hostsFilePath, validateSystemResolution: false },
    );
    if (started.success !== true) {
      throw new Error(started.error);
    }
  });

  afterEach(() => {
    resetSelfControlStatusCache();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("keeps the block when a target does not resolve", async () => {
    const status = await reconcileSelfControlBlockState({
      hostsFilePath,
      validateSystemResolution: true,
      // ENOTFOUND / EAI_AGAIN, or a name with no A/AAAA records.
      resolvedAddressLookup: async () => [],
    });

    expect(status.active).toBe(true);
    expect(fs.readFileSync(hostsFilePath, "utf8")).toContain(
      "0.0.0.0 example.com",
    );
  });

  it("lifts the block when a target resolves outside loopback", async () => {
    const status = await reconcileSelfControlBlockState({
      hostsFilePath,
      validateSystemResolution: true,
      resolvedAddressLookup: async () => ["93.184.216.34"],
    });

    expect(status.active).toBe(false);
    expect(fs.readFileSync(hostsFilePath, "utf8")).not.toContain(
      "0.0.0.0 example.com",
    );
  });
});
