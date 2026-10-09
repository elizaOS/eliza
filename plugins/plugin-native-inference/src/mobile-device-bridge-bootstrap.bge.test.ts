/** Exercises BGE suffix and provenance admission over a real authenticated WebSocket with controlled encoder responses. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {
  AgentRuntime,
  BGE_SMALL_VECTOR_SPACE,
  getEmbeddingVectorSpace,
  ModelType,
} from "@elizaos/core";
import { initializeTestRuntime } from "@elizaos/testing/runtime";
import { expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { prepareBgeEmbeddingInput } from "./model-catalog/bge-input.js";

it("preserves the admitted tail and rejects incompatible encoder responses", async () => {
  vi.stubEnv("ELIZA_DEVICE_BRIDGE_ENABLED", "1");
  vi.stubEnv("ELIZA_DEVICE_PAIRING_TOKEN", "bge-admission-test");
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "bge-wire-model-"));
  const modelDir = path.join(stateDir, "local-inference", "models");
  mkdirSync(modelDir, { recursive: true });
  const modelPath = path.join(modelDir, "bge-small-en-v1.5-f16.gguf");
  writeFileSync(
    modelPath,
    "Controlled encoder transport fixture; no native artifact claim",
  );
  vi.stubEnv("ELIZA_STATE_DIR", stateDir);
  vi.stubEnv("ELIZA_LOCAL_MODEL_PATH", path.join(stateDir, "chat.gguf"));
  vi.stubEnv("ELIZA_LOCAL_EMBEDDING_MODEL_PATH", undefined);
  vi.stubEnv("ELIZA_DISABLE_MODEL_AUTO_DOWNLOAD", "1");
  vi.stubEnv("ELIZA_BIONIC_HOST_DELEGATED", undefined);
  vi.stubEnv("ELIZA_LOCAL_LLAMA", undefined);
  const {
    mobileDeviceBridge,
    attachMobileDeviceBridgeToServer,
    mobileDeviceBridgePlugin,
    ensureMobileDeviceBridgeInferenceHandlers,
  } = await import("./mobile-device-bridge-bootstrap");
  const runtime = new AgentRuntime({
    logLevel: "fatal",
    plugins: [mobileDeviceBridgePlugin],
  });
  const server = http.createServer();
  let socket: WebSocket | undefined;
  try {
    await ensureMobileDeviceBridgeInferenceHandlers(runtime);
    await initializeTestRuntime(runtime, { skipMigrations: true });
    await attachMobileDeviceBridgeToServer(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing test address");
    socket = new WebSocket(
      `ws://127.0.0.1:${address.port}/api/local-inference/device-bridge?token=bge-admission-test`,
    );
    await new Promise<void>((resolve, reject) => {
      socket?.once("open", resolve);
      socket?.once("error", reject);
    });
    socket.send(
      JSON.stringify({
        type: "register",
        payload: {
          deviceId: "bge-proof",
          pairingToken: "bge-admission-test",
          loadedPath: null,
          capabilities: {
            platform: "android",
            deviceModel: "wire fixture",
            totalRamGb: 8,
            cpuCores: 8,
            gpu: null,
          },
        },
      }),
    );
    await vi.waitFor(() =>
      expect(mobileDeviceBridge.status().connected).toBe(true),
    );
    const input = `${"old beginning ".repeat(700)}keep the intended search ending`;
    const prepared = prepareBgeEmbeddingInput(input);
    let mode = "valid";
    let requests = 0;
    socket.on("message", (bytes) => {
      const request = JSON.parse(bytes.toString());
      if (request.type === "load") {
        expect(request.modelPath).toBe(modelPath);
        expect(request.contextSize).toBe(512);
        socket?.send(
          JSON.stringify({
            type: "loadResult",
            correlationId: request.correlationId,
            ok: true,
            loadedPath: request.modelPath,
          }),
        );
        return;
      }
      if (request.type !== "embed") return;
      requests++;
      expect(request.input).toBe(prepared.text);
      expect(request.expectedTokenIds).toEqual(prepared.tokenIds);
      expect(request.embeddingSpace).toBe(BGE_SMALL_VECTOR_SPACE);
      const ids = [...prepared.tokenIds];
      if (mode === "tokens") ids[1] = ids[1] === 100 ? 101 : 100;
      socket?.send(
        JSON.stringify({
          type: "embedResult",
          correlationId: request.correlationId,
          ok: true,
          embedding: [1, ...Array(383).fill(0)],
          tokens: ids.length,
          tokenIds: ids,
          embeddingSpace:
            mode === "space" ? "legacy:384" : BGE_SMALL_VECTOR_SPACE,
        }),
      );
    });
    const [vector, concurrent] = await Promise.all([
      runtime.useModel(ModelType.TEXT_EMBEDDING, { text: input }),
      runtime.useModel(ModelType.TEXT_EMBEDDING, { text: input }),
    ]);
    expect(concurrent).toEqual(vector);
    expect(input.endsWith(prepared.text)).toBe(true);
    expect(prepared.text.length).toBeLessThan(input.length);
    expect(getEmbeddingVectorSpace(vector)).toBe(BGE_SMALL_VECTOR_SPACE);
    mode = "tokens";
    await expect(mobileDeviceBridge.embed({ input })).rejects.toMatchObject({
      code: "EMBEDDING_TOKENIZER_MISMATCH",
    });
    mode = "space";
    await expect(mobileDeviceBridge.embed({ input })).rejects.toMatchObject({
      code: "EMBEDDING_VECTOR_INVALID",
    });
    await expect(
      mobileDeviceBridge.embed({ input: "invalid\ud800" }),
    ).rejects.toMatchObject({ code: "EMBEDDING_INPUT_INVALID" });
    expect(requests).toBe(4);
  } finally {
    await runtime.stop();
    socket?.terminate();
    await mobileDeviceBridge.close();
    if (server.listening)
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    rmSync(stateDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  }
});

it("honors host-disabled local embeddings at registration and for retained handlers", async () => {
  vi.stubEnv("ELIZA_DEVICE_BRIDGE_ENABLED", "1");
  vi.stubEnv("ELIZA_LOCAL_LLAMA", undefined);
  vi.stubEnv("ELIZA_BIONIC_HOST_DELEGATED", "1");
  vi.stubEnv(
    "ELIZA_BIONIC_INFERENCE_SOCK",
    "forbidden-embedding-policy-fixture",
  );
  vi.stubEnv("ELIZA_DISABLE_MODEL_AUTO_DOWNLOAD", "1");
  const { ensureMobileDeviceBridgeInferenceHandlers } = await import(
    "./mobile-device-bridge-bootstrap"
  );
  const disabled = new AgentRuntime({ logLevel: "fatal" }),
    enabled = new AgentRuntime({ logLevel: "fatal" });
  try {
    vi.stubEnv("ELIZA_DISABLE_LOCAL_EMBEDDINGS", "true");
    await ensureMobileDeviceBridgeInferenceHandlers(disabled);
    expect(disabled.getModel(ModelType.TEXT_EMBEDDING)).toBeUndefined();
    expect(disabled.getModel(ModelType.TEXT_SMALL)).toBeTypeOf("function");
    vi.stubEnv("ELIZA_DISABLE_LOCAL_EMBEDDINGS", undefined);
    await ensureMobileDeviceBridgeInferenceHandlers(enabled);
    const handler = enabled.getModel(ModelType.TEXT_EMBEDDING);
    expect(handler).toBeTypeOf("function");
    if (!handler) throw Error("Missing registered native handler");
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const dimension = vi
      .spyOn(enabled, "ensureEmbeddingDimension")
      .mockImplementation(() => pending);
    const admitted = handler(enabled, { text: "Synthetic admission race" });
    vi.stubEnv("ELIZA_DISABLE_LOCAL_EMBEDDINGS", "true");
    release();
    await expect(admitted).rejects.toMatchObject({
      code: "LOCAL_EMBEDDING_DISABLED",
    });
    dimension.mockRestore();
    for (const flag of ["true", "1", "yes"]) {
      vi.stubEnv("ELIZA_DISABLE_LOCAL_EMBEDDINGS", flag);
      // No model path or working UDS exists: the policy must win before either is accessed.
      await expect(
        handler(enabled, { text: "Synthetic policy check" }),
      ).rejects.toMatchObject({ code: "LOCAL_EMBEDDING_DISABLED" });
      await expect(
        Reflect.apply(handler, undefined, [enabled, null]),
      ).rejects.toMatchObject({
        code: "LOCAL_EMBEDDING_DISABLED",
      });
    }
  } finally {
    await disabled.stop();
    await enabled.stop();
    await disabled.close();
    await enabled.close();
    vi.unstubAllEnvs();
  }
});
