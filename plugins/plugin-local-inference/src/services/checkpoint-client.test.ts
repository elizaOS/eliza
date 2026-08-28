import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CheckpointClient, CheckpointHttpError } from "./checkpoint-client";

type FetchCall = {
	url: string;
	init?: { method?: string; signal?: AbortSignal };
};

function makeFakeFetch(overrides: {
	ok?: boolean;
	status?: number;
	statusText?: string;
	body?: string;
	hang?: boolean;
}) {
	const calls: FetchCall[] = [];
	const impl = async (
		input: string,
		init?: { method?: string; signal?: AbortSignal },
	) => {
		calls.push({ url: input, init });
		const signal = init?.signal;
		if (signal) {
			if (signal.aborted) {
				throw new DOMException("The operation was aborted.", "AbortError");
			}
			await new Promise<void>((resolve, reject) => {
				signal.addEventListener("abort", () =>
					reject(new DOMException("The operation was aborted.", "AbortError")),
				);
				if (!overrides.hang) resolve();
			});
		}
		return {
			ok: overrides.ok ?? true,
			status: overrides.status ?? 200,
			statusText: overrides.statusText ?? "OK",
			text: async () => overrides.body ?? "",
		};
	};
	return { impl, calls };
}

describe("CheckpointClient name validation (save path)", () => {
	const client = () =>
		new CheckpointClient({
			baseUrl: "http://llama:8080/",
			fetchImpl: makeFakeFetch({}).impl,
		});

	it("accepts a well-formed checkpoint name", async () => {
		const { impl, calls } = makeFakeFetch({});
		const c = new CheckpointClient({
			baseUrl: "http://llama:8080/",
			fetchImpl: impl,
		});
		const handle = await c.saveCheckpoint(0, "model-slot-1.ckpt");
		expect(handle.slotId).toBe(0);
		expect(handle.filename).toBe("model-slot-1.ckpt");
		expect(typeof handle.createdAt).toBe("string");
		expect(calls[0].url).toBe(
			"http://llama:8080/slots/0/save?filename=model-slot-1.ckpt",
		);
	});

	it("rejects an empty name", async () => {
		await expect(client().saveCheckpoint(0, "")).rejects.toThrow(TypeError);
	});

	it("rejects a name longer than 128 chars", async () => {
		await expect(client().saveCheckpoint(0, "a".repeat(129))).rejects.toThrow(
			TypeError,
		);
	});

	it("rejects names containing a path separator", async () => {
		await expect(client().saveCheckpoint(0, "a/b")).rejects.toThrow(TypeError);
		await expect(client().saveCheckpoint(0, "a\\b")).rejects.toThrow(TypeError);
	});

	it("rejects the bare dot-directory names that would escape the save dir", async () => {
		// "." and ".." pass the character allowlist but resolve to the save
		// directory itself and its parent — the server would target a
		// directory entry instead of a checkpoint file.
		await expect(client().saveCheckpoint(0, ".")).rejects.toThrow(TypeError);
		await expect(client().saveCheckpoint(0, "..")).rejects.toThrow(TypeError);
	});

	it("rejects all-dot names of any length", async () => {
		await expect(client().saveCheckpoint(0, "...")).rejects.toThrow(TypeError);
		await expect(client().saveCheckpoint(0, ".".repeat(20))).rejects.toThrow(
			TypeError,
		);
	});

	it("rejects a non-string name", async () => {
		await expect(
			client().saveCheckpoint(0, 42 as unknown as string),
		).rejects.toThrow(TypeError);
	});

	it("applies the same validation on restore and cancel paths", async () => {
		const c = client();
		await expect(c.restoreCheckpoint(1, "..")).rejects.toThrow(TypeError);
		await expect(c.restoreCheckpoint(1, "ok.ckpt")).resolves.toBeUndefined();
		await expect(c.cancelSlot(1)).resolves.toBeUndefined();
	});
});

describe("CheckpointClient slotId validation", () => {
	const client = () =>
		new CheckpointClient({
			baseUrl: "http://llama:8080/",
			fetchImpl: makeFakeFetch({}).impl,
		});

	it("rejects negative, fractional, and NaN slot ids", async () => {
		await expect(client().saveCheckpoint(-1, "a.ckpt")).rejects.toThrow(
			TypeError,
		);
		await expect(client().saveCheckpoint(1.5, "a.ckpt")).rejects.toThrow(
			TypeError,
		);
		await expect(client().saveCheckpoint(Number.NaN, "a.ckpt")).rejects.toThrow(
			TypeError,
		);
	});

	it("accepts slot 0", async () => {
		await expect(client().saveCheckpoint(0, "a.ckpt")).resolves.toMatchObject({
			slotId: 0,
		});
	});
});

describe("CheckpointClient request behavior", () => {
	it("strips a trailing slash from baseUrl", async () => {
		const { impl, calls } = makeFakeFetch({});
		const c = new CheckpointClient({
			baseUrl: "http://llama:8080///",
			fetchImpl: impl,
		});
		await c.probeSupported();
		expect(calls[0].url).toBe("http://llama:8080/health");
	});

	it("throws CheckpointHttpError with status and body on non-ok response", async () => {
		const { impl } = makeFakeFetch({
			ok: false,
			status: 404,
			statusText: "Not Found",
			body: "no such checkpoint",
		});
		const c = new CheckpointClient({
			baseUrl: "http://llama:8080/",
			fetchImpl: impl,
		});
		const err = await c.restoreCheckpoint(1, "missing.ckpt").catch((e) => e);
		expect(err).toBeInstanceOf(CheckpointHttpError);
		expect((err as CheckpointHttpError).status).toBe(404);
		expect((err as CheckpointHttpError).responseBody).toBe(
			"no such checkpoint",
		);
	});

	it("aborts the request when the per-call timeout elapses", async () => {
		const { impl, calls } = makeFakeFetch({ hang: true });
		const c = new CheckpointClient({
			baseUrl: "http://llama:8080/",
			fetchImpl: impl,
			requestTimeoutMs: 50,
		});
		const started = Date.now();
		await expect(c.saveCheckpoint(1, "a.ckpt")).rejects.toThrow();
		expect(Date.now() - started).toBeGreaterThanOrEqual(40);
		expect(calls[0].init?.signal?.aborted).toBe(true);
	});

	it("treats a caller-provided pre-aborted signal conservatively (probe returns false)", async () => {
		const { impl } = makeFakeFetch({ hang: true });
		const c = new CheckpointClient({
			baseUrl: "http://llama:8080/",
			fetchImpl: impl,
		});
		const controller = new AbortController();
		controller.abort();
		await expect(c.probeSupported(controller.signal)).resolves.toBe(false);
	});
});

describe("CheckpointClient probeSupported", () => {
	it("returns true when the health endpoint advertises checkpoint support", async () => {
		const { impl } = makeFakeFetch({
			body: JSON.stringify({ ctx_checkpoints_supported: true }),
		});
		const c = new CheckpointClient({
			baseUrl: "http://llama:8080/",
			fetchImpl: impl,
		});
		await expect(c.probeSupported()).resolves.toBe(true);
	});

	it("returns true when slot_save_path is set", async () => {
		const { impl } = makeFakeFetch({
			body: JSON.stringify({ slot_save_path: "/tmp/slots" }),
		});
		const c = new CheckpointClient({
			baseUrl: "http://llama:8080/",
			fetchImpl: impl,
		});
		await expect(c.probeSupported()).resolves.toBe(true);
	});

	it("returns false when support is not advertised", async () => {
		const { impl } = makeFakeFetch({ body: JSON.stringify({ ok: true }) });
		const c = new CheckpointClient({
			baseUrl: "http://llama:8080/",
			fetchImpl: impl,
		});
		await expect(c.probeSupported()).resolves.toBe(false);
	});

	it("returns false (conservative) on network failure", async () => {
		const impl = async () => {
			throw new Error("ECONNREFUSED");
		};
		const c = new CheckpointClient({
			baseUrl: "http://llama:8080/",
			fetchImpl: impl,
		});
		await expect(c.probeSupported()).resolves.toBe(false);
	});
});
