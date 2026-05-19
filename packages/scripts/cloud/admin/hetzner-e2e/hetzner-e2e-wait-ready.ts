#!/usr/bin/env bun
/**
 * Wait for the provisioned Hetzner host to finish cloud-init and have
 * Docker available. SSH-poll, 5min timeout. Uses CI_SSH_PRIVATE_KEY
 * written to a private temp file.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readState } from "./state-file";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`[hetzner-e2e-wait-ready] missing env: ${name}`);
    process.exit(1);
  }
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const privateKey = requireEnv("CI_SSH_PRIVATE_KEY");
  const state = readState();
  if (!state.ip) {
    throw new Error("state file missing ip; provision step must run first");
  }

  const dir = mkdtempSync(join(tmpdir(), "hetzner-e2e-"));
  const keyPath = join(dir, "id_ed25519");
  writeFileSync(
    keyPath,
    privateKey.endsWith("\n") ? privateKey : `${privateKey}\n`,
    "utf8",
  );
  chmodSync(keyPath, 0o600);

  const sshArgs = [
    "-i",
    keyPath,
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    "UserKnownHostsFile=/dev/null",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "BatchMode=yes",
    `root@${state.ip}`,
  ];

  const deadline = Date.now() + 5 * 60_000;
  let lastErr = "";
  try {
    while (Date.now() < deadline) {
      const result = spawnSync(
        "ssh",
        [
          ...sshArgs,
          "test -f /var/lib/cloud/instance/e2e-ready && docker info >/dev/null 2>&1",
        ],
        { encoding: "utf8" },
      );
      if (result.status === 0) {
        console.log(`[hetzner-e2e-wait-ready] host ${state.ip} ready`);
        return;
      }
      lastErr = (result.stderr ?? "").trim().split("\n").slice(-2).join(" | ");
      console.log(`[hetzner-e2e-wait-ready] not ready yet: ${lastErr}`);
      await sleep(10_000);
    }
    throw new Error(`Timed out waiting for ${state.ip}: ${lastErr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

await main();
