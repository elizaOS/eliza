/**
 * Verifies deterministic, collision-free homepage e2e ports for the co-hosted
 * production runner fleet, plus the stable local and override contracts.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  resolveHomepageE2eBaseUrl,
  resolveHomepageE2ePort,
} from "../scripts/e2e-port.mjs";

test("no runner name keeps the historical local port", () => {
  assert.equal(resolveHomepageE2ePort({}), 4444);
  assert.equal(resolveHomepageE2eBaseUrl({}), "http://127.0.0.1:4444");
});

test("the same runner always resolves the same port", () => {
  const env = { RUNNER_NAME: "eliza-prod-robot-2-r3" };
  const first = resolveHomepageE2ePort(env);
  assert.equal(resolveHomepageE2ePort(env), first);
  // The config and the web server compute this in separate processes; a
  // non-deterministic hash would bind one port and probe another.
  assert.equal(resolveHomepageE2eBaseUrl(env), `http://127.0.0.1:${first}`);
});

test("runners that share a host get distinct ports", () => {
  const ports = ["r1", "r2", "r3", "r4", "r5", "r6"].map((r) =>
    resolveHomepageE2ePort({ RUNNER_NAME: `eliza-prod-robot-2-${r}` }),
  );
  assert.equal(new Set(ports).size, ports.length, `collision within ${ports}`);
});

test("fleet ports stay inside the homepage CI range", () => {
  for (const host of ["2", "3", "4", "5", "6"]) {
    for (const r of ["r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8"]) {
      const port = resolveHomepageE2ePort({
        RUNNER_NAME: `eliza-prod-robot-${host}-${r}`,
      });
      assert.ok(port >= 24_000 && port < 24_000 + 64, `${port} out of window`);
    }
  }
});

test("fleet ports avoid co-hosted suites' fixed ports", () => {
  const reserved = new Set([4444, 4455, 4456, 4567, 4568, 4569]);
  for (const r of ["r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8"]) {
    const port = resolveHomepageE2ePort({
      RUNNER_NAME: `eliza-prod-robot-2-${r}`,
    });
    assert.equal(
      reserved.has(port),
      false,
      `${port} overlaps a co-hosted suite`,
    );
  }
});

test("nonstandard runner names resolve stably inside the CI range", () => {
  const env = { RUNNER_NAME: "hosted-runner-alpha" };
  const port = resolveHomepageE2ePort(env);
  assert.equal(resolveHomepageE2ePort(env), port);
  assert.ok(port >= 24_000 && port < 24_000 + 64);
});

test("an explicit override wins and is validated", () => {
  assert.equal(
    resolveHomepageE2ePort({ HOMEPAGE_E2E_PORT: "5000", RUNNER_NAME: "x" }),
    5000,
  );
  assert.throws(() => resolveHomepageE2ePort({ HOMEPAGE_E2E_PORT: "80" }));
  assert.throws(() => resolveHomepageE2ePort({ HOMEPAGE_E2E_PORT: "abc" }));
});
