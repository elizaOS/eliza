/** Exercises voice-profile identifier decoding with a mocked core boundary. */
import * as http from "node:http";
import { Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/core", () => ({
	logger: { warn() {}, debug() {}, info() {}, error() {} },
	readJsonBody: async () => null,
	resolveStateDir: () => "/tmp",
	sendJson: (res: http.ServerResponse, body: unknown, status = 200) => {
		res.statusCode = status;
		res.end(JSON.stringify(body));
	},
	sendJsonError: (res: http.ServerResponse, message: string, status = 400) => {
		res.statusCode = status;
		res.end(JSON.stringify({ error: message }));
	},
}));

import type { VoiceProfileStore } from "../services/voice/profile-store";

const {
	handleVoiceProfilesManagementRoutes,
	setVoiceProfilesManagementStore,
}: typeof import("./voice-profiles-management-routes") = await import(
	"./voice-profiles-management-routes"
);

const store = {
	list: vi.fn(async () => []),
	get: vi.fn(async () => null),
};

beforeEach(() => {
	store.list.mockClear();
	store.get.mockClear();
	setVoiceProfilesManagementStore(store as unknown as VoiceProfileStore);
});

afterEach(() => {
	setVoiceProfilesManagementStore(null);
});

function request(method: string, pathname: string): http.IncomingMessage {
	const req = new http.IncomingMessage(new Socket());
	req.method = method;
	req.url = pathname;
	return req;
}

function response(): {
	res: http.ServerResponse;
	status: () => number;
	body: () => unknown;
} {
	let raw = "";
	const req = new http.IncomingMessage(new Socket());
	const res = new http.ServerResponse(req);
	res.statusCode = 200;
	res.setHeader = () => res;
	res.end = ((chunk?: string | Buffer) => {
		if (typeof chunk === "string") raw += chunk;
		else if (chunk) raw += chunk.toString("utf8");
		return res;
	}) as typeof res.end;
	return {
		res,
		status: () => res.statusCode,
		body: () => (raw ? JSON.parse(raw) : null),
	};
}

describe("DELETE /api/voice/profiles/:id encoding", () => {
	it("GET /api/voice/profiles list is untouched", async () => {
		const out = response();
		const handled = await handleVoiceProfilesManagementRoutes(
			request("GET", "/api/voice/profiles"),
			out.res,
		);
		expect(handled).toBe(true);
		expect(out.status()).toBe(200);
		expect(out.body()).toEqual({ profiles: [] });
		expect(store.list).toHaveBeenCalled();
		expect(store.get).not.toHaveBeenCalled();
	});

	it("canonical percent-encoded id still reaches store lookup", async () => {
		const out = response();
		await handleVoiceProfilesManagementRoutes(
			request("DELETE", "/api/voice/profiles/guest%2Did"),
			out.res,
		);
		expect(store.get).toHaveBeenCalledWith("guest-id");
		expect(out.status()).toBe(404);
	});

	it.each([
		"/api/voice/profiles/%",
		"/api/voice/profiles/%2",
		"/api/voice/profiles/%ZZ",
		"/api/voice/profiles/%E0%A4/unbind",
	])("rejects malformed %s with 400", async (pathname) => {
		const out = response();
		const handled = await handleVoiceProfilesManagementRoutes(
			request("DELETE", pathname),
			out.res,
		);
		expect(handled).toBe(true);
		expect(out.status()).toBe(400);
		expect(out.body()).toEqual({
			error: "invalid profile id: malformed URL encoding",
		});
		expect(store.get).not.toHaveBeenCalled();
		expect(store.list).not.toHaveBeenCalled();
	});
});
