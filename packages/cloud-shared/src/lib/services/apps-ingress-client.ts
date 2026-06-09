import { Buffer } from "node:buffer";

/**
 * Apps ingress-map client (Product 2) — fetches the live `host → upstream` map
 * from cloud-api and applies it to Caddy on app worker nodes.
 *
 * Operators (or the provisioning-worker daemon) poll
 * `GET /api/v1/admin/containers/ingress-map?format=caddy` and write the snippet
 * to `/etc/caddy/apps.d/ingress-map.caddy`, then reload Caddy via
 * `APPS_CADDY_ADMIN_URL` (Caddy admin `/load` with the parent Caddyfile).
 *
 * NODE-ONLY: the SSH apply path is wired from the provisioning-worker daemon,
 * never from the cloud-api Worker.
 */

import { containersEnv } from "../config/containers-env";
import { logger } from "../utils/logger";
import { shellQuote } from "./docker-sandbox-utils";

function parseSeedNodeHostname(entry: string): string | null {
  const trimmed = entry.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(":");
  if (parts.length >= 2) {
    const hostname = parts[1]?.trim();
    if (hostname) return hostname;
  }
  return parts[0]?.trim() ?? null;
}

export const DEFAULT_APPS_INGRESS_SNIPPET_PATH = "/etc/caddy/apps.d/ingress-map.caddy";
export const DEFAULT_APPS_CADDYFILE_PATH = "/etc/caddy/Caddyfile";
export const DEFAULT_APPS_CADDY_ADMIN_URL = "http://127.0.0.1:2019";

export interface AppsIngressSyncConfig {
  /** Cloud API origin, e.g. `https://api.elizacloud.ai` (no trailing slash). */
  apiOrigin: string;
  /** Super-admin API key or session token for the ingress-map route. */
  adminApiKey: string;
  /** Caddy admin base URL on the app node (loopback). */
  caddyAdminUrl: string;
  snippetPath: string;
  caddyfilePath: string;
}

export interface AppsIngressFetchResult {
  body: string;
  entryCount: number;
}

export function buildIngressMapUrl(apiOrigin: string): string {
  const base = apiOrigin.replace(/\/+$/, "");
  return `${base}/api/v1/admin/containers/ingress-map?format=caddy`;
}

export function buildCaddyAdminLoadUrl(caddyAdminUrl: string): string {
  return `${caddyAdminUrl.replace(/\/+$/, "")}/load`;
}

export function countIngressHosts(snippet: string): number {
  const matches = snippet.match(/^\S+\.\S+ \{/gm);
  return matches?.length ?? 0;
}

/** Read env for the ingress sync cycle. Returns null when not configured. */
export function readAppsIngressSyncConfig(
  env: NodeJS.ProcessEnv = process.env,
): AppsIngressSyncConfig | null {
  if (env.APPS_INGRESS_SYNC_ENABLED !== "1") return null;
  const apiOrigin = env.APPS_INGRESS_API_ORIGIN?.trim() || env.ELIZA_CLOUD_API_ORIGIN?.trim();
  const adminApiKey =
    env.APPS_INGRESS_ADMIN_API_KEY?.trim() || env.ELIZAOS_CLOUD_API_KEY?.trim();
  if (!apiOrigin || !adminApiKey) return null;
  return {
    apiOrigin,
    adminApiKey,
    caddyAdminUrl: env.APPS_CADDY_ADMIN_URL?.trim() || DEFAULT_APPS_CADDY_ADMIN_URL,
    snippetPath: env.APPS_INGRESS_SNIPPET_PATH?.trim() || DEFAULT_APPS_INGRESS_SNIPPET_PATH,
    caddyfilePath: env.APPS_CADDYFILE_PATH?.trim() || DEFAULT_APPS_CADDYFILE_PATH,
  };
}

/** Hostnames of app worker nodes that should receive ingress-map snippets. */
export function resolveAppsIngressNodeHostnames(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const explicit = env.APPS_INGRESS_NODE_HOSTS?.split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (explicit && explicit.length > 0) return explicit;

  const seed = containersEnv.seedNodes();
  if (!seed) return [];
  const hostnames: string[] = [];
  for (const entry of seed.split(",")) {
    const hostname = parseSeedNodeHostname(entry);
    if (hostname) hostnames.push(hostname);
  }
  return hostnames;
}

export async function fetchIngressMapCaddySnippet(
  config: AppsIngressSyncConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<AppsIngressFetchResult> {
  const url = buildIngressMapUrl(config.apiOrigin);
  const response = await fetchImpl(url, {
    headers: {
      Authorization: `Bearer ${config.adminApiKey}`,
      Accept: "text/plain",
    },
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `ingress-map fetch failed: HTTP ${response.status}${detail ? ` — ${detail.slice(0, 200)}` : ""}`,
    );
  }
  const body = await response.text();
  return { body, entryCount: countIngressHosts(body) };
}

/**
 * Remote shell that writes the snippet and reloads Caddy via the admin API.
 * Snippet is base64-encoded to survive SSH quoting.
 */
export function buildRemoteIngressSyncShell(opts: {
  snippetBase64: string;
  snippetPath: string;
  caddyfilePath: string;
  caddyAdminUrl: string;
}): string {
  const snippetPath = shellQuote(opts.snippetPath);
  const caddyfilePath = shellQuote(opts.caddyfilePath);
  const loadUrl = shellQuote(buildCaddyAdminLoadUrl(opts.caddyAdminUrl));
  const b64 = shellQuote(opts.snippetBase64);
  return [
    `echo ${b64} | base64 -d | sudo tee ${snippetPath} > /dev/null`,
    `curl -sf -X POST ${loadUrl} -H 'Content-Type: text/caddyfile' --data-binary @${caddyfilePath}`,
  ].join(" && ");
}

export interface AppsIngressNodeSyncResult {
  hostname: string;
  changed: boolean;
  entryCount: number;
  error?: string;
}

export interface AppsIngressSyncSummary {
  fetchedEntries: number;
  nodes: AppsIngressNodeSyncResult[];
}

export interface AppsIngressSshClient {
  exec(command: string, timeoutMs?: number): Promise<string>;
}

/**
 * Fetch the ingress map once and push it to every configured app node over SSH.
 */
export async function syncAppsIngressToNodes(opts: {
  config: AppsIngressSyncConfig;
  hostnames: readonly string[];
  sshForHost: (hostname: string) => AppsIngressSshClient;
  fetchImpl?: typeof fetch;
  previousSnippetByHost?: Map<string, string>;
}): Promise<AppsIngressSyncSummary> {
  const { body, entryCount } = await fetchIngressMapCaddySnippet(
    opts.config,
    opts.fetchImpl,
  );
  const snippetBase64 = Buffer.from(body, "utf8").toString("base64");
  const shell = buildRemoteIngressSyncShell({
    snippetBase64,
    snippetPath: opts.config.snippetPath,
    caddyfilePath: opts.config.caddyfilePath,
    caddyAdminUrl: opts.config.caddyAdminUrl,
  });

  const nodes: AppsIngressNodeSyncResult[] = [];
  for (const hostname of opts.hostnames) {
    const previous = opts.previousSnippetByHost?.get(hostname);
    const changed = previous !== body;
    try {
      if (changed) {
        await opts.sshForHost(hostname).exec(shell, 30_000);
        opts.previousSnippetByHost?.set(hostname, body);
      }
      nodes.push({ hostname, changed, entryCount });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("[apps-ingress-sync] node sync failed", { hostname, error: message });
      nodes.push({ hostname, changed: false, entryCount, error: message });
    }
  }

  return { fetchedEntries: entryCount, nodes };
}
