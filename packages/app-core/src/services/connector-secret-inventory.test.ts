/** Tests non-revealing connector fallback discovery and file-permission checks. */

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  connectorVaultKey,
  listConnectorSecretFindings,
} from "./connector-secret-inventory";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function stateDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "connector-secret-findings-"));
  tempDirs.push(dir);
  return dir;
}

describe("connector secret inventory", () => {
  it("reports plaintext top-level and nested credentials without their values", async () => {
    const findings = listConnectorSecretFindings(
      {
        connectors: {
          telegram: { botToken: "never-return-this-token" },
          slack: {
            botToken: "vault://connector.a.slack.default.bot_token",
            accounts: {
              support: { signingSecret: "never-return-this-signing-secret" },
            },
          },
        },
      },
      await stateDir(),
    );

    expect(findings.map((finding) => finding.id)).toEqual([
      "config:telegram.botToken",
      "config:slack.accounts.support.signingSecret",
    ]);
    expect(findings[0]?.autoMigratesOnDesktop).toBe(true);
    expect(findings[1]?.autoMigratesOnDesktop).toBe(false);
    expect(JSON.stringify(findings)).not.toContain("never-return-this");
  });

  it("reports Telegram Personal state files and flags broad permissions", async () => {
    const dir = await stateDir();
    const telegramDir = join(dir, "telegram-account");
    mkdirSync(telegramDir, { recursive: true });
    const sessionFile = join(telegramDir, "session.txt");
    const authFile = join(telegramDir, "auth-state.json");
    writeFileSync(sessionFile, "session-secret", { mode: 0o600 });
    writeFileSync(authFile, "auth-secret", { mode: 0o600 });
    chmodSync(authFile, 0o644);

    const findings = listConnectorSecretFindings({}, dir);
    expect(findings).toMatchObject([
      { id: "state:telegram-account:session", protection: "mode-0600" },
      {
        id: "state:telegram-account:auth",
        protection: "permissions-need-attention",
      },
    ]);
    expect(JSON.stringify(findings)).not.toContain("session-secret");
    expect(JSON.stringify(findings)).not.toContain("auth-secret");
  });

  it("derives a deterministic connector-category vault key", () => {
    expect(connectorVaultKey("telegram", "botToken")).toBe(
      "connector.host.telegram.default.botToken",
    );
  });
});
