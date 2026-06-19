/**
 * `elizaos deploy`
 *
 * @experimental
 * Queues an Eliza Cloud app deployment through the cloud API and polls until
 * the deployment reaches a public terminal state.
 */

import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import pc from "picocolors";
import type { DeployOptions } from "../types.js";

const DOMAIN_REGEX = /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;
const DEFAULT_API_BASE_URL = "https://api.elizacloud.ai/api/v1";
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_POLL_TIMEOUT_MS = 10 * 60_000;
const APP_ID_KEYS = [
  "appId",
  "cloudAppId",
  "elizaCloudAppId",
  "eliza_cloud_app_id",
];

type DeployStatus = "DRAFT" | "BUILDING" | "READY" | "ERROR" | string;

interface PlannedStep {
  label: string;
  detail: string;
  skipped?: boolean;
}

interface ProjectMetadataLike {
  templateId?: unknown;
  values?: Record<string, unknown>;
}

interface CloudAppLike {
  id?: unknown;
  name?: unknown;
  app_url?: unknown;
  appUrl?: unknown;
}

interface DeployResponse {
  success?: boolean;
  deploymentId?: string | null;
  status?: DeployStatus;
  startedAt?: string | null;
  error?: string;
}

interface DeployStatusResponse extends DeployResponse {
  vercelUrl?: string | null;
}

function buildPlan(options: DeployOptions, _cwd: string): PlannedStep[] {
  const appId = options.appId ?? "<resolved from .elizaos/template.json>";
  const domain = options.domain;
  return [
    {
      label: "auth check",
      detail:
        "Load credentials from env or ~/.elizaos/credentials.json and send Bearer auth.",
    },
    {
      label: "app lookup",
      detail: `Resolve app-id (${appId}) from --app-id, .elizaos/template.json, or owned apps.`,
    },
    {
      label: "trigger deploy",
      detail: `POST /api/v1/apps/${appId}/deploy using the app's linked repository and stored env config.`,
    },
    {
      label: "attach custom domain",
      detail: domain
        ? `POST /api/v1/apps/${appId}/domains { domain: "${domain}" } and surface DNS TXT record if verification is pending.`
        : "(no --domain provided — using default apps.elizacloud.ai subdomain).",
      skipped: !domain,
    },
    {
      label: "poll status",
      detail: `GET /api/v1/apps/${appId}/deploy/status every 5s until READY|ERROR (10min cap).`,
    },
    {
      label: "print URL",
      detail: domain
        ? `URL: https://${domain}  (+ apps.elizacloud.ai subdomain).`
        : "URL: https://<subdomain>.apps.elizacloud.ai",
    },
  ];
}

function printPlan(plan: PlannedStep[]): void {
  console.log();
  console.log(pc.bold(pc.cyan("elizaos deploy — dry run")));
  console.log(pc.dim("Planned sequence (no network calls performed):"));
  console.log();
  plan.forEach((step, index) => {
    const num = pc.dim(`${(index + 1).toString().padStart(2, " ")}.`);
    const label = step.skipped
      ? pc.dim(pc.strikethrough(step.label))
      : pc.bold(step.label);
    console.log(`  ${num} ${label}`);
    console.log(`      ${pc.dim(step.detail)}`);
  });
  console.log();
  console.log(
    pc.dim(
      "See https://github.com/elizaOS/eliza/blob/develop/packages/elizaos/src/commands/DEPLOY_DESIGN.md for the full design.",
    ),
  );
  console.log();
}

function envString(...names: string[]): string | null {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return null;
}

function normalizeApiBaseUrl(value: string | null): string {
  const raw = (value ?? DEFAULT_API_BASE_URL).replace(/\/+$/, "");
  if (raw.endsWith("/api/v1")) return raw;
  if (raw.endsWith("/api")) return `${raw}/v1`;
  return `${raw}/api/v1`;
}

function readProjectMetadata(cwd: string): ProjectMetadataLike | null {
  const file = path.join(cwd, ".elizaos", "template.json");
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object"
      ? (parsed as ProjectMetadataLike)
      : null;
  } catch {
    return null;
  }
}

function credentialCandidates(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const directKeys = [
    "apiKey",
    "api_key",
    "elizaCloudApiKey",
    "eliza_cloud_api_key",
    "ELIZAOS_CLOUD_API_KEY",
    "ELIZA_CLOUD_API_KEY",
    "ELIZACLOUD_API_KEY",
  ];
  const direct = directKeys
    .map((key) => record[key])
    .filter((candidate): candidate is string => typeof candidate === "string");
  const nested = ["cloud", "elizaCloud", "elizacloud"]
    .flatMap((key) => credentialCandidates(record[key]))
    .filter((candidate) => candidate.length > 0);
  return [...direct, ...nested].map((candidate) => candidate.trim());
}

function readCredentialsApiKey(): string | null {
  const file = path.join(os.homedir(), ".elizaos", "credentials.json");
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return credentialCandidates(parsed).find((candidate) => candidate) ?? null;
  } catch {
    return null;
  }
}

function resolveApiKey(): string | null {
  return (
    envString(
      "ELIZAOS_CLOUD_API_KEY",
      "ELIZA_CLOUD_API_KEY",
      "ELIZACLOUD_API_KEY",
    ) ?? readCredentialsApiKey()
  );
}

function metadataAppId(metadata: ProjectMetadataLike | null): string | null {
  const values = metadata?.values;
  if (!values) return null;
  for (const key of APP_ID_KEYS) {
    const value = values[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function metadataNameCandidates(
  metadata: ProjectMetadataLike | null,
): Set<string> {
  const values = metadata?.values ?? {};
  const candidates = [
    values.appName,
    values.projectSlug,
    values.repoName,
    values.name,
  ]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0);
  return new Set(candidates);
}

function pollIntervalMs(): number {
  const value = Number(process.env.ELIZAOS_DEPLOY_POLL_INTERVAL_MS);
  return Number.isFinite(value) && value >= 0
    ? value
    : DEFAULT_POLL_INTERVAL_MS;
}

function pollTimeoutMs(): number {
  const value = Number(process.env.ELIZAOS_DEPLOY_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_POLL_TIMEOUT_MS;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jsonSummary(value: unknown): string {
  if (!value || typeof value !== "object") return String(value ?? "");
  const record = value as Record<string, unknown>;
  const error = record.error ?? record.message;
  return typeof error === "string" ? error : JSON.stringify(record);
}

async function cloudRequest<T>(
  apiBaseUrl: string,
  apiKey: string,
  method: string,
  routePath: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${routePath}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(body === undefined
        ? {}
        : { "Content-Type": "application/json; charset=utf-8" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(
      `${method} ${routePath} failed (${response.status}): ${jsonSummary(parsed)}`,
    );
  }
  return parsed as T;
}

async function resolveAppId(
  options: DeployOptions,
  cwd: string,
  apiBaseUrl: string,
  apiKey: string,
): Promise<string> {
  if (options.appId?.trim()) return options.appId.trim();

  const metadata = readProjectMetadata(cwd);
  const fromMetadata = metadataAppId(metadata);
  if (fromMetadata) return fromMetadata;

  const names = metadataNameCandidates(metadata);
  if (names.size > 0) {
    const response = await cloudRequest<{ apps?: CloudAppLike[] }>(
      apiBaseUrl,
      apiKey,
      "GET",
      "/apps",
    );
    const matches = (response.apps ?? []).filter((app) => {
      const name = typeof app.name === "string" ? app.name.toLowerCase() : "";
      return names.has(name);
    });
    if (matches.length === 1 && typeof matches[0]?.id === "string") {
      return matches[0].id;
    }
    if (matches.length > 1) {
      throw new Error(
        "Multiple owned Eliza Cloud apps match this project name; pass --app-id explicitly.",
      );
    }
  }

  throw new Error(
    "Unable to resolve Eliza Cloud app id. Pass --app-id or add values.appId to .elizaos/template.json.",
  );
}

async function attachDomain(
  apiBaseUrl: string,
  apiKey: string,
  appId: string,
  domain: string,
): Promise<void> {
  const response = await cloudRequest<Record<string, unknown>>(
    apiBaseUrl,
    apiKey,
    "POST",
    `/apps/${encodeURIComponent(appId)}/domains`,
    { domain },
  );
  console.log(pc.green(`Attached domain ${domain}.`));
  const record = response.verificationRecord;
  if (record && typeof record === "object") {
    console.log(pc.yellow("DNS verification is pending. Add this record:"));
    for (const [key, value] of Object.entries(record)) {
      console.log(`  ${key}: ${String(value)}`);
    }
  }
}

async function pollDeploymentStatus(
  apiBaseUrl: string,
  apiKey: string,
  appId: string,
): Promise<DeployStatusResponse> {
  const startedAt = Date.now();
  const timeoutMs = pollTimeoutMs();
  const intervalMs = pollIntervalMs();
  while (true) {
    const status = await cloudRequest<DeployStatusResponse>(
      apiBaseUrl,
      apiKey,
      "GET",
      `/apps/${encodeURIComponent(appId)}/deploy/status`,
    );
    if (status.status === "READY" || status.status === "ERROR") {
      return status;
    }
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(
        `Deploy did not reach READY or ERROR within ${timeoutMs}ms; latest status: ${status.status ?? "unknown"}`,
      );
    }
    console.log(pc.dim(`Deploy status: ${status.status ?? "unknown"}...`));
    if (intervalMs > 0) await sleep(intervalMs);
  }
}

export async function runDeploy(options: DeployOptions): Promise<number> {
  if (options.domain && !DOMAIN_REGEX.test(options.domain)) {
    console.error(
      pc.red(
        `Invalid --domain "${options.domain}". Expected a valid hostname (e.g. app.example.com).`,
      ),
    );
    return 1;
  }

  const cwd = process.cwd();
  const plan = buildPlan(options, cwd);
  const apiBaseUrl = normalizeApiBaseUrl(
    envString(
      "ELIZA_CLOUD_API_BASE_URL",
      "ELIZAOS_CLOUD_API_BASE_URL",
      "ELIZACLOUD_API_BASE_URL",
      "ELIZA_CLOUD_BASE_URL",
    ),
  );

  if (options.verbose) {
    console.error(pc.dim(`[deploy] cwd=${cwd}`));
    console.error(pc.dim(`[deploy] options=${JSON.stringify(options)}`));
    console.error(pc.dim(`[deploy] apiBaseUrl=${apiBaseUrl}`));
  }

  if (options.dryRun) {
    printPlan(plan);
    return 0;
  }

  try {
    const apiKey = resolveApiKey();
    if (!apiKey) {
      throw new Error(
        "Missing Eliza Cloud API key. Set ELIZAOS_CLOUD_API_KEY, ELIZA_CLOUD_API_KEY, ELIZACLOUD_API_KEY, or ~/.elizaos/credentials.json.",
      );
    }
    const appId = await resolveAppId(options, cwd, apiBaseUrl, apiKey);
    console.log(pc.bold(`Deploying Eliza Cloud app ${appId}`));

    const deployResponse = await cloudRequest<DeployResponse>(
      apiBaseUrl,
      apiKey,
      "POST",
      `/apps/${encodeURIComponent(appId)}/deploy`,
      {},
    );
    console.log(
      pc.green(
        `Deployment queued${deployResponse.deploymentId ? ` (${deployResponse.deploymentId})` : ""}.`,
      ),
    );

    if (options.domain) {
      await attachDomain(apiBaseUrl, apiKey, appId, options.domain);
    }

    const finalStatus = await pollDeploymentStatus(apiBaseUrl, apiKey, appId);
    if (finalStatus.status === "ERROR") {
      console.error(
        pc.red(`Deploy failed: ${finalStatus.error ?? "unknown error"}`),
      );
      return 1;
    }

    console.log(pc.green("Deploy ready."));
    if (finalStatus.vercelUrl) {
      console.log(`URL: ${finalStatus.vercelUrl}`);
    }
    if (options.domain) {
      console.log(`Custom domain: https://${options.domain}`);
    }
    return 0;
  } catch (error) {
    console.error(
      pc.red(error instanceof Error ? error.message : String(error)),
    );
    return 1;
  }
}

export async function deploy(options: DeployOptions): Promise<void> {
  process.exit(await runDeploy(options));
}
