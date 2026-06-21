import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { BionicHostLoader } from "./bionic-host-loader";

/**
 * Real-IPC test: stand up an actual abstract-namespace AF_UNIX server (the same
 * transport ElizaBionicInferenceServer.java binds on the device) and drive the
 * loader against it. No mocks — this exercises the real node:net framing.
 */

function frame(json: string): Buffer {
	const payload = Buffer.from(json, "utf8");
	const out = Buffer.allocUnsafe(4 + payload.length);
	out.writeUInt32BE(payload.length, 0);
	payload.copy(out, 4);
	return out;
}

/** A test host that decodes one request frame and replies with `respond(req)`. */
function startHost(
	name: string,
	respond: (req: Record<string, unknown>) => string,
): net.Server {
	const server = net.createServer((sock) => {
		let buf = Buffer.alloc(0);
		let expected = -1;
		sock.on("data", (d) => {
			buf = Buffer.concat([buf, d]);
			if (expected < 0 && buf.length >= 4) expected = buf.readUInt32BE(0);
			if (expected >= 0 && buf.length >= 4 + expected) {
				const req = JSON.parse(buf.subarray(4, 4 + expected).toString("utf8"));
				sock.write(frame(respond(req)));
			}
		});
	});
	server.listen({ path: `\0${name}` });
	return server;
}

let host: net.Server | null = null;
afterEach(() => {
	host?.close();
	host = null;
});

const SOCK = `eliza-bionic-test-${process.pid}`;

describe("BionicHostLoader (real abstract-UDS)", () => {
	it("round-trips a buffered generate and returns the host completion", async () => {
		let seen: Record<string, unknown> | null = null;
		host = startHost(SOCK, (req) => {
			seen = req;
			return JSON.stringify({
				ok: true,
				text: "Two plus two equals four.",
				tokens: 7,
				ms: 500,
				tokS: 14,
			});
		});
		const loader = new BionicHostLoader(SOCK);
		await loader.loadModel({
			modelPath: "/data/x/eliza-1/bundle/text/model.gguf",
		});
		expect(loader.currentModelPath()).toBe(
			"/data/x/eliza-1/bundle/text/model.gguf",
		);
		const out = await loader.generate({
			prompt: "what is 2+2?",
			maxTokens: 32,
		});
		expect(out).toBe("Two plus two equals four.");
		// bundleDir derived from the .../text/<model>.gguf layout.
		expect(seen).toMatchObject({
			op: "generate",
			prompt: "what is 2+2?",
			maxTokens: 32,
			bundleDir: "/data/x/eliza-1/bundle",
		});
	});

	it("forwards an empty bundleDir when the model is not in a text/ bundle", async () => {
		let seen: Record<string, unknown> | null = null;
		host = startHost(SOCK, (req) => {
			seen = req;
			return JSON.stringify({ ok: true, text: "hi" });
		});
		const loader = new BionicHostLoader(SOCK);
		await loader.loadModel({ modelPath: "/models/flat-model.gguf" });
		await loader.generate({ prompt: "hi" });
		expect((seen as { bundleDir?: string } | null)?.bundleDir).toBe("");
	});

	it("throws when the host returns ok:false", async () => {
		host = startHost(SOCK, () =>
			JSON.stringify({ ok: false, error: "no vulkan device" }),
		);
		const loader = new BionicHostLoader(SOCK);
		await loader.loadModel({ modelPath: "/m/text/x.gguf" });
		await expect(loader.generate({ prompt: "x" })).rejects.toThrow(
			/no vulkan device/,
		);
	});

	it("survives a response split across multiple data chunks (multibyte safe)", async () => {
		const text = `héllo 🌊 ünïcode ${"x".repeat(5000)}`;
		host = net.createServer((sock) => {
			let buf = Buffer.alloc(0);
			let expected = -1;
			sock.on("data", (d) => {
				buf = Buffer.concat([buf, d]);
				if (expected < 0 && buf.length >= 4) expected = buf.readUInt32BE(0);
				if (expected >= 0 && buf.length >= 4 + expected) {
					const full = frame(JSON.stringify({ ok: true, text }));
					// Write in two pieces, splitting mid-buffer to exercise reassembly.
					sock.write(full.subarray(0, 10));
					setTimeout(() => sock.write(full.subarray(10)), 5);
				}
			});
		});
		host.listen({ path: `\0${SOCK}` });
		const loader = new BionicHostLoader(SOCK);
		await loader.loadModel({ modelPath: "/m/text/x.gguf" });
		const out = await loader.generate({ prompt: "x" });
		expect(out).toBe(text);
	});

	it("rejects when the host is unreachable", async () => {
		const loader = new BionicHostLoader(`eliza-bionic-absent-${process.pid}`);
		await loader.loadModel({ modelPath: "/m/text/x.gguf" });
		await expect(loader.generate({ prompt: "x" })).rejects.toThrow();
	});
});
