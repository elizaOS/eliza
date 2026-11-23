/** Actual image handler and Cloud SDK over local HTTP; no external inference or billing. */
import { createServer } from "node:http";
import type { IAgentRuntime } from "@elizaos/core";
import { expect, test } from "vitest";
import { applyNativeCloudRuntimeProfile } from "../../../packages/app/src/runtime/native-runtime-profile";
import { resolveElizaCloudTopology } from "../../../packages/host/src/contracts/cloud-topology";
import { registerCloudMediaModels } from "../src/index";
import { handleImageDescription } from "../src/models/image";

test("native image funding retains one operation across retries and preserves prepaid and failure boundaries", async () => {
  const requests: { operation: string | undefined; slot: string | undefined; body: string }[] = [];
  let mode = "success";
  let cancellation: AbortController | undefined;
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({
      operation: request.headers["idempotency-key"] as string | undefined,
      slot: request.headers["x-eliza-application-slot"] as string | undefined,
      body,
    });
    response.setHeader("Content-Type", "application/json");
    if ((mode === "warming" || mode === "cancel-warming") && requests.length === 1) {
      response.writeHead(503);
      response.end(JSON.stringify({ error: { type: "service_unavailable", retryAfter: 0.01 } }));
      if (mode === "cancel-warming") setTimeout(() => cancellation?.abort(), 0);
    } else if (mode === "failure") {
      response.writeHead(400);
      response.end(JSON.stringify({ error: { type: "invalid_request_error" } }));
    } else
      response.end(
        JSON.stringify({
          choices: [{ message: { content: "A green square" }, finish_reason: "stop" }],
        })
      );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("Expected local HTTP listener");
  const runtime = (native: boolean): IAgentRuntime => {
    const settings: Record<string, string> = {
      ELIZAOS_CLOUD_API_KEY: "eliza_controlled_image",
      ELIZAOS_CLOUD_BASE_URL: `http://127.0.0.1:${address.port}/api/v1`,
      ELIZAOS_CLOUD_IMAGE_DESCRIPTION_MODEL: "cerebras/qwen-3.8-27b",
      ...(native ? { ELIZAOS_CLOUD_APPLICATION_SLOT: "fixture-product" } : {}),
    };
    return {
      getSetting: (key: string) => settings[key],
      emitEvent: async () => {},
    } as unknown as IAgentRuntime;
  };
  const input = { imageUrl: "data:image/png;base64,AA==", prompt: "Describe the synthetic image" };
  try {
    // Exercise the boot route and actual plugin registry before the handler.
    // The old native profile left media disabled, so this delegate did not exist.
    let config: Record<string, unknown> = {};
    await applyNativeCloudRuntimeProfile(
      {
        ELIZA_RUNTIME_PROFILE: "cloud",
        ELIZAOS_CLOUD_BASE_URL: "https://cloud.example.com/api/v1",
        ELIZAOS_CLOUD_SMALL_MODEL: "cerebras/qwen-3.8-27b",
        ELIZAOS_CLOUD_LARGE_MODEL: "cerebras/qwen-3.8-27b",
      },
      { apiBaseUrl: "https://cloud.example.com/api/v1" },
      {
        loadConfig: () => config,
        saveConfig: (next) => {
          config = next;
        },
        updateRoutingPreferences: async () => {},
      }
    );
    const registered = new Map<string, typeof handleImageDescription>();
    let imageProvider: string | undefined;
    const selectedRuntime = runtime(true);
    const readSetting = selectedRuntime.getSetting.bind(selectedRuntime);
    selectedRuntime.getSetting = (key: string) =>
      key === "ELIZAOS_CLOUD_USE_MEDIA"
        ? String(resolveElizaCloudTopology(config).services.media)
        : readSetting(key);
    selectedRuntime.registerModel = ((
      model: string,
      handler: typeof handleImageDescription,
      provider: string
    ) => {
      if (model === "IMAGE_DESCRIPTION") imageProvider = provider;
      registered.set(model, handler);
    }) as IAgentRuntime["registerModel"];
    registerCloudMediaModels(selectedRuntime);
    const describe = registered.get("IMAGE_DESCRIPTION");
    expect(describe).toBe(handleImageDescription);
    expect(imageProvider).toBe("elizaOSCloud");
    if (!describe) throw Error("Cloud image delegate missing after native boot");
    expect((await describe(selectedRuntime, input)).description).toBe("A green square");
    expect(requests).toHaveLength(1);
    requests.length = 0;
    mode = "cancel-warming";
    cancellation = new AbortController();
    await expect(
      handleImageDescription(runtime(true), { ...input, signal: cancellation.signal })
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(requests).toHaveLength(1);
    expect(requests[0].operation).toMatch(/^native:/);
    expect(requests[0].slot).toBe("fixture-product");
    requests.length = 0;
    mode = "warming";
    await handleImageDescription(runtime(true), input);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    requests.length = 0;
    mode = "success";
    await handleImageDescription(runtime(false), input);
    expect(requests).toHaveLength(1);
    expect(requests[0].operation).toBeUndefined();
    expect(requests[0].slot).toBeUndefined();
    requests.length = 0;
    mode = "failure";
    await expect(handleImageDescription(runtime(true), input)).rejects.toMatchObject({
      code: "MODEL_FUNDING_AUTHORITY_FAILED",
      cause: { status: 400 },
    });
    expect(requests).toHaveLength(1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
});
