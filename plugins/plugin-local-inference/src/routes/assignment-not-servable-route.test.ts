/**
 * #8808 acceptance criterion 5 — assignment-rejection → HTTP 422.
 *
 * A non-servable generic pick on desktop must surface as a typed, user-visible
 * failure, never a silent deferred lazy-load. `setAssignment` raises
 * `AssignmentNotServableError` at the boundary; the
 * `POST /api/local-inference/assignments` route maps it to 422 with the typed
 * `code` + `runtimeClass`. This test drives the real route handler with the
 * service throwing each typed error and asserts the 422 contract, and pins the
 * typed-error shape that the boundary produces.
 */

import * as http from "node:http";
import { Socket } from "node:net";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
	AssignmentNotServableError,
	AssignmentRejectedError,
	canServeRuntimeClassOnHost,
} from "../services/assignments";
import type { CompatRuntimeState } from "./compat-route-shared";

// ── mocks (mirror local-inference-compat-routes.test.ts) ────────────────

const setSlotAssignmentMock = vi.fn();

vi.mock("@elizaos/core", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@elizaos/core")>();
	return {
		...actual,
		logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
		ModelType: {
			TEXT_LARGE: "TEXT_LARGE",
			TEXT_SMALL: "TEXT_SMALL",
			TEXT_EMBEDDING: "TEXT_EMBEDDING",
			TEXT_TO_SPEECH: "TEXT_TO_SPEECH",
			TRANSCRIPTION: "TRANSCRIPTION",
		},
		stringToUuid: (value: string) => value,
	};
});

vi.mock("@elizaos/agent", () => ({
	loadElizaConfig: () => ({ meta: {}, agents: {} }),
}));

vi.mock("./auth", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./auth")>();
	return {
		...actual,
		ensureRouteAuthorized: vi.fn(async () => true),
		ensureCompatSensitiveRouteAuthorized: () => true,
		getCompatApiToken: () => null,
		getProvidedApiToken: () => null,
		tokenMatches: () => true,
	};
});

vi.mock("./auth/sessions", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./auth/sessions")>();
	return {
		...actual,
		findActiveSession: vi.fn(async () => null),
		parseSessionCookie: vi.fn(() => null),
	};
});

vi.mock("./server-first-run-helpers", () => ({
	isCloudProvisioned: () => false,
}));

vi.mock("../services/service", () => ({
	localInferenceService: {
		setSlotAssignment: setSlotAssignmentMock,
		getActive: () => ({ modelId: null, loadedAt: null, status: "idle" }),
		getCatalog: () => [],
		getDownloads: () => [],
	},
}));

vi.mock("../services/device-bridge", () => ({
	deviceBridge: { status: () => ({ connected: false, devices: [] }) },
}));

vi.mock("../services/handler-registry", () => ({
	handlerRegistry: { getAll: () => [] },
	toPublicRegistration: (r: unknown) => r,
}));

vi.mock("../services/providers", () => ({
	snapshotProviders: vi.fn(async () => []),
}));

vi.mock("../services/routing-preferences", () => ({
	readRoutingPreferences: vi.fn(async () => ({})),
	setPolicy: vi.fn(),
	setPreferredProvider: vi.fn(),
}));

const STATE: CompatRuntimeState = {
	current: null,
	pendingAgentName: null,
	pendingRestartReasons: [],
};

// ── fake req/res (mirror local-inference-compat-routes.test.ts) ─────────

interface FakeRes {
	res: http.ServerResponse;
	body(): unknown;
	status(): number;
}

function fakeRes(): FakeRes {
	let bodyText = "";
	const req = new http.IncomingMessage(new Socket());
	const res = new http.ServerResponse(req);
	res.statusCode = 200;
	res.setHeader = () => res;
	res.end = ((chunk?: string | Buffer) => {
		if (typeof chunk === "string") bodyText += chunk;
		else if (chunk) bodyText += chunk.toString("utf8");
		return res;
	}) as typeof res.end;
	return {
		res,
		body() {
			return bodyText.length > 0 ? JSON.parse(bodyText) : null;
		},
		status() {
			return res.statusCode;
		},
	};
}

function fakeReq(opts: {
	method: string;
	pathname: string;
	body?: unknown;
}): http.IncomingMessage {
	const req = new http.IncomingMessage(new Socket());
	req.method = opts.method;
	req.url = opts.pathname;
	req.headers = { host: "localhost:2138" };
	Object.defineProperty(req.socket, "remoteAddress", {
		value: "127.0.0.1",
		configurable: true,
	});
	if (opts.body !== undefined) {
		(req as { body?: unknown }).body = opts.body;
	}
	return req;
}

const GENERIC_ID =
	"hf:meta-llama/Llama-3.2-3B-Instruct-GGUF::Llama-3.2-3B-Instruct-Q4_K_M.gguf";

describe("AssignmentNotServableError typed shape (C5)", () => {
	it("carries code, slot, modelId, and runtimeClass", () => {
		const err = new AssignmentNotServableError({
			slot: "TEXT_LARGE",
			modelId: GENERIC_ID,
			runtimeClass: "generic-gguf",
			message: "cannot serve generic on desktop",
		});
		expect(err).toBeInstanceOf(Error);
		expect(err.code).toBe("ASSIGNMENT_NOT_SERVABLE");
		expect(err.slot).toBe("TEXT_LARGE");
		expect(err.modelId).toBe(GENERIC_ID);
		expect(err.runtimeClass).toBe("generic-gguf");
	});

	it("canServeRuntimeClassOnHost refuses generic GGUF on a host without the explicit-modelPath binding", async () => {
		// Inject a loader that reports no explicit-modelPath binding (desktop today).
		const desktopLoader = { available: () => false };
		expect(
			await canServeRuntimeClassOnHost("generic-gguf", desktopLoader),
		).toBe(false);
		// Fused Eliza-1 is always servable.
		expect(
			await canServeRuntimeClassOnHost("fused-eliza1", desktopLoader),
		).toBe(true);
	});
});

describe("POST /api/local-inference/assignments error mapping (C5)", () => {
	let handleLocalInferenceCompatRoutes: typeof import("./local-inference-compat-routes").handleLocalInferenceCompatRoutes;

	beforeAll(async () => {
		handleLocalInferenceCompatRoutes = (
			await import("./local-inference-compat-routes")
		).handleLocalInferenceCompatRoutes;
	}, 120_000);

	it("maps AssignmentNotServableError to 422 with code + runtimeClass", async () => {
		setSlotAssignmentMock.mockReset();
		setSlotAssignmentMock.mockRejectedValue(
			new AssignmentNotServableError({
				slot: "TEXT_LARGE",
				modelId: GENERIC_ID,
				runtimeClass: "generic-gguf",
				message:
					'Cannot assign "Llama-3.2-3B-Instruct" to TEXT_LARGE: it is a generic single-file GGUF.',
			}),
		);

		const res = fakeRes();
		const handled = await handleLocalInferenceCompatRoutes(
			fakeReq({
				method: "POST",
				pathname: "/api/local-inference/assignments",
				body: { slot: "TEXT_LARGE", modelId: GENERIC_ID },
			}),
			res.res,
			STATE,
		);

		expect(handled).toBe(true);
		expect(res.status()).toBe(422);
		const body = res.body() as {
			error: string;
			code: string;
			runtimeClass: string;
		};
		expect(body.code).toBe("ASSIGNMENT_NOT_SERVABLE");
		expect(body.runtimeClass).toBe("generic-gguf");
		expect(body.error).toMatch(/generic single-file GGUF/);
	});

	it("maps AssignmentRejectedError (non-curated pick) to 422 with code", async () => {
		setSlotAssignmentMock.mockReset();
		setSlotAssignmentMock.mockRejectedValue(
			new AssignmentRejectedError({
				slot: "TEXT_LARGE",
				modelId: GENERIC_ID,
				message:
					"Local inference assignments are limited to curated Eliza-1 tiers.",
			}),
		);

		const res = fakeRes();
		await handleLocalInferenceCompatRoutes(
			fakeReq({
				method: "POST",
				pathname: "/api/local-inference/assignments",
				body: { slot: "TEXT_LARGE", modelId: GENERIC_ID },
			}),
			res.res,
			STATE,
		);

		expect(res.status()).toBe(422);
		const body = res.body() as { error: string; code: string };
		expect(body.code).toBe("ASSIGNMENT_REJECTED");
		expect(body.error).toMatch(/curated Eliza-1/);
	});

	it("returns 200 with the new assignment map for a servable pick", async () => {
		setSlotAssignmentMock.mockReset();
		setSlotAssignmentMock.mockResolvedValue({ TEXT_LARGE: "eliza-1-4b" });

		const res = fakeRes();
		await handleLocalInferenceCompatRoutes(
			fakeReq({
				method: "POST",
				pathname: "/api/local-inference/assignments",
				body: { slot: "TEXT_LARGE", modelId: "eliza-1-4b" },
			}),
			res.res,
			STATE,
		);

		expect(res.status()).toBe(200);
		const body = res.body() as { assignments: Record<string, string> };
		expect(body.assignments.TEXT_LARGE).toBe("eliza-1-4b");
		expect(setSlotAssignmentMock).toHaveBeenCalledWith(
			"TEXT_LARGE",
			"eliza-1-4b",
		);
	});

	it("rejects an unknown slot with 400 before touching the service", async () => {
		setSlotAssignmentMock.mockReset();
		const res = fakeRes();
		await handleLocalInferenceCompatRoutes(
			fakeReq({
				method: "POST",
				pathname: "/api/local-inference/assignments",
				body: { slot: "NOT_A_SLOT", modelId: "eliza-1-4b" },
			}),
			res.res,
			STATE,
		);

		expect(res.status()).toBe(400);
		expect(setSlotAssignmentMock).not.toHaveBeenCalled();
	});
});
