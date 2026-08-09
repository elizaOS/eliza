/**
 * Exercises the app runner through real Playwright launcher and worker
 * processes, including stale-environment isolation for default E2E.
 */

import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  auditProjectsRequestedByArgs,
  propagatedAuditProjects,
  resolveRequestedAuditProjects,
  UI_SMOKE_AUDIT_PROJECTS,
  UI_SMOKE_AUDIT_PROJECTS_ENV,
  writeAuditProjectPropagation,
} from "./lib/playwright-audit-projects.mjs";

const appDir = path.resolve(import.meta.dirname, "..");
const runner = path.join(appDir, "scripts", "run-ui-playwright.mjs");
const workerContract = "test/ui-smoke/audit-project-worker-contract.spec.ts";

function runPlaywright(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.platform === "win32" ? "node.exe" : "node",
      [runner, ...args],
      {
        cwd: appDir,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 20_000);
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (timedOut) {
        reject(
          new Error(
            `Playwright audit-project regression timed out.\n${stdout}${stderr}`,
          ),
        );
        return;
      }
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

describe("audit-project propagation contract", () => {
  test("normalizes both Playwright project argument forms", () => {
    expect(
      auditProjectsRequestedByArgs([
        "--project=chromium",
        "--project=audit-cloud",
        "--project",
        "audit-app",
        "--project=audit-cloud",
      ]),
    ).toEqual(["audit-app", "audit-cloud"]);
    expect(
      resolveRequestedAuditProjects({
        argv: ["--project=audit-app-dropdown"],
        serialized: "audit-cloud",
      }),
    ).toEqual(["audit-cloud", "audit-app-dropdown"]);
  });

  test("rejects unsupported propagated names", () => {
    expect(() => propagatedAuditProjects("audit-app,chromium")).toThrow(
      "Unsupported propagated UI-smoke audit project(s): chromium",
    );
  });

  test("overwrites and clears propagation state", () => {
    const env = { [UI_SMOKE_AUDIT_PROJECTS_ENV]: "audit-app" };
    writeAuditProjectPropagation(env, ["audit-cloud"]);
    expect(env[UI_SMOKE_AUDIT_PROJECTS_ENV]).toBe("audit-cloud");
    writeAuditProjectPropagation(env, []);
    expect(env).not.toHaveProperty(UI_SMOKE_AUDIT_PROJECTS_ENV);
  });
});

test("propagates audit projects to workers without enabling them by default", async () => {
  const tempRoot = mkdtempSync(
    path.join(tmpdir(), "eliza-audit-project-propagation-"),
  );
  const server = http.createServer((_, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("audit project regression\n");
  });

  await listen(server);
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error(
      "Audit-project regression server did not expose a TCP port.",
    );
  }

  const baseEnv = {
    ...process.env,
    ELIZA_AUDIT_APP_DIR: path.join(tempRoot, "audit-output"),
    ELIZA_UI_SMOKE_REUSE_SERVER: "1",
    ELIZA_UI_SMOKE_PORT: String(address.port),
    ELIZA_UI_SMOKE_SKIP_BUILD: "1",
    ELIZA_UI_SMOKE_SKIP_CORE_BUILD: "1",
    ELIZA_UI_SMOKE_SKIP_VIEW_BUILD: "1",
    ELIZA_UI_SMOKE_VIEW_LOCK_NAMESPACE: `audit-project-regression-${process.pid}`,
  };

  try {
    for (const project of UI_SMOKE_AUDIT_PROJECTS) {
      const result = await runPlaywright(
        [
          "--config",
          "playwright.ui-smoke.config.ts",
          `--project=${project}`,
          workerContract,
        ],
        baseEnv,
      );
      expect(
        result.code,
        `${project} failed across the Playwright worker boundary:\n${result.stdout}${result.stderr}`,
      ).toBe(0);
      expect(`${result.stdout}${result.stderr}`).not.toContain(
        `Project "${project}" not found in the worker process`,
      );
    }

    const defaultResult = await runPlaywright(
      [
        "--config",
        "playwright.ui-smoke.config.ts",
        "--list",
        "--pass-with-no-tests",
        workerContract,
      ],
      {
        ...baseEnv,
        [UI_SMOKE_AUDIT_PROJECTS_ENV]: "audit-app",
      },
    );
    expect(
      defaultResult.code,
      `default E2E project selection failed:\n${defaultResult.stdout}${defaultResult.stderr}`,
    ).toBe(0);
    expect(defaultResult.stdout).toMatch(/Total:\s+0 tests/);
    for (const project of UI_SMOKE_AUDIT_PROJECTS) {
      expect(defaultResult.stdout).not.toContain(`[${project}]`);
    }
  } finally {
    await close(server);
    rmSync(tempRoot, { recursive: true, force: true });
  }
}, 45_000);
