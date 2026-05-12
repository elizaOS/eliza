/**
 * Feishu Connector Validation Tests
 *
 * Comprehensive E2E tests for validating the Feishu/Lark connector (@elizaos/plugin-feishu).
 *
 * Test Categories:
 *   1. Setup & Authentication
 *   2. Message Handling
 *   3. Feishu-Specific Features
 *   4. Groups & Chats
 *   5. Media & Attachments
 *   6. Error Handling
 *   7. Integration
 *
 * Requirements for live tests:
 *   FEISHU_APP_ID              — Feishu/Lark application ID (cli_xxx format)
 *   FEISHU_APP_SECRET          — Feishu/Lark application secret
 *   ELIZA_LIVE_TEST=1         — Enable live tests
 *
 * Additional env vars for write tests:
 *   FEISHU_TEST_CHAT_ID        — Chat ID to test in (e.g., oc_xxx)
 *
 * Optional env vars:
 *   FEISHU_DOMAIN              — "feishu.cn" (default) or "larksuite.com"
 *
 * Or configure in ~/.eliza/eliza.json:
 *   { "connectors": { "feishu": { "token": "...", "appId": "...", "appSecret": "..." } } }
 *
 * NO MOCKS for live tests — all tests use real Feishu API.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  extractPlugin,
  resolveFeishuPluginImportSpecifier,
} from "@elizaos/app-core";
import { logger, type Plugin } from "@elizaos/core";
import dotenv from "dotenv";
import { expect, it } from "vitest";
import { describeIf } from "../helpers/conditional-tests.ts";

// ---------------------------------------------------------------------------
// Environment Setup
// ---------------------------------------------------------------------------

const testDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(testDir, "..");
dotenv.config({ path: path.resolve(packageRoot, ".env") });

const FEISHU_APP_ID = process.env.FEISHU_APP_ID;
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET;
const FEISHU_DOMAIN = process.env.FEISHU_DOMAIN ?? "feishu.cn";
const FEISHU_TEST_CHAT_ID = process.env.FEISHU_TEST_CHAT_ID;

const hasFeishuCreds = Boolean(FEISHU_APP_ID && FEISHU_APP_SECRET);
const liveTestsEnabled = process.env.ELIZA_LIVE_TEST === "1";
const runLiveTests = hasFeishuCreds && liveTestsEnabled;

const hasWriteTargets = Boolean(FEISHU_TEST_CHAT_ID);
const runLiveWriteTests = runLiveTests && hasWriteTargets;

const FEISHU_PLUGIN_IMPORT = resolveFeishuPluginImportSpecifier();
const hasPlugin = FEISHU_PLUGIN_IMPORT !== null;

// Plugin-dependent guards (for tests that import the plugin)
const describeIfPluginAvailable = describeIf(hasPlugin);

// Credential-only guards (for direct API tests that don't need the plugin)
const describeIfCreds = describeIf(runLiveTests);
const _describeIfCredsWrite = describeIf(runLiveWriteTests);

const TEST_TIMEOUT = 30_000;
const _LIVE_WRITE_TIMEOUT = 60_000;

logger.info(
  `[feishu-connector] Live tests ${runLiveTests ? "ENABLED" : "DISABLED"} ` +
    `(APP_ID=${Boolean(FEISHU_APP_ID)}, APP_SECRET=${Boolean(FEISHU_APP_SECRET)}, ` +
    `ELIZA_LIVE_TEST=${liveTestsEnabled})`,
);
logger.info(
  `[feishu-connector] Write tests ${runLiveWriteTests ? "ENABLED" : "DISABLED"} ` +
    `(TEST_CHAT_ID=${Boolean(FEISHU_TEST_CHAT_ID)})`,
);
logger.info(
  `[feishu-connector] Plugin import ${FEISHU_PLUGIN_IMPORT ?? "UNAVAILABLE"}`,
);

// ---------------------------------------------------------------------------
// API Helpers (for live tests)
// ---------------------------------------------------------------------------

/** Derive the API base URL from the domain config. */
function feishuApiBase(domain: string = FEISHU_DOMAIN): string {
  const host =
    domain === "larksuite.com" ? "open.larksuite.com" : "open.feishu.cn";
  return `https://${host}/open-apis`;
}

/** Acquire a tenant_access_token using app credentials. */
async function feishuGetTenantAccessToken(
  appId: string,
  appSecret: string,
  domain?: string,
): Promise<{
  code: number;
  msg: string;
  tenant_access_token?: string;
  expire?: number;
}> {
  const base = feishuApiBase(domain);
  const res = await fetch(`${base}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  return (await res.json()) as {
    code: number;
    msg: string;
    tenant_access_token?: string;
    expire?: number;
  };
}

/** GET wrapper for Feishu API. */
async function _feishuGet<T>(
  endpoint: string,
  token: string,
  domain?: string,
): Promise<{ ok: boolean; status: number; data: T }> {
  const base = feishuApiBase(domain);
  const res = await fetch(`${base}${endpoint}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = (await res.json()) as T;
  return { ok: res.ok, status: res.status, data };
}

/** POST wrapper for Feishu API. */
async function _feishuPost<T>(
  endpoint: string,
  token: string,
  body: unknown,
  domain?: string,
): Promise<{ ok: boolean; status: number; data: T }> {
  const base = feishuApiBase(domain);
  const res = await fetch(`${base}${endpoint}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as T;
  return { ok: res.ok, status: res.status, data };
}

// ---------------------------------------------------------------------------
// Load Plugin Helper
// ---------------------------------------------------------------------------

const loadFeishuPlugin = async (): Promise<Plugin | null> => {
  if (!FEISHU_PLUGIN_IMPORT) return null;
  const mod = (await import(FEISHU_PLUGIN_IMPORT)) as {
    default?: Plugin;
    plugin?: Plugin;
    [key: string]: unknown;
  };
  return extractPlugin(mod) as Plugin | null;
};

// ---------------------------------------------------------------------------
// 1. Setup & Authentication
// ---------------------------------------------------------------------------

describeIfPluginAvailable("Feishu Connector - Setup & Authentication", () => {
  it(
    "can load the Feishu plugin without errors",
    async () => {
      const plugin = await loadFeishuPlugin();
      expect(plugin).not.toBeNull();
      if (plugin) {
        expect(plugin.name).toMatch(/feishu/i);
      }
    },
    TEST_TIMEOUT,
  );

  it(
    "Feishu plugin exports required structure",
    async () => {
      const plugin = await loadFeishuPlugin();
      expect(plugin).toBeDefined();
      if (plugin) {
        expect(plugin.name).toMatch(/feishu/i);
        expect(plugin.description).toBeDefined();
        expect(typeof plugin.description).toBe("string");
      }
    },
    TEST_TIMEOUT,
  );

  it(
    "plugin has clients or services",
    async () => {
      const plugin = await loadFeishuPlugin();
      expect(plugin).not.toBeNull();
      if (plugin) {
        const hasClients =
          Array.isArray(plugin.clients) && plugin.clients.length > 0;
        const hasServices =
          Array.isArray(plugin.services) && plugin.services.length > 0;
        expect(hasClients || hasServices).toBe(true);
      }
    },
    TEST_TIMEOUT,
  );
});

describeIfCreds("Feishu Connector - Live Authentication", () => {
  it(
    "can acquire tenant access token",
    async () => {
      const result = await feishuGetTenantAccessToken(
        FEISHU_APP_ID!,
        FEISHU_APP_SECRET!,
        FEISHU_DOMAIN,
      );
      expect(result.code).toBe(0);
      expect(result.tenant_access_token).toBeDefined();
      expect(typeof result.tenant_access_token).toBe("string");
      expect(result.tenant_access_token?.length).toBeGreaterThan(0);
    },
    TEST_TIMEOUT,
  );

  it(
    "tenant access token has an expiry",
    async () => {
      const result = await feishuGetTenantAccessToken(
        FEISHU_APP_ID!,
        FEISHU_APP_SECRET!,
        FEISHU_DOMAIN,
      );
      expect(result.expire).toBeDefined();
      expect(result.expire).toBeGreaterThan(0);
    },
    TEST_TIMEOUT,
  );
});

// ---------------------------------------------------------------------------
// Integration Tests (always run, no live creds needed)
// ---------------------------------------------------------------------------

/** Try to import a workspace module; returns null if the package isn't built. */
async function tryWorkspaceImport<T>(specifier: string): Promise<T | null> {
  try {
    return (await import(specifier)) as T;
  } catch {
    return null;
  }
}

/** Pre-check: can we import the workspace config module? */
let _workspaceAvailable: boolean | null = null;
async function isWorkspaceAvailable(): Promise<boolean> {
  if (_workspaceAvailable === null) {
    _workspaceAvailable =
      (await tryWorkspaceImport("@elizaos/app-core")) !== null;
    if (!_workspaceAvailable) {
      logger.warn(
        "[feishu-connector] Workspace not built — integration tests will be skipped",
      );
    }
  }
  return _workspaceAvailable;
}

// Resolve synchronously at module load so we can gate the describe block.
// If the workspace isn't built these will all be skipped visibly.
const workspaceBuilt = await isWorkspaceAvailable();
const describeIfWorkspace = describeIf(workspaceBuilt);

describeIfWorkspace("Feishu Connector - Integration", () => {
  it("Feishu is mapped in CONNECTOR_PLUGINS", async () => {
    const mod = (await tryWorkspaceImport<{
      CONNECTOR_PLUGINS: Record<string, string>;
    }>("@elizaos/app-core"))!;
    expect(mod.CONNECTOR_PLUGINS.feishu).toBe("@elizaos/plugin-feishu");
  });
});
