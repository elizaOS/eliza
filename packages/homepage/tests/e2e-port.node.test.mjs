/**
 * Pins the per-runner e2e port resolution (#17357 CI class).
 *
 * A fixed 4444 made two homepage e2e jobs on the same self-hosted host race
 * for one port; the loser died with "already used" regardless of its diff.
 * These assert the properties that make the fix correct: determinism (the
 * config and the web server resolve independently and MUST agree), distinctness
 * across the runners that share a host, and an unchanged local default.
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
  // The exact fleet layout that collided: six runners on one box.
  const ports = ["r1", "r2", "r3", "r4", "r5", "r6"].map((r) =>
    resolveHomepageE2ePort({ RUNNER_NAME: `eliza-prod-robot-2-${r}` }),
  );
  assert.equal(new Set(ports).size, ports.length, `collision within ${ports}`);
});

test("ports stay inside the reserved window", () => {
  for (const host of ["2", "3", "4", "5", "6"]) {
    for (const r of ["r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8"]) {
      const port = resolveHomepageE2ePort({
        RUNNER_NAME: `eliza-prod-robot-${host}-${r}`,
      });
      assert.ok(port >= 4444 && port < 4444 + 64, `${port} out of window`);
    }
  }
});

test("an explicit override wins and is validated", () => {
  assert.equal(
    resolveHomepageE2ePort({ HOMEPAGE_E2E_PORT: "5000", RUNNER_NAME: "x" }),
    5000,
  );
  assert.throws(() => resolveHomepageE2ePort({ HOMEPAGE_E2E_PORT: "80" }));
  assert.throws(() => resolveHomepageE2ePort({ HOMEPAGE_E2E_PORT: "abc" }));
});
