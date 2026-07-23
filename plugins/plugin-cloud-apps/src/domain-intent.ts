/**
 * Pure helpers shared by the domain actions: extracting domain names from
 * planner options or message text, resolving which app a request targets,
 * money formatting, and duck-typed CloudApiError inspection. Keeping these
 * decisions shared makes read-only status checks and paid purchases resolve
 * the same user references without importing the SDK error class at runtime.
 */

import type { AppDto, ElizaCloudClient } from "@elizaos/cloud-sdk";
import { ElizaError, type Memory, type ProjectRecord } from "@elizaos/core";
import {
  extractAppReference,
  looksLikeAppId,
  matchAppByReference,
  type ResolvedApp,
} from "./client.js";
import {
  type ProjectResolution,
  projectResolutionMessage,
  resolveProject,
} from "./project-resolution.js";

/**
 * Mirror of the server's canonical domain schema
 * (`packages/cloud/api/v1/apps/[id]/domains/schemas.ts`): dot-separated
 * labels, alphabetic TLD of 2+ chars, 4–253 chars overall. Used to fail fast
 * with a friendly message instead of a server 400.
 */
const DOMAIN_SHAPE = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i;

/**
 * Find domain-shaped tokens inside free text ("buy example.com for my bot").
 *
 * The left guard rejects tokens glued to letters/digits/`._@-` so an IDN like
 * "münchen.de" is never mangled into a bogus ASCII tail ("nchen.de") and an
 * email's domain part is not extracted as a purchase target. Labels are a flat
 * `[a-z0-9-]{0,62}` run (no nested optional groups → linear scan, no
 * catastrophic backtracking on pasted dotted text); trailing-hyphen shapes the
 * flat run admits are rejected by {@link isValidDomain} afterwards.
 */
const DOMAIN_TOKEN =
  /(?<![\p{L}\p{N}._@-])(?:[a-z0-9][a-z0-9-]{0,62}\.)+[a-z]{2,24}(?![\p{L}\p{N}-])/giu;

/** Bound the prose scan — nobody names a purchase target 4000 chars in. */
const MAX_SCANNED_TEXT = 4000;

/** True when `value` is a registrable-looking domain (server-schema mirror). */
export function isValidDomain(value: string): boolean {
  const v = value.trim();
  return v.length >= 4 && v.length <= 253 && DOMAIN_SHAPE.test(v);
}

function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

/**
 * Planner-validated args arrive nested under `options.parameters` on the real
 * planner path (execute-planned-tool-call.ts) and at the top level on direct
 * handler calls — merge both (nested wins) so extraction sees either shape.
 */
export function actionParams(options?: unknown): Record<string, unknown> {
  if (!options || typeof options !== "object") return {};
  const top = options as Record<string, unknown>;
  const nested =
    top.parameters && typeof top.parameters === "object"
      ? (top.parameters as Record<string, unknown>)
      : {};
  return { ...top, ...nested };
}

const DOMAIN_OPTION_KEYS = ["domain", "domainName", "hostname"] as const;

/**
 * Extract the distinct domain names a message refers to. A planner-supplied
 * option always wins; otherwise every domain-shaped token in the text is
 * collected (deduped, normalized to lowercase, invalid shapes dropped) so the
 * money action can refuse to guess when several domains are named at once.
 */
export function extractDomainReferences(
  message: Memory,
  options?: unknown,
): string[] {
  const params = actionParams(options);
  for (const key of DOMAIN_OPTION_KEYS) {
    const value = params[key];
    if (typeof value === "string" && value.trim().length > 0) {
      const domain = normalizeDomain(value);
      return isValidDomain(domain) ? [domain] : [];
    }
  }
  const text = (message.content?.text ?? "").slice(0, MAX_SCANNED_TEXT);
  const seen = new Set<string>();
  for (const match of text.matchAll(DOMAIN_TOKEN)) {
    const domain = normalizeDomain(match[0]);
    if (isValidDomain(domain)) seen.add(domain);
  }
  return [...seen];
}

/** Format integer USD cents as "$12.34". */
export function usdFromCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** Resolution of which app a domain request targets. */
export interface DomainTargetApp extends ResolvedApp {
  /**
   * True when no reference matched but the user has exactly one app, so it
   * was used as the obvious default.
   */
  defaulted?: boolean;
  /** The user's apps as fetched during resolution (for app-agnostic fallbacks). */
  apps: AppDto[];
}

export type DomainProjectResolutionReason =
  | NonNullable<ProjectResolution["reason"]>
  | "not_published";

/**
 * Project-scoped domain reads resolve locally first, then cross the Cloud
 * boundary through the registry's sole `cloudAppId` binding.
 */
export interface DomainTargetProject {
  project: ProjectRecord | null;
  app: AppDto | null;
  resolution: ProjectResolution;
  reason?: DomainProjectResolutionReason;
}

/** Planner-option keys used by the legacy app-inventory resolver. */
const EXPLICIT_APP_KEYS = ["app", "appName", "name", "id", "appId"] as const;

const PROJECT_OPTION_KEYS = ["projectId", "project", "projectName"] as const;
const LEGACY_PROJECT_OPTION_KEYS = EXPLICIT_APP_KEYS;

/**
 * Older planner schemas called the target `appName`/`appId`. Preserve those
 * inputs as references to a local Project while making project-native keys win.
 */
function projectScopedOptions(options?: unknown): unknown {
  const params = actionParams(options);
  const hasProjectReference = PROJECT_OPTION_KEYS.some(
    (key) =>
      typeof params[key] === "string" &&
      (params[key] as string).trim().length > 0,
  );
  if (hasProjectReference) return options;

  for (const key of LEGACY_PROJECT_OPTION_KEYS) {
    const value = params[key];
    if (typeof value === "string" && value.trim().length > 0) {
      const top =
        options && typeof options === "object"
          ? (options as Record<string, unknown>)
          : {};
      return {
        ...top,
        parameters: { ...params, project: value.trim() },
      };
    }
  }
  return options;
}

/**
 * Resolve an app-scoped domain read through ProjectRecord → cloudAppId.
 *
 * The shared project resolver supplies explicit, active, and sole-project
 * semantics. Cloud inventory is never used as a fallback because that would
 * let a creator-side project command escape the durable local binding model.
 */
export async function resolveDomainTargetProject(
  client: ElizaCloudClient,
  message: Memory,
  options?: unknown,
): Promise<DomainTargetProject> {
  const resolution = resolveProject(message, projectScopedOptions(options));
  const project = resolution.project;
  if (!project) {
    if (!resolution.reason) {
      throw new ElizaError(
        "Project resolution returned no project and no failure reason",
        {
          code: "PROJECT_RESOLUTION_INVALID",
          severity: "fatal",
        },
      );
    }
    return {
      project: null,
      app: null,
      resolution,
      reason: resolution.reason,
    };
  }
  if (!project.cloudAppId) {
    return {
      project,
      app: null,
      resolution,
      reason: "not_published",
    };
  }

  const response = await client.getApp(project.cloudAppId);
  if (!response.app || response.app.id !== project.cloudAppId) {
    throw new ElizaError(
      "Cloud returned an invalid app for the project's publication binding",
      {
        code: "PROJECT_CLOUD_APP_INVALID",
        context: {
          projectId: project.id,
          cloudAppId: project.cloudAppId,
          returnedAppId: response.app?.id,
        },
        severity: "fatal",
      },
    );
  }
  return { project, app: response.app, resolution };
}

/** User-facing failure for an app-scoped domain read. */
export function domainProjectResolutionMessage(
  target: DomainTargetProject,
): string {
  if (target.reason === "not_published" && target.project) {
    return `"${target.project.name}" is not published yet, so it has no Cloud domain settings.`;
  }
  return projectResolutionMessage(target.resolution);
}

function hasExplicitAppReference(options?: unknown): boolean {
  const params = actionParams(options);
  return EXPLICIT_APP_KEYS.some(
    (key) =>
      typeof params[key] === "string" &&
      (params[key] as string).trim().length > 0,
  );
}

/**
 * Resolve the app a domain action targets. Like {@link resolveApp}, plus a
 * sole-app default: domain requests often name only the domain ("buy
 * example.com"), so when the free-text reference matches nothing and the user
 * has exactly one app, that app is the unambiguous target. The default is
 * suppressed when the planner supplied an EXPLICIT app reference that matched
 * nothing — the user named a specific app, so guessing a different one is
 * wrong even with only one to guess. With several apps and no match the
 * caller must ask (never guess where a purchase attaches).
 */
export async function resolveDomainTargetApp(
  client: ElizaCloudClient,
  message: Memory,
  options?: unknown,
): Promise<DomainTargetApp> {
  const reference = extractAppReference(message, actionParams(options));
  if (looksLikeAppId(reference)) {
    // A stale/foreign UUID must fall through to name resolution (and its
    // helpful which-app reply), not abort the whole action on the 404.
    try {
      const { app } = await client.getApp(reference);
      if (app) return { app, available: [app.name], apps: [app] };
    } catch {
      // fall through to list-based resolution
    }
  }
  const { apps } = await client.listApps();
  const list = apps ?? [];
  const available = list.map((a) => a.name);
  const match = matchAppByReference(list, reference);
  if (match.app) return { app: match.app, available, apps: list };
  if (match.candidates.length > 1) {
    return {
      app: null,
      available,
      ambiguous: match.candidates.map((a) => a.name),
      apps: list,
    };
  }
  if (list.length === 1 && !hasExplicitAppReference(options)) {
    return { app: list[0], available, defaulted: true, apps: list };
  }
  return { app: null, available, apps: list };
}

/** What a domain action needs to know about a thrown Cloud API error. */
export interface CloudErrorInfo {
  /** HTTP status when the error was a CloudApiError, else null. */
  status: number | null;
  /** The server's machine-readable `code` field, when present. */
  code: string | null;
  /** Human message (the server's `error` field when available). */
  message: string;
}

/**
 * Duck-typed view of an SDK `CloudApiError` (`statusCode` + `errorBody`).
 * Never throws; unknown errors come back as `{ status: null, code: null }`.
 */
export function cloudErrorInfo(err: unknown): CloudErrorInfo {
  let status: number | null = null;
  let code: string | null = null;
  let bodyError: string | null = null;
  if (typeof err === "object" && err !== null) {
    const e = err as Record<string, unknown>;
    if (typeof e.statusCode === "number") status = e.statusCode;
    if (e.errorBody && typeof e.errorBody === "object") {
      const body = e.errorBody as Record<string, unknown>;
      if (typeof body.code === "string") code = body.code;
      if (typeof body.error === "string") bodyError = body.error;
    }
  }
  const message =
    bodyError ??
    (err instanceof Error ? err.message : String(err ?? "unknown error"));
  return { status, code, message };
}

/** Human summary line for one attached domain (LIST_APP_DOMAINS). */
export function formatDomainLine(domain: {
  domain: string;
  registrar: string;
  status: string;
  verified: boolean;
  /** Nullable: the ssl_status column has a default but no NOT NULL. */
  sslStatus: string | null;
  expiresAt: string | null;
  /** The TXT verification token (present for unverified external domains). */
  verificationToken?: string | null;
}): string {
  const parts = [
    domain.registrar === "cloudflare"
      ? "registered through Eliza Cloud"
      : "external",
    domain.status,
    `SSL ${domain.sslStatus ?? "pending"}`,
  ];
  if (domain.registrar === "external" && !domain.verified) {
    parts.push(
      domain.verificationToken
        ? `needs DNS verification (add a TXT record at _eliza-cloud-verify.${domain.domain} with value ${domain.verificationToken})`
        : `needs DNS verification (add the TXT record at _eliza-cloud-verify.${domain.domain})`,
    );
  }
  if (domain.expiresAt) {
    const day = domain.expiresAt.slice(0, 10);
    if (day) parts.push(`renews ${day}`);
  }
  return `• ${domain.domain} — ${parts.join(", ")}`;
}

/** One AppDto field the domain actions surface in replies. */
export function appLabel(app: AppDto): string {
  return `"${app.name}" (${app.id})`;
}
