import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_API_BASE_URL = "https://api.elizacloud.ai/api/v1";

export const APP_ID_KEYS = [
  "appId",
  "cloudAppId",
  "elizaCloudAppId",
  "eliza_cloud_app_id",
];

export function envString(...names: string[]): string | null {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return null;
}

export function normalizeApiBaseUrl(value: string | null): string {
  const raw = (value ?? DEFAULT_API_BASE_URL).replace(/\/+$/, "");
  if (raw.endsWith("/api/v1")) return raw;
  if (raw.endsWith("/api")) return `${raw}/v1`;
  return `${raw}/api/v1`;
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

export function resolveApiKey(): string | null {
  return (
    envString(
      "ELIZAOS_CLOUD_API_KEY",
      "ELIZA_CLOUD_API_KEY",
      "ELIZACLOUD_API_KEY",
    ) ?? readCredentialsApiKey()
  );
}

export function resolveApiBaseUrl(): string {
  return normalizeApiBaseUrl(
    envString(
      "ELIZA_CLOUD_API_BASE_URL",
      "ELIZAOS_CLOUD_API_BASE_URL",
      "ELIZACLOUD_API_BASE_URL",
      "ELIZA_CLOUD_BASE_URL",
    ),
  );
}

function jsonSummary(value: unknown): string {
  if (!value || typeof value !== "object") return String(value ?? "");
  const record = value as Record<string, unknown>;
  const error = record.error ?? record.message;
  return typeof error === "string" ? error : JSON.stringify(record);
}

export async function cloudRequest<T>(
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
