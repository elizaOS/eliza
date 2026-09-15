/** Proves Cloud Apps cannot late-activate or redirect launcher-owned credentials. */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { IAgentRuntime } from "@elizaos/core";
import {
  captureDevCloudEnvAuthoritySnapshot,
  resetDevCloudEnvAuthorityForTests,
} from "@elizaos/shared";
import { ElizaCloudClient as RealElizaCloudClient } from "../../../packages/cloud/sdk/src/client";
import { resolveCloudClientTuple } from "../src/client";

const AUTHORITY_KEYS = [
  "ELIZA_DEV_SOURCE",
  "ELIZA_DEV_CLOUD_ENV_AUTHORITY",
  "ELIZAOS_CLOUD_API_KEY",
  "ELIZAOS_CLOUD_BASE_URL",
] as const;

const originalEnv = Object.fromEntries(
  AUTHORITY_KEYS.map((key) => [key, process.env[key]]),
);
const realFetch = globalThis.fetch;

function runtimeWith(settings: Record<string, unknown>): IAgentRuntime {
  return {
    getSetting: mock((key: string) => settings[key]),
  } as unknown as IAgentRuntime;
}

function captureAuthority(
  authority:
    | "staging-default"
    | "staging-explicit"
    | "production"
    | "offline"
    | "self-hosted",
): { apiKey: string; baseUrl: string } {
  const baseUrl =
    authority === "production"
      ? "https://api.eliza.app/api/v1"
      : authority === "self-hosted"
        ? "http://127.0.0.1:8787/api/v1"
        : "https://api-staging.eliza.app/api/v1";
  const apiKey = "launch-cloud-key";
  process.env.ELIZA_DEV_SOURCE = "1";
  process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = authority;
  process.env.ELIZAOS_CLOUD_API_KEY = apiKey;
  process.env.ELIZAOS_CLOUD_BASE_URL = baseUrl;
  resetDevCloudEnvAuthorityForTests();
  captureDevCloudEnvAuthoritySnapshot();
  return { apiKey, baseUrl };
}

function poisonAfterCapture(settings: Record<string, unknown>): void {
  process.env.ELIZAOS_CLOUD_API_KEY = "late-process-key";
  process.env.ELIZAOS_CLOUD_BASE_URL =
    "https://process-collector.example/api/v1";
  settings.ELIZAOS_CLOUD_API_KEY = "late-runtime-key";
  settings.ELIZAOS_CLOUD_BASE_URL = "https://runtime-collector.example/api/v1";
}

beforeEach(() => {
  resetDevCloudEnvAuthorityForTests();
  for (const key of AUTHORITY_KEYS) delete process.env[key];
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const key of AUTHORITY_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetDevCloudEnvAuthorityForTests();
});

describe("Cloud Apps launcher authority", () => {
  it.each(["staging-default", "offline"] as const)(
    "keeps Cloud Apps disabled under %s after late activation",
    (authority) => {
      captureAuthority(authority);
      const settings: Record<string, unknown> = {};
      poisonAfterCapture(settings);
      const fetch = mock(async () => new Response("{}", { status: 200 }));
      globalThis.fetch = fetch as typeof globalThis.fetch;

      expect(resolveCloudClientTuple(runtimeWith(settings)).apiKey).toBeNull();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each(["staging-explicit", "production", "self-hosted"] as const)(
    "uses only the frozen %s destination and credential after late pollution",
    async (authority) => {
      const launch = captureAuthority(authority);
      const settings: Record<string, unknown> = {};
      poisonAfterCapture(settings);
      const fetch = mock(async () =>
        Response.json({ success: true, apps: [] }),
      );
      globalThis.fetch = fetch as typeof globalThis.fetch;

      const tuple = resolveCloudClientTuple(runtimeWith(settings));
      expect(tuple.apiKey).toBe(launch.apiKey);
      const client = new RealElizaCloudClient({
        apiBaseUrl: tuple.apiBaseUrl,
        baseUrl: tuple.apiBaseUrl.replace(/\/api\/v1\/?$/, ""),
        apiKey: tuple.apiKey ?? undefined,
        fetchImpl: fetch as typeof globalThis.fetch,
      });
      await client.listApps();

      expect(fetch).toHaveBeenCalledTimes(1);
      const [input, init] = fetch.mock.calls[0] as [
        string | URL | Request,
        RequestInit,
      ];
      expect(String(input)).toBe(`${launch.baseUrl}/apps`);
      const headers = new Headers(init.headers);
      expect(headers.get("authorization")).toBe(`Bearer ${launch.apiKey}`);
      expect(headers.get("x-api-key")).toBe(launch.apiKey);
    },
  );

  it("preserves runtime configuration without launcher authority", async () => {
    const fetch = mock(async () => Response.json({ success: true, apps: [] }));
    globalThis.fetch = fetch as typeof globalThis.fetch;
    const tuple = resolveCloudClientTuple(
      runtimeWith({
        ELIZAOS_CLOUD_API_KEY: "runtime-key",
        ELIZAOS_CLOUD_BASE_URL: "https://runtime-cloud.example/api/v1",
      }),
    );
    const client = new RealElizaCloudClient({
      apiBaseUrl: tuple.apiBaseUrl,
      baseUrl: tuple.apiBaseUrl.replace(/\/api\/v1\/?$/, ""),
      apiKey: tuple.apiKey ?? undefined,
      fetchImpl: fetch as typeof globalThis.fetch,
    });

    await client.listApps();

    const [input, init] = fetch.mock.calls[0] as [
      string | URL | Request,
      RequestInit,
    ];
    expect(String(input)).toBe("https://runtime-cloud.example/api/v1/apps");
    expect(new Headers(init.headers).get("authorization")).toBe(
      "Bearer runtime-key",
    );
  });
});
