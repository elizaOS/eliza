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
import { prepareBgeEmbeddingInput } from "@elizaos/shared/local-inference/bge-input";
import { initializeTestRuntime } from "@elizaos/testing/in-memory-adapter";
import { expect, it, vi } from "vitest";
import { WebSocket } from "ws";

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
