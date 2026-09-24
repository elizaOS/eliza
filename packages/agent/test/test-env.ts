/** Provides deterministic environment helpers shared by agent package tests. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type RestoreEntry = { key: string; value: string | undefined };

function restoreEnv(entries: RestoreEntry[]): void {
  for (const { key, value } of entries) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

/** Always isolates the retained local scenarios from developer state. */
export function withIsolatedTestHome(): {
  cleanup: () => void;
  tempHome: string;
} {
  const restore: RestoreEntry[] = [
    { key: "ELIZA_TEST_FAST", value: process.env.ELIZA_TEST_FAST },
    { key: "HOME", value: process.env.HOME },
    { key: "USERPROFILE", value: process.env.USERPROFILE },
    { key: "XDG_CONFIG_HOME", value: process.env.XDG_CONFIG_HOME },
    { key: "XDG_DATA_HOME", value: process.env.XDG_DATA_HOME },
    { key: "XDG_STATE_HOME", value: process.env.XDG_STATE_HOME },
    { key: "XDG_CACHE_HOME", value: process.env.XDG_CACHE_HOME },
    { key: "ELIZA_STATE_DIR", value: process.env.ELIZA_STATE_DIR },
    { key: "ELIZA_CONFIG_PATH", value: process.env.ELIZA_CONFIG_PATH },
    { key: "ELIZA_GATEWAY_PORT", value: process.env.ELIZA_GATEWAY_PORT },
    {
      key: "ELIZA_BRIDGE_ENABLED",
      value: process.env.ELIZA_BRIDGE_ENABLED,
    },
    { key: "ELIZA_BRIDGE_HOST", value: process.env.ELIZA_BRIDGE_HOST },
    { key: "ELIZA_BRIDGE_PORT", value: process.env.ELIZA_BRIDGE_PORT },
    {
      key: "ELIZA_CANVAS_HOST_PORT",
      value: process.env.ELIZA_CANVAS_HOST_PORT,
    },
    { key: "ELIZA_TEST_HOME", value: process.env.ELIZA_TEST_HOME },
    { key: "TELEGRAM_BOT_TOKEN", value: process.env.TELEGRAM_BOT_TOKEN },
    { key: "DISCORD_BOT_TOKEN", value: process.env.DISCORD_BOT_TOKEN },
    { key: "SLACK_BOT_TOKEN", value: process.env.SLACK_BOT_TOKEN },
    { key: "SLACK_APP_TOKEN", value: process.env.SLACK_APP_TOKEN },
    { key: "SLACK_USER_TOKEN", value: process.env.SLACK_USER_TOKEN },
    { key: "COPILOT_GITHUB_TOKEN", value: process.env.COPILOT_GITHUB_TOKEN },
    { key: "GH_TOKEN", value: process.env.GH_TOKEN },
    { key: "GITHUB_TOKEN", value: process.env.GITHUB_TOKEN },
    { key: "NODE_OPTIONS", value: process.env.NODE_OPTIONS },
  ];

  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-test-home-"));

  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  process.env.ELIZA_TEST_HOME = tempHome;
  process.env.ELIZA_TEST_FAST = "1";

  // Ensure test runs never touch the developer's real config/state, even if they have overrides set.
  delete process.env.ELIZA_CONFIG_PATH;
  // Prefer deriving state dir from HOME so nested tests that change HOME also isolate correctly.
  delete process.env.ELIZA_STATE_DIR;
  // Prefer test-controlled ports over developer overrides (avoid port collisions across tests/workers).
  delete process.env.ELIZA_GATEWAY_PORT;
  delete process.env.ELIZA_BRIDGE_ENABLED;
  delete process.env.ELIZA_BRIDGE_HOST;
  delete process.env.ELIZA_BRIDGE_PORT;
  delete process.env.ELIZA_CANVAS_HOST_PORT;
  // Keep real connector credentials out of these local scenarios.
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.DISCORD_BOT_TOKEN;
  delete process.env.SLACK_BOT_TOKEN;
  delete process.env.SLACK_APP_TOKEN;
  delete process.env.SLACK_USER_TOKEN;
  delete process.env.COPILOT_GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_TOKEN;
  // Avoid leaking local dev tooling flags into tests (e.g. --inspect).
  delete process.env.NODE_OPTIONS;

  // Windows: prefer the default state dir so auth/profile tests match real paths.
  if (process.platform === "win32") {
    process.env.ELIZA_STATE_DIR = path.join(tempHome, ".eliza");
  }

  process.env.XDG_CONFIG_HOME = path.join(tempHome, ".config");
  process.env.XDG_DATA_HOME = path.join(tempHome, ".local", "share");
  process.env.XDG_STATE_HOME = path.join(tempHome, ".local", "state");
  process.env.XDG_CACHE_HOME = path.join(tempHome, ".cache");

  const cleanup = () => {
    restoreEnv(restore);
    fs.rmSync(tempHome, { recursive: true, force: true });
  };

  return { cleanup, tempHome };
}
