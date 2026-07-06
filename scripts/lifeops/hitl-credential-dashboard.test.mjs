/**
 * Loopback integration coverage for the HITL credential dashboard's write
 * boundary. The test starts the real dashboard process with an isolated HOME so
 * forged browser-style POSTs can prove they do not mutate any operator env file.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const ROOT = resolve(new URL("../..", import.meta.url).pathname);

function tempDir(prefix) {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

function waitForDashboard(child) {
  return new Promise((resolvePromise, reject) => {
    let output = "";
    const timer = setTimeout(() => {
      reject(new Error(`dashboard did not start:\n${output}`));
    }, 20_000);
    const onData = (chunk) => {
      output += chunk.toString();
      const match = /listening on (http:\/\/127\.0\.0\.1:\d+\/)/.exec(output);
      if (!match) return;
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.stderr.off("data", onData);
      resolvePromise(match[1]);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (status, signal) => {
      clearTimeout(timer);
      reject(
        new Error(
          `dashboard exited before listening: status=${status} signal=${signal}\n${output}`,
        ),
      );
    });
  });
}

async function postEnv(baseUrl, headers, value) {
  return fetch(`${baseUrl}api/env`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify({
      key: "TELEGRAM_BOT_TOKEN",
      value,
      target: "home",
    }),
  });
}

test("credential dashboard rejects cross-site writes and requires its page session", async () => {
  const home = tempDir("hitl-dashboard-home-");
  const child = spawn(
    "node",
    ["scripts/lifeops/hitl-credential-dashboard.mjs"],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        HOME: home,
        XDG_CONFIG_HOME: join(home, ".config"),
        XDG_CACHE_HOME: join(home, ".cache"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const envPath = join(home, ".eliza", ".env");
  try {
    const baseUrl = await waitForDashboard(child);
    const sameOrigin = new URL(baseUrl).origin;

    const forged = await postEnv(
      baseUrl,
      { Origin: "http://attacker.invalid" },
      "attacker-token",
    );
    assert.equal(forged.status, 403);
    assert.equal(existsSync(envPath), false);

    const pageResponse = await fetch(baseUrl);
    assert.equal(pageResponse.status, 200);
    const pageHtml = await pageResponse.text();
    const tokenMatch = /var SESSION_TOKEN = "([^"]+)";/.exec(pageHtml);
    assert.ok(tokenMatch, "dashboard page exposes a per-process session token");

    const missingToken = await postEnv(
      baseUrl,
      { Origin: sameOrigin },
      "missing-session-token",
    );
    assert.equal(missingToken.status, 403);
    assert.equal(existsSync(envPath), false);

    const wrongContentType = await fetch(`${baseUrl}api/env`, {
      method: "POST",
      headers: {
        Origin: sameOrigin,
        "Content-Type": "text/plain",
        "X-HITL-Session": tokenMatch[1],
      },
      body: JSON.stringify({
        key: "TELEGRAM_BOT_TOKEN",
        value: "wrong-content-type",
        target: "home",
      }),
    });
    assert.equal(wrongContentType.status, 415);
    assert.equal(existsSync(envPath), false);

    const saved = await postEnv(
      baseUrl,
      { Origin: sameOrigin, "X-HITL-Session": tokenMatch[1] },
      "operator-token-value",
    );
    assert.equal(saved.status, 200);
    assert.match(
      readFileSync(envPath, "utf8"),
      /TELEGRAM_BOT_TOKEN=operator-token-value/,
    );
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolvePromise) => child.once("exit", resolvePromise));
    rmSync(home, { recursive: true, force: true });
  }
});
