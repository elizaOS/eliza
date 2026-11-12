/** Real process interleaving between a metadata read and its locked write. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDefaultAccountPool } from "../../src/accounts/account-pool.ts";
import {
  createRuntimeAccountStoragePolicy,
  saveAccount,
} from "../../src/auth/account-storage.ts";

const root = process.env.POOL_HEALTH_PROBE_ROOT;
assert(root, "Missing private probe root");
assert(
  process.env.NODE_ENV === "production" &&
    process.env.VITEST !== "true" &&
    process.env.BUN_ENV !== "test",
  "The process fixture requires persistent production encryption",
);
const mode = process.argv[2];
const probeMode = process.env.POOL_HEALTH_PROBE_MODE ?? "health";
const providerId =
  probeMode === "cooldown" ? "openai-codex" : "anthropic-subscription";
const emailMode = probeMode === "email";
const reverseMode =
  probeMode === "reverse" || probeMode === "expiry" || probeMode === "cooldown";
const id = "process-owner";
if (mode === "write-health") {
  const pool = getDefaultAccountPool();
  if (emailMode || reverseMode) {
    const current = pool.get(id, providerId);
    assert(current);
    await pool.upsert({
      ...current,
      ...(emailMode ? { email: "current@example.test" } : {}),
      ...(probeMode === "reverse"
        ? { usage: { sessionPct: 75, weeklyPct: 75, refreshedAt: 2 } }
        : {}),
      ...(probeMode === "cooldown"
        ? {
            usage: {
              sessionPct: 75,
              refreshedAt: 2,
              resetsAt: Date.now() + 3600000,
            },
          }
        : {}),
      ...(probeMode === "expiry"
        ? { subscriptionEndsAt: Date.now() + 86400000 }
        : {}),
    });
  } else {
    await pool.markNeedsReauth(id, "independent process verdict", {
      providerId,
    });
  }
} else {
  const resultFile = process.env.POOL_HEALTH_PROBE_RESULT;
  assert(resultFile, "Missing result file");
  const policy = createRuntimeAccountStoragePolicy(root);
  saveAccount(
    {
      id,
      providerId,
      label: "Process fixture",
      ...(emailMode ? {} : { email: "fixture@example.test" }),
      source: "oauth",
      credentials: {
        access: "fixture-access",
        refresh: "fixture-refresh",
        expires: Date.now() + 86_400_000,
      },
      createdAt: 1,
      updatedAt: 1,
    },
    policy,
  );
  const pool = getDefaultAccountPool();
  const original = pool.get(id, providerId);
  assert(original);
  await pool.upsert({
    ...original,
    usage: { sessionPct: 80, weeklyPct: 80, refreshedAt: 1 },
    ...(probeMode === "expiry" ? { subscriptionEndsAt: Date.now() - 1 } : {}),
  });
  const arrival = Promise.withResolvers<void>();
  let held: ServerResponse | undefined;
  let requestCount = 0;
  const server = createServer((_request, response) => {
    requestCount++;
    if (emailMode && requestCount === 1) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          five_hour: { utilization: 25 },
          seven_day: { utilization: 30 },
        }),
      );
      return;
    }
    held = response;
    arrival.resolve();
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const originalRead = fs.readFileSync;
  let barrierEntered = false;
  let armed = false;
  try {
    const pending = reverseMode
      ? Promise.resolve().then(async () => {
          if (probeMode === "expiry") return pool.sweepExpired(providerId);
          if (probeMode === "cooldown") {
            await pool.markRateLimited(
              id,
              Date.now() + 60000,
              "parent rate limit",
              { providerId },
            );
          } else {
            await pool.markNeedsReauth(id, "parent health verdict", {
              providerId,
            });
          }
          return undefined;
        })
      : pool.refreshUsage(id, "fixture-access", {
          providerId,
          fetch: ((_input, init) =>
            fetch(
              `http://127.0.0.1:${address.port}/usage`,
              init,
            )) as typeof fetch,
        });
    if (!reverseMode) await arrival.promise;
    armed = true;
    fs.readFileSync = ((file, ...args) => {
      const value = originalRead(file, ...args);
      const metadata = fs.statSync(
        path.join(root, "auth", "_pool-metadata.json"),
      );
      const opened = typeof file === "number" ? fs.fstatSync(file) : undefined;
      if (
        armed &&
        opened?.ino === metadata.ino &&
        opened.dev === metadata.dev
      ) {
        armed = false;
        barrierEntered = true;
        const child = spawnSync(
          process.execPath,
          [...process.execArgv, fileURLToPath(import.meta.url), "write-health"],
          { env: process.env, encoding: "utf8", timeout: 60_000 },
        );
        assert.equal(child.status, 0, `${child.stdout}${child.stderr}`);
      }
      return value;
    }) as typeof fs.readFileSync;
    syncBuiltinESMExports();
    if (!reverseMode) {
      assert(held);
      held.writeHead(200, { "content-type": "application/json" });
      held.end(
        JSON.stringify(
          emailMode
            ? { account: { email: "older-profile@example.test" } }
            : {
                five_hour: { utilization: 25 },
                seven_day: { utilization: 30 },
              },
        ),
      );
    }
    const operationResult = await pending;
    fs.readFileSync = originalRead;
    syncBuiltinESMExports();
    const observed = pool.get(id, providerId);
    fs.writeFileSync(
      resultFile,
      JSON.stringify({
        barrierEntered,
        health: observed?.health,
        detail: observed?.healthDetail?.lastError,
        usage: observed?.usage?.sessionPct,
        ...(emailMode ? { email: observed?.email } : {}),
        ...(probeMode === "expiry" ? { expiredCount: operationResult } : {}),
        ...(probeMode === "cooldown"
          ? {
              until: observed?.healthDetail?.until,
              reset: observed?.usage?.resetsAt,
            }
          : {}),
      }),
    );
  } finally {
    fs.readFileSync = originalRead;
    syncBuiltinESMExports();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
