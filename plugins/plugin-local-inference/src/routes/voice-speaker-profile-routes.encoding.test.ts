/** Exercises malformed speaker-profile identifiers before store access. */
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/core", () => ({
	logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
	resolveStateDir: () => "/tmp",
	sendJson: (
		res: { statusCode: number; end: (chunk?: string) => void },
		body: unknown,
		status = 200,
	) => {
		res.statusCode = status;
		res.end(JSON.stringify(body));
	},
	sendJsonError: (
		res: { statusCode: number; end: (chunk?: string) => void },
		message: string,
		status = 400,
	) => {
		res.statusCode = status;
		res.end(JSON.stringify({ error: message }));
	},
	readJsonBody: async (req: AsyncIterable<Buffer> & { body?: unknown }) => {
		if (req.body && typeof req.body === "object") {
			return req.body as Record<string, unknown>;
		}
		const chunks: Buffer[] = [];
		for await (const chunk of req) {
			chunks.push(chunk);
		}
		const raw = Buffer.concat(chunks).toString("utf8").trim();
		return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
	},
}));

const { handleVoiceSpeakerProfileRoutes, setVoiceSpeakerProfileStore } =
	await import("./voice-speaker-profile-routes");

function makeReq(args: {
	method: "GET" | "POST";
	url: string;
	body?: string | null;
}): import("node:http").IncomingMessage {
	const emitter = new EventEmitter();
	const body =
		args.body == null ? Buffer.alloc(0) : Buffer.from(args.body, "utf8");
	(emitter as unknown as { method: string }).method = args.method;
	(emitter as unknown as { url: string }).url = args.url;
	(emitter as unknown as { headers: Record<string, string> }).headers = {
		"content-type": "application/json",
		"content-length": String(body.length),
	};
	(
		emitter as unknown as {
			[Symbol.asyncIterator]: () => AsyncIterator<Buffer>;
		}
	)[Symbol.asyncIterator] = async function* () {
		yield body;
	};
	return emitter as unknown as import("node:http").IncomingMessage;
}

interface CapturedResponse {
	statusCode: number;
	body: string;
}

function makeRes(): {
	res: import("node:http").ServerResponse;
	captured: CapturedResponse;
} {
	const captured: CapturedResponse = { statusCode: 200, body: "" };
	const chunks: Buffer[] = [];
	const res = {
		statusCode: 200,
		headersSent: false,
		setHeader() {},
		writeHead(code: number) {
			captured.statusCode = code;
		},
		write(chunk: Buffer | string) {
			chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
			return true;
		},
		end(chunk?: Buffer | string) {
			if (chunk != null) {
				chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
			}
			captured.body = Buffer.concat(chunks).toString("utf8");
			if (captured.statusCode === 200) {
				captured.statusCode = (
					res as unknown as { statusCode: number }
				).statusCode;
			}
		},
	};
	return {
		res: res as unknown as import("node:http").ServerResponse,
		captured,
	};
}

function mockStore() {
	return {
		bindEntity: vi.fn(async () => null),
		unbindEntity: vi.fn(async () => null),
		list: vi.fn(async () => []),
		get: vi.fn(async () => null),
		init: vi.fn(async () => undefined),
	};
}

afterEach(() => {
	setVoiceSpeakerProfileStore(null);
});

describe("POST /v1/voice/speaker-profiles/:id encoding", () => {
	it("canonical bind id still 404s as not found", async () => {
		const store = mockStore();
		setVoiceSpeakerProfileStore(store as never);
		const { res, captured } = makeRes();
		const handled = await handleVoiceSpeakerProfileRoutes(
			makeReq({
				method: "POST",
				url: "/v1/voice/speaker-profiles/vp_missing/bind",
				body: JSON.stringify({ entityId: "ent_jill" }),
			}),
			res,
		);
		expect(handled).toBe(true);
		expect(captured.statusCode).toBe(404);
		expect(store.bindEntity).toHaveBeenCalledWith({
			profileId: "vp_missing",
			entityId: "ent_jill",
			label: undefined,
		});
	});

	it("canonical percent-encoded underscore still decodes before the 404", async () => {
		const store = mockStore();
		setVoiceSpeakerProfileStore(store as never);
		const { res, captured } = makeRes();
		await handleVoiceSpeakerProfileRoutes(
			makeReq({
				method: "POST",
				url: "/v1/voice/speaker-profiles/vp%5Fmissing/bind",
				body: JSON.stringify({ entityId: "ent_jill" }),
			}),
			res,
		);
		expect(captured.statusCode).toBe(404);
		expect(store.bindEntity).toHaveBeenCalledWith({
			profileId: "vp_missing",
			entityId: "ent_jill",
			label: undefined,
		});
	});

	it("GET speaker-profiles list is untouched", async () => {
		const store = mockStore();
		setVoiceSpeakerProfileStore(store as never);
		const { res, captured } = makeRes();
		const handled = await handleVoiceSpeakerProfileRoutes(
			makeReq({ method: "GET", url: "/v1/voice/speaker-profiles" }),
			res,
		);
		expect(handled).toBe(true);
		expect(captured.statusCode).toBe(200);
		expect(JSON.parse(captured.body)).toEqual({ profiles: [] });
		expect(store.bindEntity).not.toHaveBeenCalled();
		expect(store.unbindEntity).not.toHaveBeenCalled();
	});

	it.each(["%", "%2", "%ZZ", "%E0%A4"])(
		"rejects malformed bind id %s with 400",
		async (token) => {
			const store = mockStore();
			setVoiceSpeakerProfileStore(store as never);
			const { res, captured } = makeRes();
			const handled = await handleVoiceSpeakerProfileRoutes(
				makeReq({
					method: "POST",
					url: `/v1/voice/speaker-profiles/${token}/bind`,
					body: JSON.stringify({ entityId: "ent_jill" }),
				}),
				res,
			);
			expect(handled).toBe(true);
			expect(captured.statusCode).toBe(400);
			expect(JSON.parse(captured.body)).toEqual({
				error: "Invalid profile id: malformed URL encoding",
			});
			expect(store.bindEntity).not.toHaveBeenCalled();
		},
	);

	it.each(["%", "%2", "%ZZ"])(
		"rejects malformed unbind id %s with 400",
		async (token) => {
			const store = mockStore();
			setVoiceSpeakerProfileStore(store as never);
			const { res, captured } = makeRes();
			const handled = await handleVoiceSpeakerProfileRoutes(
				makeReq({
					method: "POST",
					url: `/v1/voice/speaker-profiles/${token}/unbind`,
				}),
				res,
			);
			expect(handled).toBe(true);
			expect(captured.statusCode).toBe(400);
			expect(JSON.parse(captured.body)).toEqual({
				error: "Invalid profile id: malformed URL encoding",
			});
			expect(store.unbindEntity).not.toHaveBeenCalled();
		},
	);
});
