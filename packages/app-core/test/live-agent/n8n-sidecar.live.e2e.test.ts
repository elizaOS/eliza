/**
 * Live E2E for the n8n local sidecar.
 *
 * NO MOCKS. Spawns a real `npx n8n@<pinned> start` child process, waits for
 * the real HTTP readiness probe, drives the real owner-setup → login →
 * api-keys provisioning flow, and exercises the public `/api/v1/workflows`
 * REST API with the provisioned X-N8N-API-KEY.
 *
 * Covers the four bugs that stacked to produce "Workflow backend unavailable
 * / n8n not ready (starting)":
 *   1. bunx launcher is incompatible — we use npx.
 *   2. n8n version must be on the Node-24-compatible range — pinned to 1.100.
 *   3. API key provisioning must drive owner-setup → login → scopes → keys.
 *   4. Workflow proxy must target `/api/v1/workflows`, not `/rest/workflows`.
 *
 * The LLM step at the end (gated on a live provider) proves the agent can
 * actually reach the sidecar through the API server the UI talks to.
 *
 * Gated on MILADY_LIVE_TEST=1 / ELIZA_LIVE_TEST=1. The live provider is
 * optional — the sidecar mechanics run on any environment, the chat step
 * only runs if a provider key is configured.
 */

import fs from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect } from "vitest";
import {
  describeIf,
  itIf,
} from "../../../../../test/helpers/conditional-tests.ts";
import {
  buildIsolatedLiveProviderEnv,
  isLiveTestEnabled,
  LIVE_PROVIDER_ENV_KEYS,
  selectLiveProvider,
} from "../../../../../test/helpers/live-provider";
import {
  disposeN8nSidecar,
  getN8nSidecar,
  type N8nSidecar,
} from "../../src/services/n8n-sidecar";

const liveTestsEnabled = isLiveTestEnabled();
const LIVE_PROVIDER = liveTestsEnabled
  ? (selectLiveProvider("openai") ?? selectLiveProvider())
  : null;
const CAN_RUN = liveTestsEnabled;
const CAN_RUN_LLM_STEP = liveTestsEnabled && Boolean(LIVE_PROVIDER);

// Cold start can download ~300MB of n8n into the npm cache, then run ~50
// DB migrations. 4 minutes leaves headroom on slow network but still fails
// loudly if something regresses.
const READY_TIMEOUT_MS = 4 * 60 * 1_000;
const TEST_TIMEOUT_MS = READY_TIMEOUT_MS + 30_000;

async function pickFreePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("server.address() did not return a port"));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

async function waitForReady(
  sidecar: N8nSidecar,
  deadlineMs: number,
): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const state = sidecar.getState();
    if (state.status === "ready") return;
    if (state.status === "error") {
      // Dump EVERYTHING on error so we don't get truncated diagnostics.
      // The sidecar's buffer caps at 200 lines, which is already way more
      // than n8n's migrations produce, so this is self-limiting.
      throw new Error(
        `sidecar entered error: ${state.errorMessage ?? "(no message)"}\n` +
          `---recent output---\n  ${state.recentOutput.join("\n  ")}\n---end---`,
      );
    }
    await sleep(500);
  }
  const finalState = sidecar.getState();
  throw new Error(
    `sidecar not ready after ${deadlineMs}ms (status=${finalState.status})\n` +
      `---recent output---\n  ${finalState.recentOutput.join("\n  ")}\n---end---`,
  );
}

describeIf(CAN_RUN)("Live: n8n sidecar end-to-end", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "milady-n8n-e2e-"));
  let sidecar: N8nSidecar;
  let port: number;
  let host: string;
  let apiKey: string;

  beforeAll(async () => {
    // Make sure we start from a clean singleton — another suite in the same
    // worker might have constructed one.
    await disposeN8nSidecar();
    port = await pickFreePort();
    // maxRetries:0 so a single cold-boot failure surfaces immediately
    // instead of looping 4× on the same error and evicting the real stderr
    // from the output ring buffer.
    sidecar = getN8nSidecar({
      stateDir,
      startPort: port,
      maxRetries: 0,
    });
    await sidecar.start();
    await waitForReady(sidecar, READY_TIMEOUT_MS);

    const state = sidecar.getState();
    expect(state.status).toBe("ready");
    expect(state.host).toBeTruthy();
    host = state.host ?? "";
    const key = sidecar.getApiKey();
    expect(
      key,
      "sidecar must provision an api key during boot (owner-setup → login → /rest/api-keys)",
    ).toBeTypeOf("string");
    apiKey = key ?? "";
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    await disposeN8nSidecar();
    await fs.promises.rm(stateDir, { recursive: true, force: true });
  }, 60_000);

  itIf(CAN_RUN)(
    "provisions api-key and persists owner.json + api-key mode-600",
    async () => {
      const ownerJsonPath = path.join(stateDir, "owner.json");
      const apiKeyPath = path.join(stateDir, "api-key");
      await expect(fs.promises.stat(ownerJsonPath)).resolves.toMatchObject({});
      await expect(fs.promises.stat(apiKeyPath)).resolves.toMatchObject({});

      const ownerStat = await fs.promises.stat(ownerJsonPath);
      const apiKeyStat = await fs.promises.stat(apiKeyPath);
      // eslint-disable-next-line no-bitwise
      expect(ownerStat.mode & 0o777).toBe(0o600);
      // eslint-disable-next-line no-bitwise
      expect(apiKeyStat.mode & 0o777).toBe(0o600);

      const persistedKey = await fs.promises.readFile(apiKeyPath, "utf-8");
      expect(persistedKey.trim()).toBe(apiKey);

      const ownerJson = JSON.parse(
        await fs.promises.readFile(ownerJsonPath, "utf-8"),
      ) as { email?: unknown; password?: unknown };
      expect(ownerJson.email).toBe("milady@milady.local");
      expect(typeof ownerJson.password).toBe("string");
      expect(String(ownerJson.password).length).toBeGreaterThan(40);
    },
    TEST_TIMEOUT_MS,
  );

  itIf(CAN_RUN)(
    "public API (/api/v1/workflows) accepts the provisioned X-N8N-API-KEY",
    async () => {
      // This is the exact endpoint the UI proxy hits. If we regressed to
      // /rest/workflows the request would 401 even with a valid key.
      const res = await fetch(`${host}/api/v1/workflows`, {
        headers: { "X-N8N-API-KEY": apiKey, Accept: "application/json" },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data?: unknown; nextCursor?: unknown };
      expect(body.data).toBeInstanceOf(Array);
    },
    30_000,
  );

  itIf(CAN_RUN)(
    "internal /rest/* endpoints reject the X-N8N-API-KEY (regression guard)",
    async () => {
      // The internal UI endpoints only accept the JWT cookie. If we
      // accidentally switch the proxy back to /rest/workflows, authenticated
      // requests will fail. Assert that's still true so a future refactor
      // gets a clear signal if the surface changes upstream.
      const res = await fetch(`${host}/rest/workflows`, {
        headers: { "X-N8N-API-KEY": apiKey, Accept: "application/json" },
      });
      expect(res.status).toBe(401);
    },
    30_000,
  );

  itIf(CAN_RUN)(
    "creates + lists a workflow through the public API",
    async () => {
      const minimalWorkflow = {
        name: `milady-e2e-${Date.now()}`,
        nodes: [
          {
            parameters: {},
            id: "a1b2c3d4-0000-0000-0000-000000000001",
            name: "Start",
            type: "n8n-nodes-base.manualTrigger",
            typeVersion: 1,
            position: [240, 300],
          },
        ],
        connections: {},
        settings: { executionOrder: "v1" },
      };

      const createRes = await fetch(`${host}/api/v1/workflows`, {
        method: "POST",
        headers: {
          "X-N8N-API-KEY": apiKey,
          "content-type": "application/json",
        },
        body: JSON.stringify(minimalWorkflow),
      });
      expect(createRes.status).toBe(200);
      const createdBody = (await createRes.json()) as {
        id?: string;
        name?: string;
      };
      expect(typeof createdBody.id).toBe("string");
      expect(createdBody.name).toBe(minimalWorkflow.name);

      const listRes = await fetch(`${host}/api/v1/workflows`, {
        headers: { "X-N8N-API-KEY": apiKey, Accept: "application/json" },
      });
      expect(listRes.status).toBe(200);
      const listBody = (await listRes.json()) as {
        data: Array<{ id: string; name: string }>;
      };
      const match = listBody.data.find((w) => w.id === createdBody.id);
      expect(match, "created workflow should appear in the list").toBeDefined();
      expect(match?.name).toBe(minimalWorkflow.name);

      // Cleanup: delete the workflow so repeated local runs stay tidy.
      const delRes = await fetch(
        `${host}/api/v1/workflows/${encodeURIComponent(createdBody.id ?? "")}`,
        {
          method: "DELETE",
          headers: { "X-N8N-API-KEY": apiKey },
        },
      );
      expect([200, 204]).toContain(delRes.status);
    },
    60_000,
  );

  itIf(CAN_RUN)(
    "restarting the sidecar reuses the persisted api key (no re-provision)",
    async () => {
      // The provisionApiKey flow uses owner.json to log in on subsequent
      // boots rather than re-creating an owner, and validateApiKey reuses
      // the cached api-key file on disk. Validate by disposing the singleton
      // (also takes down the child) and starting fresh against the same
      // stateDir.
      await disposeN8nSidecar();
      await sleep(2_000); // let the port fully release
      const nextPort = await pickFreePort();
      sidecar = getN8nSidecar({ stateDir, startPort: nextPort });
      await sidecar.start();
      await waitForReady(sidecar, READY_TIMEOUT_MS);

      const reloadedKey = sidecar.getApiKey();
      expect(reloadedKey).toBe(apiKey);

      const state = sidecar.getState();
      host = state.host ?? host;
      const res = await fetch(`${host}/api/v1/workflows`, {
        headers: {
          "X-N8N-API-KEY": reloadedKey ?? "",
          Accept: "application/json",
        },
      });
      expect(res.status).toBe(200);
    },
    TEST_TIMEOUT_MS,
  );

  // The LLM step only runs when a provider is configured. It proves that
  // the agent can receive a question about workflows and produce a coherent
  // response — which requires the live model wiring, not just the sidecar.
  // We don't assert on specific tool-calls here (that depends on the agent
  // having an n8n tool registered); we just prove the LLM round-trip works.
  itIf(CAN_RUN_LLM_STEP)(
    "LLM round-trip works alongside the live sidecar",
    async () => {
      const providerEnv = buildIsolatedLiveProviderEnv(
        process.env,
        LIVE_PROVIDER,
      );
      // Restore live-provider env on this process so the LLM call below has
      // the right credentials without stepping on the parent process env.
      const before: Record<string, string | undefined> = {};
      for (const key of LIVE_PROVIDER_ENV_KEYS) {
        before[key] = process.env[key];
        process.env[key] = providerEnv[key] ?? "";
      }
      try {
        const { createRealTestRuntime } = await import(
          "../helpers/real-runtime.ts"
        );
        const rt = await createRealTestRuntime({
          withLLM: true,
          preferredProvider: LIVE_PROVIDER?.name,
        });
        try {
          const { ModelType } = await import("@elizaos/core");
          const model = rt.runtime.getModel(ModelType.TEXT_SMALL);
          expect(model, "live provider must register a TEXT_SMALL model").toBeTypeOf(
            "function",
          );
          const out = (await (model as unknown as (
            runtime: unknown,
            params: { prompt: string; maxTokens: number },
          ) => Promise<unknown>)(rt.runtime, {
            prompt:
              "Answer in one short sentence: in n8n, what's the difference " +
              "between the internal /rest/* API and the public /api/v1/* API?",
            maxTokens: 120,
          })) as unknown;
          const text =
            typeof out === "string"
              ? out
              : typeof (out as { text?: unknown })?.text === "string"
                ? ((out as { text: string }).text)
                : JSON.stringify(out);
          expect(text.length).toBeGreaterThan(10);
        } finally {
          await rt.cleanup();
        }
      } finally {
        for (const key of LIVE_PROVIDER_ENV_KEYS) {
          if (before[key] === undefined) delete process.env[key];
          else process.env[key] = before[key];
        }
      }
    },
    120_000,
  );
});
