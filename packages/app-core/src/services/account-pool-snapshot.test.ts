/** Real encrypted credential storage verifies request-scoped pool projections and freshness. */

import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createRuntimeAccountStoragePolicy,
  saveAccount,
} from "@elizaos/credentials/auth/account-storage";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  _resetAccountsRoutesPoolCache,
  handleAccountsRoutes,
} from "../../../agent/src/api/accounts-routes";
import {
  getAgentHostBridge,
  setAgentHostBridge,
} from "../../../agent/src/runtime/host-bridge";
import {
  __resetDefaultAccountPoolForTests,
  AccountPool,
  getDefaultAccountPool,
  type Strategy,
} from "./account-pool";

let root: string;
let previousHome: string | undefined;
let previousState: string | undefined;
beforeEach(() => {
  previousHome = process.env.ELIZA_HOME;
  previousState = process.env.ELIZA_STATE_DIR;
  root = mkdtempSync(path.join(tmpdir(), "pool-snapshot-"));
  process.env.ELIZA_HOME = root;
  process.env.ELIZA_STATE_DIR = root;
  __resetDefaultAccountPoolForTests();
  const policy = createRuntimeAccountStoragePolicy(root);
  for (const id of ["personal", "work"]) {
    saveAccount(
      {
        id,
        providerId: "anthropic-api",
        label: id,
        source: "api-key",
        credentials: { access: `synthetic-${id}`, refresh: "", expires: 0 },
        createdAt: id === "personal" ? 1 : 2,
        updatedAt: 1,
      },
      policy,
    );
  }
});
afterEach(() => {
  __resetDefaultAccountPoolForTests();
  if (previousHome === undefined) delete process.env.ELIZA_HOME;
  else process.env.ELIZA_HOME = previousHome;
  if (previousState === undefined) delete process.env.ELIZA_STATE_DIR;
  else process.env.ELIZA_STATE_DIR = previousState;
  rmSync(root, { recursive: true, force: true });
});

it("preserves all strategy projections and refreshes disabled eligibility only in the next snapshot", async () => {
  const pool = getDefaultAccountPool();
  const first = pool.readSnapshot();
  const strategies: Strategy[] = [
    "priority",
    "round-robin",
    "least-used",
    "quota-aware",
    "reset-soonest",
    "drain-soonest-reset",
  ];
  expect(first.list()).toEqual(pool.list());
  for (const strategy of strategies) {
    // Independent cursors compare the same operation, not successive rotations.
    const backing = {
      readAccounts: () =>
        Object.fromEntries(pool.list().map((account) => [account.id, account])),
      writeAccount: (account: Parameters<typeof pool.upsert>[0]) =>
        pool.upsert(account),
    };
    const projected = new AccountPool(backing).readSnapshot();
    const direct = new AccountPool(backing);
    for (let turn = 0; turn < 3; turn += 1) {
      expect(projected.selectionState("anthropic-api", strategy)).toEqual(
        direct.selectionState("anthropic-api", strategy),
      );
    }
  }
  expect(first.list("openai-codex")).toEqual([]);
  expect(first.selectionState("openai-codex")).toEqual({
    activeAccountId: null,
    reason: null,
  });
  const personal = pool.get("personal", "anthropic-api");
  if (!personal) throw new Error("real stored personal account missing");
  await pool.upsert({ ...personal, enabled: false });
  expect(first.selectionState("anthropic-api").activeAccountId).toBe(
    "personal",
  );
  const next = pool.readSnapshot();
  expect(next.selectionState("anthropic-api")).toEqual({
    activeAccountId: "work",
    reason: "only-eligible",
  });
  expect(
    next.list("anthropic-api").find((account) => account.id === "personal")
      ?.enabled,
  ).toBe(false);
});

it("keeps an acquired snapshot coherent while a subsequent request rejects corrupted storage", () => {
  const pool = getDefaultAccountPool();
  const first = pool.readSnapshot();
  const file = path.join(root, "auth", "anthropic-api", "work.json");
  const envelope = readFileSync(file, "utf8");
  expect(envelope).not.toContain("synthetic-work");
  writeFileSync(file, "{invalid");
  expect(first.list("anthropic-api").map((account) => account.id)).toEqual([
    "personal",
    "work",
  ]);
  expect(first.selectionState("anthropic-api").activeAccountId).toBe(
    "personal",
  );
  expect(() => pool.readSnapshot()).toThrow();
});

it("serves identical real HTTP inventory with two full reads instead of one per projection", async () => {
  const stored = getDefaultAccountPool();
  let reads = 0;
  const pool = new AccountPool({
    readAccounts: () => {
      reads += 1;
      return Object.fromEntries(
        stored
          .list()
          .map((account) => [`${account.providerId}:${account.id}`, account]),
      );
    },
    writeAccount: (account) => stored.upsert(account),
  });
  const priorBridge = getAgentHostBridge();
  const legacy = {
    list: pool.list.bind(pool),
    selectionState: pool.selectionState.bind(pool),
    sweepExpired: pool.sweepExpired.bind(pool),
  };
  const server = createServer((req, res) => {
    const json = (_res: typeof res, data: unknown, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    };
    void handleAccountsRoutes({
      req,
      res,
      method: "GET",
      pathname: "/api/accounts",
      json,
      error: (_res, message, status = 500) =>
        json(res, { error: message }, status),
      readJsonBody: async () => {
        throw new Error("GET must not read a body");
      },
      state: { config: {} },
      saveConfig: () => {
        throw new Error("GET must not save config");
      },
      // error-policy:J1 The real test HTTP boundary translates storage failure.
    }).catch(() => json(res, { error: "inventory failed" }, 500));
  });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("TCP address required");
    const url = `http://127.0.0.1:${address.port}/api/accounts`;
    setAgentHostBridge({ ...priorBridge, getDefaultAccountPool: () => legacy });
    _resetAccountsRoutesPoolCache();
    const baseline = await fetch(url);
    expect(baseline.status).toBe(200);
    const baselineBody = await baseline.json();
    expect(reads).toBeGreaterThan(2);
    reads = 0;
    setAgentHostBridge({ ...priorBridge, getDefaultAccountPool: () => pool });
    _resetAccountsRoutesPoolCache();
    const result = await fetch(url);
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual(baselineBody);
    expect(reads).toBe(2);
    writeFileSync(
      path.join(root, "auth", "anthropic-api", "work.json"),
      "{invalid",
    );
    expect((await fetch(url)).status).toBe(500);
  } finally {
    try {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    } finally {
      setAgentHostBridge(priorBridge);
      _resetAccountsRoutesPoolCache();
    }
  }
});
