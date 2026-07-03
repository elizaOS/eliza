/**
 * Seam test for the Anthropic subscription credential bridge (issue #12091,
 * item 19). The bridge symbol + contract are single-sourced in
 * `@elizaos/core`; app-core is the producer (it owns the `AccountPool`) and
 * `plugin-anthropic`'s credential store is the consumer. Both sides now
 * resolve the SAME `AnthropicAccountPoolBridge` via the shared
 * `getAnthropicAccountPoolBridge()` accessor rather than a hand-duplicated
 * `Symbol.for(...)` slot. This proves the producer publishes to that accessor,
 * the contract round-trips, and the shared setter clears it.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { saveAccount } from "@elizaos/auth/account-storage";
import {
  type AnthropicAccountPoolBridge,
  getAnthropicAccountPoolBridge,
  setAnthropicAccountPoolBridge,
} from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetDefaultAccountPoolForTests,
  configureDefaultAccountPoolSelection,
  getDefaultAccountPool,
} from "./account-pool.js";

const FAR_FUTURE = Date.now() + 10 * 365 * 24 * 60 * 60 * 1000;
let home: string;
let prevHome: string | undefined;
let prevStateDir: string | undefined;

beforeEach(() => {
  prevHome = process.env.ELIZA_HOME;
  prevStateDir = process.env.ELIZA_STATE_DIR;
  home = mkdtempSync(path.join(tmpdir(), "anthropic-bridge-"));
  process.env.ELIZA_HOME = home;
  process.env.ELIZA_STATE_DIR = home;
  configureDefaultAccountPoolSelection();
  setAnthropicAccountPoolBridge(null);
  __resetDefaultAccountPoolForTests();
});

afterEach(() => {
  __resetDefaultAccountPoolForTests();
  setAnthropicAccountPoolBridge(null);
  if (prevHome === undefined) delete process.env.ELIZA_HOME;
  else process.env.ELIZA_HOME = prevHome;
  if (prevStateDir === undefined) delete process.env.ELIZA_STATE_DIR;
  else process.env.ELIZA_STATE_DIR = prevStateDir;
  configureDefaultAccountPoolSelection();
  rmSync(home, { recursive: true, force: true });
});

describe("anthropic-bridge-seam", () => {
  it("publishes a bridge readable through the shared core accessor", () => {
    expect(getAnthropicAccountPoolBridge()).toBeNull();
    getDefaultAccountPool();
    const bridge = getAnthropicAccountPoolBridge();
    expect(bridge).not.toBeNull();
    // The consumer (plugin-anthropic) relies on exactly these methods.
    expect(typeof bridge?.selectAnthropicSubscription).toBe("function");
    expect(typeof bridge?.getAccessToken).toBe("function");
    expect(typeof bridge?.markInvalid).toBe("function");
    expect(typeof bridge?.markRateLimited).toBe("function");
  });

  it("selects a stored subscription and resolves its access token", async () => {
    saveAccount({
      id: "primary",
      providerId: "anthropic-subscription",
      label: "primary",
      source: "oauth",
      credentials: {
        access: "sk-ant-oat-PRIMARY",
        refresh: "sk-ant-oat-PRIMARY-refresh",
        expires: FAR_FUTURE,
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    getDefaultAccountPool();
    const bridge = getAnthropicAccountPoolBridge();
    const selected = await bridge?.selectAnthropicSubscription();
    expect(selected?.id).toBe("primary");
    const token = await bridge?.getAccessToken(
      "anthropic-subscription",
      "primary",
    );
    expect(token).toBe("sk-ant-oat-PRIMARY");
  });

  it("round-trips a hand-built bridge and clears via the shared setter", async () => {
    const marks: string[] = [];
    const fake: AnthropicAccountPoolBridge = {
      selectAnthropicSubscription: async () => ({ id: "x", expiresAt: 0 }),
      getAccessToken: async () => "tok",
      markInvalid: async (accountId) => {
        marks.push(`invalid:${accountId}`);
      },
      markRateLimited: async (accountId) => {
        marks.push(`rl:${accountId}`);
      },
    };
    setAnthropicAccountPoolBridge(fake);
    await getAnthropicAccountPoolBridge()?.markInvalid("x", "boom");
    expect(marks).toEqual(["invalid:x"]);
    setAnthropicAccountPoolBridge(null);
    expect(getAnthropicAccountPoolBridge()).toBeNull();
  });
});
