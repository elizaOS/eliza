/**
 * REAL-CLI suite — excluded from the default vitest lane (root config drops
 * `*.real.test.*`). Run with:
 *
 *   bun run --cwd plugins/plugin-birdclaw test:real
 *
 * Requires a birdclaw binary (BIRDCLAW_REAL_BIN, or `birdclaw` on PATH). The
 * suite creates a throwaway BIRDCLAW_HOME, runs `birdclaw init` (which seeds
 * the demo dataset), and drives the REAL service methods end to end — the
 * same spawn path, JSON envelopes, and parsers production uses. No mocks.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BirdclawService } from "./service.ts";

function resolveRealBin(): string | null {
  const fromEnv = process.env.BIRDCLAW_REAL_BIN?.trim();
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const rawPath = process.env.PATH ?? "";
  for (const dir of rawPath.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, "birdclaw");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const REAL_BIN = resolveRealBin();

describe.skipIf(!REAL_BIN)("birdclaw real CLI", () => {
  let home: string;
  let service: BirdclawService;

  beforeAll(() => {
    home = mkdtempSync(path.join(tmpdir(), "birdclaw-real-"));
    execFileSync(REAL_BIN as string, ["init"], {
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        BIRDCLAW_HOME: home,
      },
      stdio: "ignore",
    });
    const runtime = {
      getSetting: (key: string) =>
        key === "BIRDCLAW_BIN"
          ? (REAL_BIN as string)
          : key === "BIRDCLAW_HOME"
            ? home
            : undefined,
    } as unknown as IAgentRuntime;
    service = new BirdclawService(runtime);
  });

  afterAll(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("probes availability and reads real status", async () => {
    await expect(service.isAvailable()).resolves.toBe(true);
    const status = await service.status();
    expect(status.installed).toBe(true);
    expect(status.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(status.home).toBe(home);
    // init seeds the demo dataset — counts are real rows in a real SQLite DB.
    expect(status.counts).not.toBeNull();
    expect(status.counts?.home).toBeGreaterThan(0);
    expect(status.transport).not.toBeNull();
  });

  it("searches the seeded archive through the real envelope", async () => {
    const tweets = await service.searchTweets({ limit: 10 });
    expect(tweets.length).toBeGreaterThan(0);
    for (const tweet of tweets) {
      expect(tweet.id).toBeTruthy();
      expect(tweet.text).toBeTruthy();
      expect(Number.isNaN(new Date(tweet.createdAt).getTime())).toBe(false);
    }
  });

  it("filters liked tweets for the Likes tab query", async () => {
    const liked = await service.searchTweets({ liked: true, limit: 10 });
    for (const tweet of liked) {
      expect(tweet.liked).toBe(true);
    }
  });

  it("reads the ranked inbox", async () => {
    const items = await service.inbox({ kind: "mixed", limit: 10 });
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.id).toBeTruthy();
      expect(item.text).toBeTruthy();
    }
  });

  it("reports a clean not-installed state for a bogus binary", async () => {
    const runtime = {
      getSetting: (key: string) =>
        key === "BIRDCLAW_BIN" ? "/nonexistent/birdclaw-missing" : undefined,
    } as unknown as IAgentRuntime;
    const missing = new BirdclawService(runtime);
    await expect(missing.isAvailable()).resolves.toBe(false);
    const status = await missing.status();
    expect(status.installed).toBe(false);
    expect(status.message).toContain("brew install steipete/tap/birdclaw");
  });
});
