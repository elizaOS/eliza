#!/usr/bin/env node
/**
 * Runs the facewear plugin's software-readiness steps in sequence — lint,
 * typecheck, tests, app-registration verification, and the smartglasses example
 * software checks — failing on the first failing step. This is the software half
 * of the smartglasses completion gate (the hardware half needs a real device).
 */
import { spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const steps = [
  {
    label: "Facewear plugin lint",
    command: "bun",
    args: ["run", "--cwd", "plugins/plugin-facewear", "lint"],
  },
  {
    label: "Facewear plugin typecheck",
    command: "bun",
    args: ["run", "--cwd", "plugins/plugin-facewear", "typecheck"],
  },
  {
    label: "Facewear plugin tests",
    command: "bun",
    args: ["run", "--cwd", "plugins/plugin-facewear", "test"],
  },
  {
    label: "Facewear app registration verification",
    command: "bun",
    args: ["run", "--cwd", "plugins/plugin-facewear", "verify:app"],
  },
  {
    label: "smartglasses example software verification",
    command: "bun",
    args: ["run", "--cwd", "packages/examples/smartglasses", "verify:software"],
  },
  {
    label: "Even Realities research audit self-test",
    command: "node",
    args: ["scripts/check-even-research-audit.mjs", "--self-test"],
  },
  {
    label: "Even Realities research audit",
    command: "node",
    args: ["scripts/check-even-research-audit.mjs"],
  },
  {
    label: "smartglasses completion gate self-test",
    command: "node",
    args: ["scripts/check-smartglasses-completion-gate.mjs", "--self-test"],
  },
];

for (const step of steps) {
  if (step.settleMs) {
    await sleep(step.settleMs);
  }
  console.log(`\n==> ${step.label}`);
  const result = spawnSync(step.command, step.args, {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

console.log("\nSmartglasses software verification complete.");
