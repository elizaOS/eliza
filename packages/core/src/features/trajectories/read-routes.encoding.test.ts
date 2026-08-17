/**
 * Trajectory-detail path encoding is leftover tax after media-store /
 * views-routes path decode. Stock develop called decodeURIComponent on
 * GET /api/trajectories/:id before the handler try/catch, so `%` / `%2` /
 * `%ZZ` threw URIError (500) instead of a typed 400. GET /api/trajectories
 * list and GET /api/trajectories/stats stay untouched.
 */
import type { ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import type { IAgentRuntime } from "../../types";
import { tryHandleTrajectoryReadRoutes } from "./read-routes";

function mockRes(): {
	res: ServerResponse;
	get: () => { status: number; body: unknown };
} {
	const state = { status: 0, body: undefined as unknown };
	const res = {
		statusCode: 0,
		setHeader() {},
		end(payload?: string) {
			state.status = (this as { statusCode: number }).statusCode;
			state.body = payload ? JSON.parse(payload) : undefined;
		},
	} as unknown as ServerResponse;
	return { res, get: () => ({ status: state.status, body: state.body }) };
}

function runtimeWith(service: unknown): IAgentRuntime {
	return {
		getService: (type: string) => (type === "trajectories" ? service : null),
		getRoom: async () => null,
	} as unknown as IAgentRuntime;
}

const url = (p: string) => new URL(`http://localhost${p}`);

describe("GET /api/trajectories/:id encoding", () => {
	it("GET /api/trajectories list is untouched", async () => {
		const list = {
			listTrajectories: async () => ({ trajectories: [], total: 0 }),
			getTrajectoryDetail: async () => {
				throw new Error("detail must not run on the list path");
			},
		};
		const { res, get } = mockRes();
		const handled = await tryHandleTrajectoryReadRoutes({
			pathname: "/api/trajectories",
			method: "GET",
			url: url("/api/trajectories"),
			runtime: runtimeWith(list),
			res,
		});
		expect(handled).toBe(true);
		expect(get().status).toBe(200);
		expect(get().body).toEqual({
			trajectories: [],
			total: 0,
			offset: 0,
			limit: 50,
		});
	});

	it("GET /api/trajectories/stats is untouched", async () => {
		const stats = {
			getStats: async () => ({ count: 2 }),
			getTrajectoryDetail: async () => {
				throw new Error("detail must not run on the stats path");
			},
		};
		const { res, get } = mockRes();
		const handled = await tryHandleTrajectoryReadRoutes({
			pathname: "/api/trajectories/stats",
			method: "GET",
			url: url("/api/trajectories/stats"),
			runtime: runtimeWith(stats),
			res,
		});
		expect(handled).toBe(true);
		expect(get().status).toBe(200);
		expect(get().body).toEqual({ count: 2 });
	});

	it("canonical percent-encoded id still reaches detail lookup", async () => {
		const seen: string[] = [];
		const service = {
			getTrajectoryDetail: async (id: string) => {
				seen.push(id);
				return null;
			},
		};
		const { res, get } = mockRes();
		const handled = await tryHandleTrajectoryReadRoutes({
			pathname: "/api/trajectories/t%2D1",
			method: "GET",
			url: url("/api/trajectories/t%2D1"),
			runtime: runtimeWith(service),
			res,
		});
		expect(handled).toBe(true);
		expect(seen).toEqual(["t-1"]);
		expect(get().status).toBe(404);
		expect(get().body).toEqual({ error: 'Trajectory "t-1" not found' });
	});

	it.each([
		"/api/trajectories/%",
		"/api/trajectories/%2",
		"/api/trajectories/%ZZ",
		"/api/trajectories/%E0%A4",
	])("rejects malformed %s with 400 before detail lookup", async (pathname) => {
		const service = {
			getTrajectoryDetail: async () => {
				throw new Error("detail must not run on malformed encoding");
			},
		};
		const { res, get } = mockRes();
		const handled = await tryHandleTrajectoryReadRoutes({
			pathname,
			method: "GET",
			url: url(pathname),
			runtime: runtimeWith(service),
			res,
		});
		expect(handled).toBe(true);
		expect(get().status).toBe(400);
		expect(get().body).toEqual({
			error: "invalid trajectory id: malformed URL encoding",
		});
	});

	it.each([
		"/api/trajectories/%2F",
		"/api/trajectories/%5C",
		"/api/trajectories/%00",
		"/api/trajectories/%2E",
		"/api/trajectories/%2E%2E",
	])(
		"rejects decoded non-segment id %s before detail lookup",
		async (pathname) => {
			let detailCalls = 0;
			const service = {
				getTrajectoryDetail: async () => {
					detailCalls += 1;
					return null;
				},
			};
			const { res, get } = mockRes();
			const handled = await tryHandleTrajectoryReadRoutes({
				pathname,
				method: "GET",
				url: url(pathname),
				runtime: runtimeWith(service),
				res,
			});
			expect(handled).toBe(true);
			expect(detailCalls).toBe(0);
			expect(get()).toEqual({
				status: 400,
				body: { error: "invalid trajectory id: invalid path segment" },
			});
		},
	);

	it("classifies an encoded stats segment before detail lookup", async () => {
		let detailCalls = 0;
		const service = {
			getStats: async () => ({ count: 3 }),
			getTrajectoryDetail: async () => {
				detailCalls += 1;
				return null;
			},
		};
		const { res, get } = mockRes();
		const pathname = "/api/trajectories/%73tats";
		const handled = await tryHandleTrajectoryReadRoutes({
			pathname,
			method: "GET",
			url: url(pathname),
			runtime: runtimeWith(service),
			res,
		});
		expect(handled).toBe(true);
		expect(detailCalls).toBe(0);
		expect(get()).toEqual({ status: 200, body: { count: 3 } });
	});

	it("leaves an encoded config segment for the host route", async () => {
		let detailCalls = 0;
		const service = {
			getTrajectoryDetail: async () => {
				detailCalls += 1;
				return null;
			},
		};
		const { res, get } = mockRes();
		const pathname = "/api/trajectories/%63onfig";
		const handled = await tryHandleTrajectoryReadRoutes({
			pathname,
			method: "GET",
			url: url(pathname),
			runtime: runtimeWith(service),
			res,
		});
		expect(handled).toBe(false);
		expect(detailCalls).toBe(0);
		expect(get()).toEqual({ status: 0, body: undefined });
	});

	it("decodes exactly once", async () => {
		const seen: string[] = [];
		const service = {
			getTrajectoryDetail: async (id: string) => {
				seen.push(id);
				return null;
			},
		};
		const { res } = mockRes();
		await tryHandleTrajectoryReadRoutes({
			pathname: "/api/trajectories/%252F",
			method: "GET",
			url: url("/api/trajectories/%252F"),
			runtime: runtimeWith(service),
			res,
		});
		expect(seen).toEqual(["%2F"]);
	});
});
