/** Public pool status reads only the usage fields producers actually write. */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  LinkedAccountConfig,
  LinkedAccountUsage,
} from "@elizaos/host/protocol";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  __resetAccountPoolStatusForTests,
  AccountPool,
  getPublicAccountPoolStatus,
} from "./index.js";

const NOW = Date.UTC(2026, 8, 1, 12, 0, 0);
const HOUR = 3_600_000;
let root: string;
let previousState: string | undefined;

beforeEach(() => {
  previousState = process.env.ELIZA_STATE_DIR;
  root = mkdtempSync(path.join(tmpdir(), "pool-status-"));
  process.env.ELIZA_STATE_DIR = root;
});
afterEach(() => {
  __resetAccountPoolStatusForTests();
  if (previousState === undefined) delete process.env.ELIZA_STATE_DIR;
  else process.env.ELIZA_STATE_DIR = previousState;
  rmSync(root, { recursive: true, force: true });
});

function statusFor(usage: LinkedAccountUsage) {
  const account: LinkedAccountConfig = {
    id: "primary",
    providerId: "anthropic-subscription",
    label: "primary",
    source: "oauth",
    enabled: true,
    priority: 0,
    createdAt: 1,
    health: "ok",
    usage,
  };
  __resetAccountPoolStatusForTests({
    pool: new AccountPool({
      readAccounts: () => ({ primary: account }),
      writeAccount: async () => {},
    }),
    now: () => NOW,
    stateDir: () => root,
    queryConsumerUsage: async () => ({
      totals: {
        requests: 0,
        tokens: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        errors: 0,
        latencyMs: 0,
      },
      byDay: {},
      byConsumer: {},
      records: [],
    }),
  });
  return getPublicAccountPoolStatus();
}

it("derives resets from the producer-written resetsAt fields and publishes no phantom session reset", async () => {
  // Shape written by pollAnthropicUsage and kept by normalizeLinkedAccountUsage.
  const status = await statusFor({
    refreshedAt: NOW - 1000,
    sessionPct: 40,
    weeklyPct: 20,
    resetsAt: NOW + 48 * HOUR,
    weeklyModelBuckets: { "Fable 5": { pct: 30, resetsAt: NOW + 24 * HOUR } },
  });
  const [row] = status.perAccount;
  expect(row).toMatchObject({
    sessionUsedPct: 40,
    weeklyUsedPct: 20,
    fableUsedPct: 30,
    weeklyResetIn: "resets in 1d 0h",
  });
  // No producer writes a session-window reset, so the public status must not
  // advertise one that is structurally always null.
  expect(Object.keys(row)).not.toContain("sessionResetIn");
});

it("falls back to the all-model resetsAt when no fable bucket is reported", async () => {
  const status = await statusFor({
    refreshedAt: NOW - 1000,
    weeklyPct: 10,
    resetsAt: NOW + 3 * HOUR,
  });
  expect(status.perAccount[0]).toMatchObject({
    fableUsedPct: 10,
    weeklyResetIn: "resets in 3h 0m",
  });
  expect(status.fable.source).toBe("all-model weekly fallback");
});
