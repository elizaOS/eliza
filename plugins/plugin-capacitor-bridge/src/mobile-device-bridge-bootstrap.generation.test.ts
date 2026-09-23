/** Exercises registered mobile text handlers over real framed sockets with controlled native responses; this is transport evidence, not model or device qualification. */
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { AgentRuntime, ModelType } from "@elizaos/core";
import { expect, it, vi } from "vitest";

function frame(value: object): Buffer {
	const payload = Buffer.from(JSON.stringify(value));
	const bytes = Buffer.alloc(4 + payload.length);
	bytes.writeUInt32BE(payload.length);
	payload.copy(bytes, 4);
	return bytes;
}

it.each([false, true])(
	"preserves native output capacity and incomplete receipts (streaming=%s)",
	async (streaming) => {
		const directory = mkdtempSync(path.join(os.tmpdir(), "mobile-output-"));
		const socketPath = path.join(directory, "host.sock");
		vi.stubEnv("ELIZA_DEVICE_BRIDGE_ENABLED", "1");
		vi.stubEnv("ELIZA_BIONIC_HOST_DELEGATED", "1");
		vi.stubEnv("ELIZA_BIONIC_INFERENCE_SOCK", "test-output-boundary");
		vi.stubEnv("ELIZA_DISABLE_MODEL_AUTO_DOWNLOAD", "1");
		vi.stubEnv("ELIZA_LOCAL_LLAMA", undefined);
		vi.stubEnv("ELIZA_STATE_DIR", directory);
		let response = {
			ok: true,
			text: "Complete native answer",
			tokens: 513,
			incomplete: false,
			finishReason: "stop",
		};
		const requests: Array<Record<string, unknown>> = [];
		const server = net.createServer((socket) => {
			let bytes = Buffer.alloc(0);
			socket.on("data", (chunk) => {
				bytes = Buffer.concat([bytes, chunk]);
				if (bytes.length < 4 || bytes.length < 4 + bytes.readUInt32BE(0))
					return;
				const request: Record<string, unknown> = JSON.parse(
					bytes.subarray(4).toString(),
				);
				requests.push(request);
				if (request.op === "generateStream")
					socket.write(frame({ type: "token", text: response.text }));
				socket.end(
					frame({
						...response,
						...(request.op === "generateStream" ? { type: "done" } : {}),
					}),
				);
			});
		});
		const runtime = new AgentRuntime({ logLevel: "fatal" });
		const realConnect = net.connect;
		try {
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(socketPath, resolve);
			});
			// macOS lacks abstract AF_UNIX sockets. Only translate the address; request
			// framing, stream parsing, registration and output admission remain real.
			vi.spyOn(net, "connect").mockImplementation(() =>
				realConnect({ path: socketPath }),
			);
			const { ensureMobileDeviceBridgeInferenceHandlers } = await import(
				"./mobile-device-bridge-bootstrap"
			);
			expect(await ensureMobileDeviceBridgeInferenceHandlers(runtime)).toBe(
				true,
			);
			const generate = runtime.getModel(
				ModelType.TEXT_SMALL,
				"capacitor-llama",
			);
			if (!generate) throw new Error("Mobile text handler was not registered");
			const prompt = `begin ${"complete context ".repeat(2000)}end`;
			const chunks: string[] = [];
			const params = {
				prompt,
				...(streaming
					? {
							onStreamChunk: (chunk: string) => {
								chunks.push(chunk);
							},
						}
					: {}),
			};
			await expect(generate(runtime, params)).resolves.toBe(response.text);
			expect(requests[0]).not.toHaveProperty("maxTokens");
			expect(requests[0]?.prompt).toContain(prompt);
			expect(requests[0]?.op).toBe(streaming ? "generateStream" : "generate");
			if (streaming) expect(chunks.join("")).toBe(response.text);

			await expect(
				generate(runtime, { ...params, maxTokens: 1024 }),
			).resolves.toBe(response.text);
			expect(requests[1]?.maxTokens).toBe(1024);

			response = {
				...response,
				incomplete: true,
				finishReason: "context_length",
			};
			await expect(generate(runtime, params)).rejects.toMatchObject({
				code: "MODEL_OUTPUT_INCOMPLETE",
				context: {
					maxTokens: null,
					outputTokens: 513,
					finishReason: "context_length",
				},
			});
			expect(requests[2]).not.toHaveProperty("maxTokens");

			response = {
				...response,
				tokens: 32,
				incomplete: false,
				finishReason: "stop",
			};
			await expect(
				generate(runtime, { ...params, maxTokens: 32 }),
			).rejects.toMatchObject({
				code: "MODEL_OUTPUT_INCOMPLETE",
				context: { maxTokens: 32 },
			});
			expect(requests[3]?.maxTokens).toBe(32);
		} finally {
			vi.restoreAllMocks();
			await runtime.stop();
			if (server.listening)
				await new Promise<void>((resolve, reject) =>
					server.close((error) => (error ? reject(error) : resolve())),
				);
			vi.unstubAllEnvs();
			rmSync(directory, { recursive: true, force: true });
		}
	},
);
