import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isWebsiteBlockedByPolicy,
  parseSelfControlBlockRequest,
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
 * The action passes `durationMinutes` straight from planner parameters, which
 * may be a string the owner wrote ("2 hours"). A string must be read in the
 * unit it names: taking the numeric prefix turned a two-hour block into a
 * two-minute one.
 */
describe("parseSelfControlBlockRequest duration", () => {
  const parse = (durationMinutes: number | string | null) =>
    parseSelfControlBlockRequest({
      parameters: { websites: "x.com", durationMinutes },
    });

  it("converts an hour unit to minutes", () => {
    expect(parse("2 hours").request?.durationMinutes).toBe(120);
    expect(parse("1h").request?.durationMinutes).toBe(60);
  });

  it("reads a decimal hour unit", () => {
    expect(parse("1.5 hours").request?.durationMinutes).toBe(90);
  });

  it("keeps minute units and plain numbers as minutes", () => {
    expect(parse("90m").request?.durationMinutes).toBe(90);
    expect(parse("45 minutes").request?.durationMinutes).toBe(45);
    expect(parse("45").request?.durationMinutes).toBe(45);
  });

  it("rejects a duration it cannot read", () => {
    const parsed = parse("soon");
    expect(parsed.request).toBeNull();
    expect(parsed.error).toContain("minutes");
  });
});
