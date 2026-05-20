#!/usr/bin/env bun

import { type ChildProcess, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const appsWebRoot = path.resolve(repoRoot, 'apps/web');
const baseUrl = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:3100';
const nextPort = new URL(baseUrl).port || '3100';
const localEnv = {
  ...process.env,
  NODE_ENV: 'development',
  DEPLOYMENT_ENV: 'localnet',
  NEXT_PUBLIC_CHAIN_ID: '31337',
  NEXT_PUBLIC_RPC_URL: 'http://localhost:8545',
  NEXT_PUBLIC_ENABLE_ONCHAIN_PERPS: 'true',
  NEXT_PUBLIC_PERP_SETTLEMENT_MODE: 'onchain',
  PERP_SETTLEMENT_MODE: 'onchain',
  FEED_DISABLE_REDIS: '1',
  AGENT0_ENABLED: 'false',
  DISABLE_SENTRY: 'true',
  NEXT_PUBLIC_DISABLE_SENTRY: 'true',
  PORT: nextPort,
  NEXT_DIST_DIR: '.next-synpress',
};

const children = new Set<ChildProcess>();

function spawnInherited(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv
): ChildProcess {
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: 'inherit',
  });
  children.add(child);
  child.on('exit', () => {
    children.delete(child);
  });
  return child;
}

function waitForExit(child: ChildProcess, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          `${label} exited with ${signal ? `signal ${signal}` : `code ${code ?? -1}`}`
        )
      );
    });
    child.on('error', reject);
  });
}

async function waitForLocalRpc(
  rpcUrl: string,
  attempts = 60,
  intervalMs = 1000
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_blockNumber',
        params: [],
      }),
    }).catch(() => null);

    if (response?.ok) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Local RPC did not become ready at ${rpcUrl}`);
}

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  for (const child of children) {
    if (!child.killed) {
      child.kill(signal);
    }
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void shutdown(signal).finally(() => {
      process.exit(0);
    });
  });
}

async function main(): Promise<void> {
  const preDev = spawnInherited(
    'bun',
    ['run', 'scripts/pre-dev/pre-dev-local.ts'],
    repoRoot,
    localEnv
  );
  await waitForExit(preDev, 'pre-dev setup');

  const _anvil = spawnInherited('bun', ['run', 'anvil'], repoRoot, localEnv);
  await waitForLocalRpc(localEnv.NEXT_PUBLIC_RPC_URL);

  const bootstrap = spawnInherited(
    'bun',
    ['run', 'scripts/wait-for-local-chain-and-deploy.ts', '--once'],
    repoRoot,
    {
      ...localEnv,
      FEED_LOCAL_BOOTSTRAP_ONCE: '1',
    }
  );
  await waitForExit(bootstrap, 'local chain bootstrap');

  const next = spawnInherited('bun', ['run', 'dev'], appsWebRoot, localEnv);
  const exitCode = await new Promise<number>((resolve) => {
    next.on('exit', (code) => resolve(code ?? 0));
  });

  if (exitCode !== 0) {
    throw new Error(`Next dev server exited with code ${exitCode}`);
  }
}

await main().catch(async (error) => {
  await shutdown('SIGTERM');
  process.exit(1);
});
