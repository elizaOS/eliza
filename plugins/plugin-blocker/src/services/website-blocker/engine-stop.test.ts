import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isWebsiteBlockedByPolicy,
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
