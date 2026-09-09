/**
 * Exercises join and desktop login through the real Cloud client and persistence
 * with deterministic HTTP responses. Entry must bind the authoritative runtime
 * without sending activation, quote, provisioning, or cutover requests.
 */
// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ElizaClient } from "../../../api/client-base";
import "../../../api/client-cloud";
import { bindDirectCloudLoginToPersonalAgent } from "../../../state/bind-direct-cloud-login";
import {
  loadPersistedActiveServer,
  savePersistedActiveServer,
  savePersistedFirstRunComplete,
} from "../../../state/persistence";
import { runJoinFlow } from "./run-join-flow";

const CLOUD_BASE = "https://api.eliza.app";
const PERSONAL_ID = "personal:00000000-0000-5000-8000-000000000001";
const DEDICATED_ID = "00000000-0000-4000-8000-000000000020";
const DEDICATED_BASE = `https://${DEDICATED_ID}.cloud.eliza.app`;
const SHARED_BASE = `${CLOUD_BASE}/api/v1/eliza/agents/${encodeURIComponent(PERSONAL_ID)}`;

function transport(runtime: "shared" | "dedicated", status = 200) {
  const calls: Array<{ method: string; url: string }> = [];
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ method, url });
      if (method !== "GET" || url !== `${CLOUD_BASE}/api/v1/eliza/personal`) {
        throw new Error(`Unexpected entry request: ${method} ${url}`);
      }
      return Response.json(
        status === 200
          ? {
              success: true,
              data: {
                identity: {
                  id: PERSONAL_ID,
                  displayName: "Eliza",
                  runtime,
                  ...(runtime === "dedicated"
                    ? { activeAgentId: DEDICATED_ID, apiBase: DEDICATED_BASE }
                    : {}),
                },
              },
            }
          : { error: "Existing runtime unavailable" },
        { status },
      );
    },
  );
  return calls;
}

const entries = {
  join: (client: ElizaClient) =>
    runJoinFlow({
      client,
      effects: { savePersistedActiveServer, savePersistedFirstRunComplete },
      cloudApiBase: CLOUD_BASE,
      authToken: "test-session-token",
    }),
  desktop: (client: ElizaClient) =>
    bindDirectCloudLoginToPersonalAgent({
      client,
      cloudApiBase: CLOUD_BASE,
      token: "test-session-token",
    }),
};

beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe.each(Object.entries(entries))(
  "%s read-only personal entry",
  (_name, enter) => {
    it.each(["shared", "dedicated"] as const)(
      "opens the current %s runtime and preserves it on repeated entry",
      async (runtime) => {
        const calls = transport(runtime);
        for (let attempt = 0; attempt < 2; attempt += 1) {
          await enter(new ElizaClient());
          expect(loadPersistedActiveServer()).toMatchObject({
            id: `cloud:${PERSONAL_ID}`,
            cloudRuntime: runtime,
            cloudRuntimeAgentId:
              runtime === "shared" ? PERSONAL_ID : DEDICATED_ID,
            apiBase: runtime === "shared" ? SHARED_BASE : DEDICATED_BASE,
          });
        }
        expect(calls).toEqual([
          { method: "GET", url: `${CLOUD_BASE}/api/v1/eliza/personal` },
          { method: "GET", url: `${CLOUD_BASE}/api/v1/eliza/personal` },
        ]);
      },
    );

    it("preserves an unavailable existing Dedicated binding without activation or Shared fallback", async () => {
      savePersistedActiveServer({
        kind: "cloud",
        id: `cloud:${PERSONAL_ID}`,
        label: "Eliza",
        apiBase: DEDICATED_BASE,
        cloudRuntime: "dedicated",
        cloudRuntimeAgentId: DEDICATED_ID,
      });
      const prior = loadPersistedActiveServer();
      const calls = transport("dedicated", 503);

      await expect(enter(new ElizaClient())).rejects.toThrow();

      expect(loadPersistedActiveServer()).toEqual(prior);
      expect(calls).toEqual([
        { method: "GET", url: `${CLOUD_BASE}/api/v1/eliza/personal` },
      ]);
    });
  },
);
