import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  reconcileSelfControlBlockState,
  resetSelfControlStatusCache,
  startSelfControlBlock,
} from "./engine.ts";

/**
 * A hosts-file block works without DNS: the managed block maps each name to a
 * loopback sinkhole. The resolver check is supplementary, so a name that does
 * not resolve (offline machine, DNS outage, `.local` host) must not be read as
 * proof that the block is ineffective. Otherwise starting a block offline fails
 * and a running block is removed again.
 */
describe("resolver validation of a website block", () => {
  let tmpDir: string;
  let hostsFilePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-blocker-resolve-"));
    hostsFilePath = path.join(tmpDir, "hosts");
    fs.writeFileSync(hostsFilePath, "127.0.0.1 localhost\n", "utf8");
    resetSelfControlStatusCache();
  });

  afterEach(() => {
    resetSelfControlStatusCache();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("starts the block when the resolver returns no address", async () => {
    const started = await startSelfControlBlock(
      { websites: ["example.com"], durationMinutes: 30 },
      {
        hostsFilePath,
        validateSystemResolution: true,
        resolvedAddressLookup: async () => [],
      },
    );

    if (started.success !== true) {
      throw new Error(started.error);
    }
    expect(fs.readFileSync(hostsFilePath, "utf8")).toContain(
      "0.0.0.0 example.com",
    );
  });

  it("keeps a running block when the resolver returns no address", async () => {
    const started = await startSelfControlBlock(
      { websites: ["example.com"], durationMinutes: 30 },
      { hostsFilePath, validateSystemResolution: false },
    );
    expect(started.success).toBe(true);

    const status = await reconcileSelfControlBlockState({
      hostsFilePath,
      validateSystemResolution: true,
      resolvedAddressLookup: async () => [],
    });

    expect(status.active).toBe(true);
    expect(status.websites).toEqual(["example.com"]);
    expect(fs.readFileSync(hostsFilePath, "utf8")).toContain(
      "0.0.0.0 example.com",
    );
  });

  it("still rejects a block when the site resolves outside loopback", async () => {
    const started = await startSelfControlBlock(
      { websites: ["example.com"], durationMinutes: 30 },
      {
        hostsFilePath,
        validateSystemResolution: true,
        resolvedAddressLookup: async () => ["93.184.216.34"],
      },
    );

    expect(started.success).toBe(false);
    expect(fs.readFileSync(hostsFilePath, "utf8")).not.toContain(
      "0.0.0.0 example.com",
    );
  });
});
