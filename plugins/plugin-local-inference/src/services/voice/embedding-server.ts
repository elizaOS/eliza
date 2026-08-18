/**
 * Lazy embedding `llama-server` sidecar for Eliza-1 bundles.
 *
 * The route resolver decides which GGUF backs embeddings. This class owns the
 * process boundary: validate the GGUF at construction, start the sidecar only
 * on first non-empty `embed()`, and return Matryoshka-truncated vectors.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import {
	isValidEmbeddingDim,
	type LocalEmbeddingRoute,
	truncateMatryoshka,
} from "./embedding";
import { VoiceStartupError } from "./errors";

interface EmbeddingServerConfig {
	/** GGUF the sidecar mmaps. For the dedicated-region mode this is the `embedding/` file. */
	modelPath: string;
	/** Extra `llama-server` flags — the route's `embeddingServerFlags` (`--embeddings --pooling last`). */
	serverFlags: ReadonlyArray<string>;
	/** GPU offload: `"auto"` (= all layers) for CPU/Vulkan/CUDA hosts, `0` to force CPU. */
	gpuLayers?: number | "auto";
	/** Thread count for the embedding forward pass. Defaults to the host's logical core count. */
	threads?: number;
}

/** Short liveness budget so startup can keep retrying within its outer deadline. */
export const EMBEDDING_SERVER_HEALTH_TIMEOUT_MS = 2_000;

/** Longer request budget for a local GGUF embedding forward pass. */
export const EMBEDDING_SERVER_EMBED_TIMEOUT_MS = 30_000;

export async function probeEmbeddingServerHealthWithFetch(
	healthUrl: string,
	fetchImpl: typeof fetch,
	timeoutMs: number = EMBEDDING_SERVER_HEALTH_TIMEOUT_MS,
): Promise<boolean> {
	try {
		const response = await fetchImpl(healthUrl, {
			method: "GET",
			signal: AbortSignal.timeout(timeoutMs),
		});
		return response.ok;
	} catch {
		return false;
	}
}

export async function embedWithFetch(
	baseUrl: string,
	texts: string[],
	dim: number,
	fetchImpl: typeof fetch,
	timeoutMs: number = EMBEDDING_SERVER_EMBED_TIMEOUT_MS,
	callerSignal?: AbortSignal,
): Promise<number[][]> {
	const deadline = AbortSignal.timeout(timeoutMs);
	const response = await fetchImpl(`${baseUrl}/v1/embeddings`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ input: texts }),
		signal: callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline,
	});
	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new Error(
			`[embedding-server] /v1/embeddings returned ${response.status}: ${body.slice(0, 200)}`,
		);
	}
	const payload = (await response.json()) as {
		data?: Array<{ embedding?: number[] }>;
	};
	const rows = payload.data ?? [];
	if (rows.length !== texts.length) {
		throw new Error(
			`[embedding-server] expected ${texts.length} embedding rows, got ${rows.length}`,
		);
	}
	return rows.map((row, index) => {
		if (!Array.isArray(row.embedding)) {
			throw new Error(
				`[embedding-server] response row ${index} missing embedding vector`,
			);
		}
		return truncateMatryoshka(row.embedding, dim);
	});
}

export class EmbeddingServer {
	private readonly config: EmbeddingServerConfig;
	private child: ChildProcess | null = null;
	private baseUrl: string | null = null;
	private starting: Promise<void> | null = null;

	constructor(config: EmbeddingServerConfig) {
		if (!existsSync(config.modelPath)) {
			throw new VoiceStartupError(
				"missing-bundle-root",
				`[embedding-server] model GGUF not found at ${config.modelPath}`,
			);
		}
		this.config = config;
	}

	isRunning(): boolean {
		return this.child !== null && this.child.exitCode === null;
	}

	async embed(
		texts: string[],
		dim = 1024,
		signal?: AbortSignal,
	): Promise<number[][]> {
		if (texts.length === 0) return [];
		if (!isValidEmbeddingDim(dim)) {
			throw new Error(`[embedding] dim ${dim} is not a valid Matryoshka width`);
		}
		await this.ensureStarted();
		if (!this.baseUrl) {
			throw new Error("[embedding-server] sidecar started without a base URL");
		}
		return embedWithFetch(
			this.baseUrl,
			texts,
			dim,
			globalThis.fetch,
			EMBEDDING_SERVER_EMBED_TIMEOUT_MS,
			signal,
		);
	}

	private async ensureStarted(): Promise<void> {
		if (this.isRunning()) return;
		this.starting ??= this.start().finally(() => {
			this.starting = null;
		});
		await this.starting;
	}

	private async start(): Promise<void> {
		const port = await reserveTcpPort();
		const binary =
			process.env.ELIZA_LLAMA_SERVER_PATH?.trim() || "llama-server";
		const args = [
			"-m",
			this.config.modelPath,
			...this.config.serverFlags,
			"--host",
			"127.0.0.1",
			"--port",
			String(port),
			"--threads",
			String(this.config.threads ?? Math.max(1, os.cpus().length)),
		];
		if (typeof this.config.gpuLayers === "number") {
			args.push("--n-gpu-layers", String(this.config.gpuLayers));
		}

		const child = spawn(binary, args, {
			stdio: ["ignore", "pipe", "pipe"],
		});
		this.child = child;
		this.baseUrl = `http://127.0.0.1:${port}`;

		child.once("exit", (code, signal) => {
			if (this.child === child) this.child = null;
			if (code !== 0 && code !== null) {
				console.warn(
					`[embedding-server] llama-server exited with code ${code}`,
				);
			} else if (signal) {
				console.warn(`[embedding-server] llama-server exited on ${signal}`);
			}
		});

		await this.waitUntilReady();
	}

	private async waitUntilReady(): Promise<void> {
		const deadline = Date.now() + 20_000;
		while (Date.now() < deadline) {
			if (!this.isRunning()) {
				throw new VoiceStartupError(
					"missing-fused-build",
					"[embedding-server] llama-server exited before /health became ready",
				);
			}
			if (
				await probeEmbeddingServerHealthWithFetch(
					`${this.baseUrl}/health`,
					globalThis.fetch,
				)
			) {
				return;
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		throw new VoiceStartupError(
			"missing-fused-build",
			"[embedding-server] timed out waiting for llama-server /health",
		);
	}

	async stop(): Promise<void> {
		const child = this.child;
		if (!child) return;
		this.child = null;
		await new Promise<void>((resolve) => {
			child.once("exit", () => resolve());
			child.kill("SIGTERM");
			setTimeout(() => {
				if (child.exitCode === null) child.kill("SIGKILL");
				resolve();
			}, 2_000).unref();
		});
	}
}

export function embeddingServerForRoute(
	route: LocalEmbeddingRoute,
	opts: { gpuLayers?: number | "auto"; threads?: number } = {},
): EmbeddingServer {
	const modelPath =
		route.source.kind === "pooled-text"
			? route.source.textModelPath
			: route.source.embeddingModelPath;
	return new EmbeddingServer({
		modelPath,
		serverFlags: route.serverFlags,
		gpuLayers: opts.gpuLayers,
		threads: opts.threads,
	});
}

async function reserveTcpPort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			server.close(() => {
				if (address && typeof address === "object") resolve(address.port);
				else reject(new Error("[embedding-server] failed to reserve TCP port"));
			});
		});
	});
}
