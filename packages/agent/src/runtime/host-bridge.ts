/**
 * Agent host bridge — the downward-injection seam that replaces the former
 * memoized dynamic import of the app-core `agent-bridge` subpath (a reverse
 * edge from agent up into the host).
 *
 * `@elizaos/agent` is the lower layer; `@elizaos/app-core` is the host that
 * runs it. A small set of host-owned capabilities (OS wallet-key hydration,
 * vault bootstrap/access, the account-pool singleton, build-variant flags, and
 * the cloud-SSO pair route) used to be pulled UP from agent into app-core via a
 * memoized dynamic import of the `app-core/agent-bridge` subpath. That edge put
 * `@elizaos/app-core ↔ @elizaos/agent` in a real dependency cycle (#9626),
 * hidden from `madge` only by the narrow-subpath `.d.ts`.
 *
 * The host now INJECTS these capabilities via {@link setAgentHostBridge} before
 * booting the runtime (see app-core's boot funnel). When no host installs a
 * bridge — the on-device mobile bundle and any standalone-agent boot — the
 * built-in {@link defaultAgentHostBridge} supplies the exact no-op behavior the
 * mobile `app-core-runtime.cjs` stub used to provide. Agent therefore never
 * imports `@elizaos/app-core`, static or dynamic.
 */

import type {
  IncomingMessage as HttpIncomingMessage,
  ServerResponse as HttpServerResponse,
} from "node:http";
import type { AgentRuntime } from "@elizaos/core";
import {
  type AccountPoolBrokerSnapshot,
  emptyAccountPoolBrokerSnapshot,
} from "@elizaos/core";
import type { resolveServiceRoutingInConfig } from "@elizaos/shared";
import type { Vault } from "@elizaos/vault";

export type AccountPoolCredentialsOptions = {
  activeBackend?: string | undefined;
  accountStrategies?: Record<string, unknown> | undefined;
  serviceRouting?: ReturnType<typeof resolveServiceRoutingInConfig>;
};

/**
 * Host capabilities the agent runtime consumes at boot / request time. Every
 * member has a no-op default so a hostless (mobile / standalone) boot degrades
 * gracefully instead of throwing.
 */
export interface AgentHostBridge {
  /**
   * Record which wallet/steward env keys the launch environment set, BEFORE
   * config.env merges into process.env. The deferred wallet-key hydrate
   * consults this baseline so vault-held values keep beating config-merged
   * ones — the precedence the old pre-merge inline hydrate enforced by
   * ordering — without ever clobbering an explicit launch env var.
   */
  captureWalletEnvBootBaseline(): void;
  hydrateWalletKeysFromNodePlatformSecureStore(): Promise<void> | void;
  runVaultBootstrap(): Promise<{ migrated: number; failed: unknown[] }>;
  sharedVault(): Vault;
  getDefaultAccountPool(): unknown;
  getAccountPoolBrokerSnapshot(): AccountPoolBrokerSnapshot;
  applyAccountPoolApiCredentials(
    options: AccountPoolCredentialsOptions,
  ): Promise<void> | void;
  startAccountPoolKeepAlive(): void;
  getBuildVariant(): "store" | "direct";
  isStoreBuild(): boolean;
  /**
   * Let an embedding host recognize its own HTTP authentication mechanism
   * (for example app-core's browser session cookie). The standalone agent
   * has no host session model, so the default remains deny-by-default.
   */
  isHttpRequestAuthorized?(
    req: HttpIncomingMessage,
    runtime: AgentRuntime | null,
  ): Promise<boolean> | boolean;
  /**
   * Cloud-SSO popup handoff (`GET /pair?token=…`). Owned by the host; a
   * local-only agent never legitimately serves it, so absence is a no-op that
   * falls through to the normal request pipeline.
   */
  handleCloudPairRoute?(
    req: HttpIncomingMessage,
    res: HttpServerResponse,
  ): Promise<boolean>;
}

const noopVault: Vault = {
  set: () => Promise.resolve(),
  setReference: () => Promise.resolve(),
  get: () => Promise.resolve(""),
  reveal: () => Promise.resolve(""),
  has: () => Promise.resolve(false),
  remove: () => Promise.resolve(),
  list: () => Promise.resolve([]),
  describe: () => Promise.resolve(null),
  stats: () =>
    Promise.resolve({ total: 0, sensitive: 0, nonSensitive: 0, references: 0 }),
};

function defaultBuildVariant(): "store" | "direct" {
  return process.env.ELIZA_BUILD_VARIANT === "store" ? "store" : "direct";
}

/**
 * No-op host bridge — the exact behavior the mobile `app-core-runtime.cjs`
 * stub used to expose. Used whenever a host has not installed a real bridge.
 */
export const defaultAgentHostBridge: AgentHostBridge = {
  captureWalletEnvBootBaseline: () => undefined,
  hydrateWalletKeysFromNodePlatformSecureStore: () => undefined,
  runVaultBootstrap: () => Promise.resolve({ migrated: 0, failed: [] }),
  sharedVault: () => noopVault,
  getDefaultAccountPool: () => null,
  getAccountPoolBrokerSnapshot: emptyAccountPoolBrokerSnapshot,
  applyAccountPoolApiCredentials: () => undefined,
  startAccountPoolKeepAlive: () => undefined,
  getBuildVariant: defaultBuildVariant,
  isStoreBuild: () => defaultBuildVariant() === "store",
};

let installedBridge: AgentHostBridge | null = null;

/**
 * Install the host bridge. Called by the app-core boot funnel before the
 * runtime starts. Idempotent — the last installer wins.
 */
export function setAgentHostBridge(bridge: AgentHostBridge): void {
  installedBridge = bridge;
}

/** Read the installed host bridge, falling back to the no-op default. */
export function getAgentHostBridge(): AgentHostBridge {
  return installedBridge ?? defaultAgentHostBridge;
}

/** Test-only: drop any installed bridge so the default is used again. */
export function _resetAgentHostBridge(): void {
  installedBridge = null;
}
