/**
 * Durable registry of apps the agent built and deployed from chat.
 *
 * Without this, a built app is fire-and-forget: the router verifies the live
 * URL at `task_complete` and then persists only narration/screenshot/trajectory
 * artifacts, so the app never appears in any management surface — nothing can
 * list, revisit, or delete what the agent shipped. This module records one
 * {@link BuiltAppRecord} per successful app-deploy completion in the runtime
 * cache (DB-backed, survives restarts) and exposes a read API for management
 * consumers (`GET /api/orchestrator/built-apps`).
 *
 * Derivation is structural, matching the two deploy targets the spawn-time
 * contract injects (see app-deploy-guidance):
 *  - **custom** static host: a verified URL under the operator-configured
 *    `<customBaseUrl>/apps/<slug>/` shape IS a built app — the URL shape is
 *    definitive, no task-text inspection needed (loopback/LAN bases included:
 *    the operator configured them, so they are the canonical app location).
 *  - **eliza-cloud**: gated on the SAME app-build predicate that injected the
 *    deploy contract (`isAppBuildTask` on the session's initial task), then
 *    the first public verified URL that is not a code-host link. Monetized
 *    cloud apps additionally self-register with the Cloud apps API per the
 *    contract; this local record complements that with the orchestrator-side
 *    view.
 *
 * @module services/built-apps-registry
 */

import type { IAgentRuntime } from "@elizaos/core";
import {
  type AppDeployConfig,
  isAppBuildTask,
  resolveAppDeployConfig,
} from "./app-deploy-guidance.js";
import type { SessionInfo } from "./types.js";

export interface BuiltAppRecord {
  /** Stable identity within a target: the app's path/host slug. */
  slug: string;
  /** Human-readable name derived from the slug. */
  name: string;
  /** The verified live URL reported to the user. */
  url: string;
  /** Which deploy target hosted the app. */
  target: "eliza-cloud" | "custom";
  /** The sub-agent session that produced this deploy. */
  sessionId: string;
  /** The task label the deploy ran under, when known. */
  label?: string;
  /** ISO timestamp of registration (redeploys refresh it). */
  registeredAt: string;
}

export const BUILT_APPS_CACHE_KEY = "orchestrator:built-apps";
/** Cap the registry so a long-lived agent can't grow the cache row unbounded. */
export const MAX_BUILT_APPS = 200;

/** Code-host / VCS links routinely appear alongside a deploy report ("PR
 *  opened at …"); they are never the hosted app itself. */
const CODE_HOST_RE =
  /(^|\.)(github\.com|gist\.github\.com|raw\.githubusercontent\.com|gitlab\.com|bitbucket\.org)$/i;

function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "::1" || host.startsWith("127.");
}

function slugToDisplayName(slug: string): string {
  return slug
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/**
 * Pure: derive the built-app identity from a completion's verified URLs and
 * the configured deploy target. Returns null when the completion is not an
 * app deploy (no matching URL shape / the task was not an app build).
 */
export function deriveBuiltApp(
  verifiedUrls: readonly string[],
  config: AppDeployConfig,
  initialTask?: string,
): Pick<BuiltAppRecord, "slug" | "name" | "url" | "target"> | null {
  if (config.target === "custom" && config.customBaseUrl) {
    const appsPrefix = `${config.customBaseUrl.replace(/\/+$/, "")}/apps/`;
    for (const url of verifiedUrls) {
      if (!url.startsWith(appsPrefix)) continue;
      const slug = url.slice(appsPrefix.length).split(/[/?#]/, 1)[0]?.trim();
      if (!slug) continue;
      return {
        slug,
        name: slugToDisplayName(slug),
        url,
        target: "custom",
      };
    }
    return null;
  }
  // eliza-cloud: the URL shape is not operator-known, so gate on the same
  // predicate that injected the deploy contract at spawn. No initial task
  // recorded (or not an app build) → not an app deploy.
  if (!isAppBuildTask(initialTask)) return null;
  for (const url of verifiedUrls) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      continue;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
    const host = parsed.hostname.toLowerCase();
    // A loopback URL is a local build probe, not a hosted cloud app; a
    // code-host URL is the change, not the deployment.
    if (isLoopbackHost(host) || CODE_HOST_RE.test(host)) continue;
    const slug = host.split(".", 1)[0] || host;
    return {
      slug,
      name: slugToDisplayName(slug),
      url,
      target: "eliza-cloud",
    };
  }
  return null;
}

type CacheRuntime = Pick<IAgentRuntime, "getCache" | "setCache">;

function hasCache(runtime: unknown): runtime is CacheRuntime {
  const r = runtime as Partial<CacheRuntime> | null | undefined;
  return typeof r?.getCache === "function" && typeof r?.setCache === "function";
}

function asRecordList(value: unknown): BuiltAppRecord[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is BuiltAppRecord =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as BuiltAppRecord).slug === "string" &&
      typeof (entry as BuiltAppRecord).url === "string" &&
      typeof (entry as BuiltAppRecord).target === "string",
  );
}

/** Read the built-apps registry, newest first. Empty when never written. */
export async function listBuiltApps(
  runtime: unknown,
): Promise<BuiltAppRecord[]> {
  if (!hasCache(runtime)) return [];
  return asRecordList(await runtime.getCache(BUILT_APPS_CACHE_KEY));
}

/**
 * Insert (or refresh, keyed on target+slug) one record. Read-modify-write on
 * the runtime cache — completions are handled serially per session in a
 * single process, so no cross-process lock is needed here.
 */
export async function registerBuiltApp(
  runtime: unknown,
  record: BuiltAppRecord,
): Promise<boolean> {
  if (!hasCache(runtime)) return false;
  const existing = await listBuiltApps(runtime);
  const rest = existing.filter(
    (entry) => !(entry.target === record.target && entry.slug === record.slug),
  );
  await runtime.setCache(
    BUILT_APPS_CACHE_KEY,
    [record, ...rest].slice(0, MAX_BUILT_APPS),
  );
  return true;
}

/**
 * Task-completion hook: derive + persist the built app for a completion whose
 * URLs verified live. Never throws — a registry failure must not break the
 * completion delivery to the user. Returns the record when one was written.
 */
export async function registerBuiltAppsForCompletion(
  runtime: unknown,
  session: Pick<SessionInfo, "id" | "metadata">,
  verifiedUrls: readonly string[],
  log?: (level: "info" | "warn", message: string, ctx?: unknown) => void,
): Promise<BuiltAppRecord | null> {
  try {
    const meta = session.metadata;
    // The task text's metadata carrier differs by spawn path: TASKS
    // op=spawn_agent stamps the full `initialTask`, while the durable-task
    // route (`spawnAgentForTask`) and the direct API spawn persist the bare
    // `goal`. Accept either so the eliza-cloud app-build gate sees the task
    // on every spawn path — an app built via a durable task must register
    // the same way a chat-spawned one does.
    const initialTask =
      typeof meta?.initialTask === "string"
        ? meta.initialTask
        : typeof meta?.goal === "string"
          ? meta.goal
          : undefined;
    const derived = deriveBuiltApp(
      verifiedUrls,
      resolveAppDeployConfig(),
      initialTask,
    );
    if (!derived) return null;
    const label = typeof meta?.label === "string" ? meta.label : undefined;
    const record: BuiltAppRecord = {
      ...derived,
      sessionId: session.id,
      ...(label ? { label } : {}),
      registeredAt: new Date().toISOString(),
    };
    if (!(await registerBuiltApp(runtime, record))) {
      log?.("warn", "built-app registry unavailable (no runtime cache)", {
        sessionId: session.id,
        slug: record.slug,
      });
      return null;
    }
    log?.("info", "registered built app", {
      sessionId: session.id,
      slug: record.slug,
      target: record.target,
      url: record.url,
    });
    return record;
  } catch (err) {
    log?.("warn", "built-app registration failed", {
      sessionId: session.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
