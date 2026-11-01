/** Exercises diagnostic modes through the existing Hono shell without providers. */
import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
import { createInferenceApp } from "./inference-app";
import { prepareInferenceEntryRequest } from "./inference-entry-timing";

const path = "/api/v1/voice/stt";
const audit = spyOn(logger, "audit").mockImplementation(() => {});
afterEach(() => audit.mockClear());
afterAll(() => audit.mockRestore());
const bindings = (environment: string) =>
  ({
    ENVIRONMENT: environment,
    NODE_ENV: "test",
    CACHE_ENABLED: "false",
    DATABASE_URL: "postgres://test.invalid/eliza",
    BLOB: {},
    GLOBAL_RATE_LIMITER: { limit: async () => ({ success: true }) },
  }) as AppEnv["Bindings"];
const phases = () =>
  audit.mock.calls
    .filter((call) => call[0] === "[InferenceEntry] phase timing")
    .map((call) => (call[1] as { phase: string }).phase);

test.each(["staging", "production"])(
  "%s shell preserves streaming bytes and only staging emits phases",
  async (environment) => {
    const bytes = new Uint8Array([0, 10, 128, 255]);
    const route = new Hono<AppEnv>();
    route.post(
      "/",
      async (c) =>
        new Response(await c.req.arrayBuffer(), {
          headers: { "content-type": "application/octet-stream" },
        }),
    );
    const request = new Request(`https://api-staging.eliza.app${path}`, {
      method: "POST",
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes.subarray(0, 2));
          controller.enqueue(bytes.subarray(2));
          controller.close();
        },
      }),
      headers: { "content-type": "application/octet-stream" },
    });
    const prepared = prepareInferenceEntryRequest(request, environment);
    if (environment === "production") expect(prepared).toBe(request);
    const response = await createInferenceApp(path, route).fetch(
      prepared,
      bindings(environment),
    );
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(phases()).toEqual(
      environment === "staging"
        ? ["ingress_enter", "ingress_decision", "route_enter"]
        : [],
    );
  },
);

test.each(["staging", "production"])(
  "%s shell retains caller abort during route work",
  async (environment) => {
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const route = new Hono<AppEnv>();
    route.post("/", async (c) => {
      enter();
      await new Promise<void>((resolve) => {
        if (c.req.raw.signal.aborted) resolve();
        else
          c.req.raw.signal.addEventListener("abort", () => resolve(), {
            once: true,
          });
      });
      return c.json({ aborted: c.req.raw.signal.aborted });
    });
    const controller = new AbortController();
    const request = new Request(`https://api-staging.eliza.app${path}`, {
      method: "POST",
      signal: controller.signal,
    });
    const response = createInferenceApp(path, route).fetch(
      prepareInferenceEntryRequest(request, environment),
      bindings(environment),
    );
    await entered;
    controller.abort();
    expect(await (await response).json()).toEqual({ aborted: true });
    if (environment === "production") expect(phases()).toEqual([]);
  },
);

test.each(["staging", "production"])(
  "%s denial still stops before route entry",
  async (environment) => {
    let routeCalls = 0;
    const route = new Hono<AppEnv>();
    route.post("/", (c) => {
      routeCalls++;
      return c.json({ ok: true });
    });
    const env = bindings(environment);
    env.GLOBAL_RATE_LIMITER = { limit: async () => ({ success: false }) };
    const request = new Request(`https://api-staging.eliza.app${path}`, {
      method: "POST",
    });
    const response = await createInferenceApp(path, route).fetch(
      prepareInferenceEntryRequest(request, environment),
      env,
    );
    expect(response.status).toBe(429);
    expect(routeCalls).toBe(0);
    expect(phases()).toEqual(
      environment === "staging" ? ["ingress_enter", "ingress_decision"] : [],
    );
  },
);
