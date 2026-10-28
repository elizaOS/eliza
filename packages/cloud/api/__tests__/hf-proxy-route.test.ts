/**
 * The HF proxy charges the org's monthly egress bucket for the bytes it sends.
 * The upstream Content-Length is reserved up front; the part that is not sent
 * must come back when the client cancels or the upstream fails, or every
 * cancelled and resumed download is charged as a full file.
 */
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import {
  createHfProxyEgressQuotaStore,
  resetHfProxyEgressQuotaForTests,
} from "@elizaos/cloud-shared/lib/services/hf-proxy-egress-quota";
import { Hono } from "hono";
import { ELIZA_1_HF_REPO } from "../../../../plugins/plugin-native-inference/src/model-catalog/catalog";
import * as generativeRouteAuth from "../src/lib/generative-route-auth";

mock.module("@/api-app/lib/generative-route-auth", () => ({
  ...generativeRouteAuth,
  requireGenerativeRouteCaller: async () => ({
    user: { id: "user-1", organization_id: "org-1" },
    apiKeyId: null,
    admissionSnapshot: null,
    credential: undefined,
  }),
}));

const { default: hfProxyApp, ALLOWED_REPO_PREFIX } = await import(
  "../v1/hf-proxy/[...path]/route"
);

// Mounted the way the generated router mounts it, so the catch-all param resolves.
const app = new Hono().route("/api/v1/hf-proxy/:*{.+}", hfProxyApp);

const MiB = 1024 * 1024;
const CHUNKS = 8;
const env = { HF_TOKEN: "hf_test", MOCK_REDIS: "1" };
const realFetch = globalThis.fetch;

beforeEach(() => resetHfProxyEgressQuotaForTests());
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** An upstream GGUF of CHUNKS MiB; `failAfter` errors the body after that many chunks. */
function stubUpstream(failAfter?: number): void {
  globalThis.fetch = (async (_input: Parameters<typeof fetch>[0]) => {
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent === failAfter) {
          controller.error(new Error("upstream connection reset"));
          return;
        }
        if (sent === CHUNKS) {
          controller.close();
          return;
        }
        sent += 1;
        controller.enqueue(new Uint8Array(MiB));
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "content-length": String(CHUNKS * MiB) },
    });
  }) as typeof fetch;
}

async function chargedBytes(): Promise<number> {
  const store = createHfProxyEgressQuotaStore(env);
  if (!store) throw new Error("quota store unavailable");
  const now = new Date();
  const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const probe = await store.reserve("org-1", month, 1, Number.MAX_SAFE_INTEGER);
  await store.release("org-1", month, 1);
  return probe.usedBytes - 1;
}

async function download(): Promise<Response> {
  return await app.request(
    `/api/v1/hf-proxy/${ELIZA_1_HF_REPO}/resolve/main/model.gguf`,
    {},
    env,
  );
}

test("the proxied repo is the curated eliza-1 org", () => {
  expect(ELIZA_1_HF_REPO.startsWith(ALLOWED_REPO_PREFIX)).toBe(true);
});

test("a complete download is charged its full size", async () => {
  stubUpstream();
  const response = await download();
  expect(response.status).toBe(200);
  expect((await response.arrayBuffer()).byteLength).toBe(CHUNKS * MiB);
  expect(await chargedBytes()).toBe(CHUNKS * MiB);
});

test("a download the client cancels is charged only the bytes sent", async () => {
  stubUpstream();
  const response = await download();
  const reader = response.body!.getReader();
  const first = await reader.read();
  expect(first.value?.byteLength).toBe(MiB);
  await reader.cancel("client disconnected");

  expect(await chargedBytes()).toBeLessThanOrEqual(2 * MiB);
});

test("a download the upstream cuts off is charged only the bytes sent", async () => {
  stubUpstream(1);
  const response = await download();
  await expect(response.arrayBuffer()).rejects.toThrow(
    "upstream connection reset",
  );

  expect(await chargedBytes()).toBe(MiB);
});

test("selected Cloudflare quota without its binding refuses the download before upstream I/O", async () => {
  let calls = 0;
  globalThis.fetch = (async (
    _input: Parameters<typeof fetch>[0],
  ): Promise<Response> => {
    calls += 1;
    throw new Error("Upstream must not be reached without quota ownership");
  }) as typeof fetch;
  const response = await app.request(
    `/api/v1/hf-proxy/${ELIZA_1_HF_REPO}/resolve/main/model.gguf`,
    {},
    { ...env, CLOUD_HF_EGRESS_BACKEND: "cloudflare" },
  );
  expect(response.status).toBe(503);
  expect(calls).toBe(0);
});
