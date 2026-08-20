/**
 * OWNER-only account-pool consumer-key admin contracts and HTTP methods
 * (`/api/accounts/consumer-keys*`, #16478). Importing this module installs the
 * methods on ElizaClient. Responses are validated here because the agent is a
 * separate process; a malformed reply must fail loudly instead of rendering
 * undefined fields. Plaintext keys appear only in create/rotate responses and
 * are handed straight to the caller — never cached, logged, or re-fetched.
 */

import { ElizaClient } from "./client-base";

/** Consumer-key list GET — existing 10s REST budget, independent hop. */
export const CONSUMER_KEYS_LIST_FETCH_TIMEOUT_MS = 10_000;

export interface ConsumerKeySummary {
  id: string;
  label: string;
  enabled: boolean;
  dailyTokenQuota: number | null;
  keyPrefix: string;
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
}

export interface ConsumerKeyCreated {
  /** One-time plaintext key. Shown once, never persisted. */
  key: string;
  consumer: ConsumerKeySummary;
}

export interface ConsumerKeyPatch {
  label?: string;
  enabled?: boolean;
  dailyTokenQuota?: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSummary(value: unknown): ConsumerKeySummary {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.label !== "string" ||
    typeof value.enabled !== "boolean" ||
    typeof value.keyPrefix !== "string" ||
    typeof value.createdAt !== "number" ||
    typeof value.updatedAt !== "number" ||
    (value.dailyTokenQuota !== null &&
      typeof value.dailyTokenQuota !== "number")
  ) {
    throw new Error("Malformed consumer-key record from agent");
  }
  return {
    id: value.id,
    label: value.label,
    enabled: value.enabled,
    dailyTokenQuota: value.dailyTokenQuota as number | null,
    keyPrefix: value.keyPrefix,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...(typeof value.lastUsedAt === "number"
      ? { lastUsedAt: value.lastUsedAt }
      : {}),
  };
}

function parseCreated(value: unknown): ConsumerKeyCreated {
  if (!isRecord(value) || typeof value.key !== "string" || !value.key) {
    throw new Error("Malformed consumer-key create/rotate response");
  }
  return { key: value.key, consumer: parseSummary(value.consumer) };
}

declare module "./client-base" {
  interface ElizaClient {
    listConsumerKeys(timeoutMs?: number): Promise<ConsumerKeySummary[]>;
    createConsumerKey(body: ConsumerKeyPatch): Promise<ConsumerKeyCreated>;
    updateConsumerKey(
      id: string,
      body: ConsumerKeyPatch,
    ): Promise<ConsumerKeySummary>;
    rotateConsumerKey(id: string): Promise<ConsumerKeyCreated>;
  }
}

ElizaClient.prototype.listConsumerKeys = async function (
  this: ElizaClient,
  timeoutMs: number = CONSUMER_KEYS_LIST_FETCH_TIMEOUT_MS,
) {
  const response = await this.fetch<unknown>(
    "/api/accounts/consumer-keys",
    undefined,
    { timeoutMs },
  );
  if (!isRecord(response) || !Array.isArray(response.keys)) {
    throw new Error("Malformed consumer-key list from agent");
  }
  return response.keys.map(parseSummary);
};

ElizaClient.prototype.createConsumerKey = async function (
  this: ElizaClient,
  body,
) {
  const response = await this.fetch<unknown>("/api/accounts/consumer-keys", {
    method: "POST",
    body: JSON.stringify(body),
  });
  return parseCreated(response);
};

ElizaClient.prototype.updateConsumerKey = async function (
  this: ElizaClient,
  id,
  body,
) {
  const response = await this.fetch<unknown>(
    `/api/accounts/consumer-keys/${encodeURIComponent(id)}`,
    { method: "PATCH", body: JSON.stringify(body) },
  );
  if (!isRecord(response)) {
    throw new Error("Malformed consumer-key update response");
  }
  return parseSummary(response.consumer);
};

ElizaClient.prototype.rotateConsumerKey = async function (
  this: ElizaClient,
  id,
) {
  const response = await this.fetch<unknown>(
    `/api/accounts/consumer-keys/${encodeURIComponent(id)}/rotate`,
    { method: "POST" },
  );
  return parseCreated(response);
};
