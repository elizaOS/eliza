/**
 * Real-runtime regression coverage for the connector credential store's
 * start semantics. `runtime.registerService` is LAZY — the instance is only
 * created by the async service-load path — while connector plugins resolve
 * the store with the SYNCHRONOUS `runtime.getService()`, which returns null
 * for a registered-but-never-started service. On the live deployment that
 * null silently demoted every connector OAuth credential write to the
 * in-memory SECRETS fallback, and the tokens died with the process. These
 * tests run against a real `AgentRuntime` with the real `@elizaos/plugin-sql`
 * adapter (local mode, PGlite) — the same registry shape as the deployment —
 * so the lazy-start trap cannot regress unnoticed again.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentRuntime, type Plugin } from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  _resetAgentHostBridge,
  defaultAgentHostBridge,
  setAgentHostBridge,
} from "../runtime/host-bridge.ts";
import { ConnectorCredentialStoreService } from "./connector-credential-store.ts";

const SERVICE_TYPE = "connector_credential_store";

function installBridgeWithVault(entries: Map<string, string>): void {
  setAgentHostBridge({
    ...defaultAgentHostBridge,
    sharedVault: () =>
      ({
        set: async (key: string, value: string) => {
          entries.set(key, value);
        },
        setIfAbsent: async (key: string, value: string) => {
          if (entries.has(key)) return false;
          entries.set(key, value);
          return true;
        },
        setReference: async () => {},
        get: async (key: string) => {
          const value = entries.get(key);
          if (value === undefined) throw new Error(`vault miss: ${key}`);
          return value;
        },
        reveal: async (key: string) => {
          const value = entries.get(key);
          if (value === undefined) throw new Error(`vault miss: ${key}`);
          return value;
        },
        has: async (key: string) => entries.has(key),
        remove: async (key: string) => {
          entries.delete(key);
        },
        quarantineUnreadable: async () => false,
        list: async () => [],
        describe: async () => null,
        stats: async () => ({
          total: 0,
          sensitive: 0,
          nonSensitive: 0,
          references: 0,
        }),
      }) as ReturnType<typeof defaultAgentHostBridge.sharedVault>,
  });
}

const activeRuntimes: AgentRuntime[] = [];
const pgliteDirs: string[] = [];
const originalPgliteDataDir = process.env.PGLITE_DATA_DIR;

async function bootRuntime(
  vaultEntries: Map<string, string>,
): Promise<AgentRuntime> {
  const pgliteDir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-cred-store-"));
  pgliteDirs.push(pgliteDir);
  process.env.PGLITE_DATA_DIR = pgliteDir;

  installBridgeWithVault(vaultEntries);

  const runtime = new AgentRuntime({
    character: { name: "CredStoreRuntime" },
    plugins: [],
    logLevel: "fatal",
    enableAutonomy: false,
  });
  activeRuntimes.push(runtime);

  const pluginSqlModule = (await import(
    ["@elizaos", "plugin-sql"].join("/")
  )) as {
    default?: Plugin;
    elizaPlugin?: Plugin;
  };
  const pluginSql = pluginSqlModule.default ?? pluginSqlModule.elizaPlugin;
  if (!pluginSql) throw new Error("plugin-sql did not export a plugin");
  await runtime.registerPlugin(pluginSql);
  await runtime.initialize();
  return runtime;
}

afterEach(async () => {
  for (const runtime of activeRuntimes.splice(0)) {
    try {
      await runtime.stop();
    } catch {
      // already stopped
    }
  }
  for (const dir of pgliteDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (originalPgliteDataDir === undefined) {
    delete process.env.PGLITE_DATA_DIR;
  } else {
    process.env.PGLITE_DATA_DIR = originalPgliteDataDir;
  }
  _resetAgentHostBridge();
});

describe("ConnectorCredentialStoreService start semantics (real runtime)", () => {
  it("is invisible to the synchronous getService until the load path starts it", async () => {
    const runtime = await bootRuntime(new Map());
    await runtime.registerService(ConnectorCredentialStoreService);

    // The lazy-registration trap: registered, never started, sync-invisible.
    // This exact null is what demoted live OAuth credential writes to the
    // volatile SECRETS fallback. The boot funnel must force the start.
    expect(runtime.getService(SERVICE_TYPE)).toBeNull();

    await runtime.getServiceLoadPromise(SERVICE_TYPE);
    expect(runtime.getService(SERVICE_TYPE)).not.toBeNull();
  }, 120_000);

  it("round-trips a credential across a full runtime restart via the started store", async () => {
    const durableVault = new Map<string, string>();

    const first = await bootRuntime(durableVault);
    await first.registerService(ConnectorCredentialStoreService);
    await first.getServiceLoadPromise(SERVICE_TYPE);
    const writer = first.getService(
      SERVICE_TYPE,
    ) as ConnectorCredentialStoreService;
    const vaultRef = await writer.putSecret({
      agentId: first.agentId,
      provider: "google",
      accountId: "acct-restart",
      credentialType: "oauth.tokens",
      value: "restart-surviving-material",
      caller: "runtime-test",
    });
    await first.stop();

    // Restart: a brand-new runtime and service instance; only the vault
    // backing store survives (as the real host vault does on disk).
    const second = await bootRuntime(durableVault);
    await second.registerService(ConnectorCredentialStoreService);
    await second.getServiceLoadPromise(SERVICE_TYPE);
    const reader = second.getService(
      SERVICE_TYPE,
    ) as ConnectorCredentialStoreService;
    expect(await reader.get(vaultRef, { reveal: true })).toBe(
      "restart-surviving-material",
    );
  }, 240_000);

  it("leaves a registered-but-failed store null in getService while still listed in the registry — the exact fail-closed signal (#18080)", async () => {
    // The shipped store's start() cannot fail organically (it only constructs
    // over the already-installed bridge vault), so the failure is injected at
    // the same seam a real environmental fault would hit: the static start the
    // service loader awaits. Registration and lookup semantics stay real.
    class FailingConnectorCredentialStoreService extends ConnectorCredentialStoreService {
      static override async start(): Promise<never> {
        throw new Error("injected start failure");
      }
    }

    const runtime = await bootRuntime(new Map());
    await runtime.registerService(FailingConnectorCredentialStoreService);
    await expect(runtime.getServiceLoadPromise(SERVICE_TYPE)).rejects.toThrow(
      /failed to start/,
    );

    // The two-sided signal persistConnectorCredentialRefs keys on: getService
    // resolves null, while the registry still lists the type. Durability was
    // expected here, so OAuth completion must fail closed instead of demoting
    // the write to volatile SECRETS.
    expect(runtime.getService(SERVICE_TYPE)).toBeNull();
    expect(runtime.getRegisteredServiceTypes()).toContain(SERVICE_TYPE);
  }, 120_000);
});
