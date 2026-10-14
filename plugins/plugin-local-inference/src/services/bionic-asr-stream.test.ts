/**
 * Wire tests for the bionic host's streaming ASR ops over a real AF_UNIX
 * socket (a filesystem path, so it runs on macOS and Linux). The test host
 * mirrors BionicAsrStreams.java: one stream per connection, cancel by id on
 * any connection, the stream freed when its connection closes.
 */
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	BIONIC_ASR_STREAM_MAX_FEED_SECONDS,
	BionicAsrStreamError,
	bionicAsrOneShot,
	bionicSocketPath,
	encodeFrame,
	openBionicAsrStream,
	pcmToBase64LE,
} from "./bionic-asr-stream";

interface HostState {
	streaming: boolean;
	open: Map<string, { samples: number; closed: boolean }>;
	requests: Record<string, unknown>[];
	cancelled: string[];
	disconnectsWithStream: number;
	decodeDelayMs: number;
}

function startHost(socketPath: string, state: HostState): net.Server {
	let nextId = 1;
	const server = net.createServer((sock) => {
		let buf = Buffer.alloc(0);
		let owned: string | null = null;
		let chain = Promise.resolve();
		sock.on("close", () => {
			if (owned) {
				state.open.delete(owned);
				state.disconnectsWithStream++;
			}
		});
		const respond = async (req: Record<string, unknown>) => {
			state.requests.push(req);
			const op = String(req.op);
			const s = owned ? state.open.get(owned) : undefined;
			switch (op) {
				case "asr_stream_supported":
					return { ok: true, supported: state.streaming };
				case "asr_stream_open": {
					if (!state.streaming) {
						return { ok: false, code: "STREAM_UNSUPPORTED", error: "no" };
					}
					owned = `s${nextId++}`;
					state.open.set(owned, { samples: 0, closed: false });
					return { ok: true, streamId: owned, sampleRate: req.sampleRate };
				}
				case "asr_stream_feed": {
					if (!s) return { ok: false, code: "NO_STREAM", error: "none" };
					const n = Buffer.from(String(req.pcmBase64), "base64").length / 4;
					s.samples += n;
					return { ok: true, samples: n, totalSamples: s.samples };
				}
				case "asr_stream_partial":
				case "asr_stream_finish": {
					if (!s) return { ok: false, code: "NO_STREAM", error: "none" };
					await new Promise((r) => setTimeout(r, state.decodeDelayMs));
					if (owned && state.cancelled.includes(owned)) {
						return { ok: false, code: "CANCELLED", error: "cancelled" };
					}
					return { ok: true, text: `heard ${s.samples}` };
				}
				case "asr_stream_close": {
					const had = Boolean(owned);
					if (owned) state.open.delete(owned);
					owned = null;
					return { ok: true, closed: had };
				}
				case "asr_stream_cancel": {
					const id = String(req.streamId);
					const hit = state.open.has(id);
					if (hit) state.cancelled.push(id);
					return { ok: true, signalled: hit };
				}
				default:
					return { ok: false, error: `unsupported op: ${op}` };
			}
		};
		sock.on("data", (d: Buffer) => {
			buf = Buffer.concat([buf, d]);
			for (;;) {
				if (buf.length < 4) return;
				const n = buf.readUInt32BE(0);
				if (buf.length < 4 + n) return;
				const req = JSON.parse(buf.subarray(4, 4 + n).toString("utf8"));
				buf = buf.subarray(4 + n);
				// One frame at a time per connection, like the Java host.
				chain = chain.then(async () => {
					const res = await respond(req);
					if (!sock.destroyed) sock.write(encodeFrame(res));
				});
			}
		});
	});
	server.listen(socketPath);
	return server;
}

const dirs: string[] = [];
const servers: net.Server[] = [];
afterEach(() => {
	for (const s of servers.splice(0)) s.close();
	for (const d of dirs.splice(0))
		fs.rmSync(d, { recursive: true, force: true });
});

function setup(streaming = true): { socketPath: string; state: HostState } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eas-"));
	dirs.push(dir);
	const socketPath = path.join(dir, "h.sock");
	const state: HostState = {
		streaming,
		open: new Map(),
		requests: [],
		cancelled: [],
		disconnectsWithStream: 0,
		decodeDelayMs: 0,
	};
	servers.push(startHost(socketPath, state));
	return { socketPath, state };
}

const waitFor = async (cond: () => boolean) => {
	for (let i = 0; i < 100 && !cond(); i++) {
		await new Promise((r) => setTimeout(r, 10));
	}
};

describe("bionic streaming ASR wire protocol", () => {
	it("maps socket names: bare names are abstract, paths are files", () => {
		expect(bionicSocketPath("eliza_bionic")).toBe("\0eliza_bionic");
		expect(bionicSocketPath("/tmp/x.sock")).toBe("/tmp/x.sock");
	});

	it("encodes fp32 little-endian PCM", () => {
		const b64 = pcmToBase64LE(new Float32Array([0.5, -1]));
		const buf = Buffer.from(b64, "base64");
		expect(buf.readFloatLE(0)).toBe(0.5);
		expect(buf.readFloatLE(4)).toBe(-1);
	});

	it("runs open, feed, partial, finish and close on one connection", async () => {
		const { socketPath, state } = setup();
		const stream = await openBionicAsrStream({
			socketPath,
			bundleDir: "/b",
			sampleRate: 16000,
		});
		expect(stream).not.toBeNull();
		if (!stream) return;
		expect(await stream.feed(new Float32Array(1600))).toBe(1600);
		expect(await stream.partial()).toBe("heard 1600");
		expect(await stream.finish()).toBe("heard 1600");
		expect(stream.isFinished).toBe(true);
		await stream.close();
		await stream.close();
		expect(state.open.size).toBe(0);
		expect(state.requests.map((r) => r.op)).toEqual([
			"asr_stream_open",
			"asr_stream_feed",
			"asr_stream_partial",
			"asr_stream_finish",
			"asr_stream_close",
		]);
		expect(state.requests[0]).toMatchObject({
			bundleDir: "/b",
			sampleRate: 16000,
		});
		await expect(stream.partial()).rejects.toMatchObject({ code: "CLOSED" });
	});

	it("splits a long feed at the host's per-feed bound", async () => {
		const { socketPath, state } = setup();
		const stream = await openBionicAsrStream({
			socketPath,
			bundleDir: "",
			sampleRate: 8000,
		});
		if (!stream) throw new Error("expected a stream");
		const max = BIONIC_ASR_STREAM_MAX_FEED_SECONDS * 8000;
		expect(await stream.feed(new Float32Array(max * 2 + 5))).toBe(max * 2 + 5);
		expect(
			state.requests.filter((r) => r.op === "asr_stream_feed"),
		).toHaveLength(3);
		await stream.close();
	});

	it("resolves null only when the backend cannot stream", async () => {
		const { socketPath, state } = setup(false);
		expect(
			await openBionicAsrStream({
				socketPath,
				bundleDir: "",
				sampleRate: 16000,
			}),
		).toBeNull();
		const probe = await bionicAsrOneShot(socketPath, {
			op: "asr_stream_supported",
		});
		expect(probe).toMatchObject({ ok: true, supported: false });
		expect(state.open.size).toBe(0);
	});

	it("cancels a running decode from a second connection", async () => {
		const { socketPath, state } = setup();
		state.decodeDelayMs = 100;
		const stream = await openBionicAsrStream({
			socketPath,
			bundleDir: "",
			sampleRate: 16000,
		});
		if (!stream) throw new Error("expected a stream");
		await stream.feed(new Float32Array(320));
		const decoding = stream.partial();
		expect(await stream.cancel()).toBe(true);
		await expect(decoding).rejects.toMatchObject({
			name: "BionicAsrStreamError",
			code: "CANCELLED",
		});
		await stream.close();
	});

	it("frees the host stream when the client drops the connection", async () => {
		const { socketPath, state } = setup();
		const stream = await openBionicAsrStream({
			socketPath,
			bundleDir: "",
			sampleRate: 16000,
		});
		if (!stream) throw new Error("expected a stream");
		expect(state.open.size).toBe(1);
		(stream as unknown as { conn: { destroy(): void } }).conn.destroy();
		await waitFor(() => state.disconnectsWithStream === 1);
		expect(state.open.size).toBe(0);
		await expect(stream.partial()).rejects.toBeInstanceOf(BionicAsrStreamError);
	});
});
