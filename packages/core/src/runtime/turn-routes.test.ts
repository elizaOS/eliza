/**
 * Unit coverage for turn control HTTP routes in turn-routes.ts.
 *
 * Tests TURN_CONTROL_ROUTES registry composition, TURN_ABORT_ROUTE handling
 * (validation, reason defaulting, abortTurn invocation), and TURN_STATUS_ROUTE handling.
 */

import { describe, expect, it, vi } from "vitest";
import type { IAgentRuntime } from "../types/runtime.js";
import { TURN_CONTROL_ROUTES } from "./turn-routes.js";

function createMockRes() {
	const res: {
		statusCode: number;
		body: unknown;
		status: (code: number) => typeof res;
		json: (data: unknown) => typeof res;
	} = {
		statusCode: 200,
		body: undefined,
		status(code: number) {
			res.statusCode = code;
			return res;
		},
		json(data: unknown) {
			res.body = data;
			return res;
		},
	};
	return res;
}

describe("turn-routes", () => {
	it("exports TURN_CONTROL_ROUTES containing POST abort and GET status routes", () => {
		expect(TURN_CONTROL_ROUTES.length).toBe(2);

		const abortRoute = TURN_CONTROL_ROUTES.find(
			(r) => r.type === "POST" && r.path === "/api/turns/:roomId/abort",
		);
		const statusRoute = TURN_CONTROL_ROUTES.find(
			(r) => r.type === "GET" && r.path === "/api/turns/:roomId",
		);

		expect(abortRoute).toBeDefined();
		expect(statusRoute).toBeDefined();
	});

	describe("POST /api/turns/:roomId/abort", () => {
		const abortRoute = TURN_CONTROL_ROUTES[0];

		it("rejects request when roomId is missing from params", async () => {
			const res = createMockRes();
			const mockRuntime = {} as IAgentRuntime;

			await abortRoute.handler({ params: {} }, res, mockRuntime);

			expect(res.statusCode).toBe(400);
			expect(res.body).toEqual({ error: "roomId required" });
		});

		it("invokes runtime.turnControllers.abortTurn with provided reason", async () => {
			const res = createMockRes();
			const mockAbortTurn = vi.fn(() => true);
			const mockRuntime = {
				turnControllers: {
					abortTurn: mockAbortTurn,
				},
			} as unknown as IAgentRuntime;

			await abortRoute.handler(
				{
					params: { roomId: "room-123" },
					body: { reason: "user_cancelled" },
				},
				res,
				mockRuntime,
			);

			expect(mockAbortTurn).toHaveBeenCalledWith("room-123", "user_cancelled");
			expect(res.statusCode).toBe(200);
			expect(res.body).toEqual({
				aborted: true,
				roomId: "room-123",
				reason: "user_cancelled",
			});
		});

		it("defaults reason to 'external_request' when omitted", async () => {
			const res = createMockRes();
			const mockAbortTurn = vi.fn(() => false);
			const mockRuntime = {
				turnControllers: {
					abortTurn: mockAbortTurn,
				},
			} as unknown as IAgentRuntime;

			await abortRoute.handler(
				{
					params: { roomId: "room-456" },
					body: {},
				},
				res,
				mockRuntime,
			);

			expect(mockAbortTurn).toHaveBeenCalledWith(
				"room-456",
				"external_request",
			);
			expect(res.statusCode).toBe(200);
			expect(res.body).toEqual({
				aborted: false,
				roomId: "room-456",
				reason: "external_request",
			});
		});
	});

	describe("GET /api/turns/:roomId", () => {
		const statusRoute = TURN_CONTROL_ROUTES[1];

		it("rejects request when roomId is missing from params", async () => {
			const res = createMockRes();
			const mockRuntime = {} as IAgentRuntime;

			await statusRoute.handler({ params: {} }, res, mockRuntime);

			expect(res.statusCode).toBe(400);
			expect(res.body).toEqual({ error: "roomId required" });
		});

		it("queries runtime turn controller status and returns payload", async () => {
			const res = createMockRes();
			const mockRuntime = {
				turnControllers: {
					hasActiveTurn: vi.fn(() => true),
					signalFor: vi.fn(() => new AbortController().signal),
				},
			} as unknown as IAgentRuntime;

			await statusRoute.handler(
				{ params: { roomId: "room-active" } },
				res,
				mockRuntime,
			);

			expect(res.statusCode).toBe(200);
			expect(res.body).toEqual({
				roomId: "room-active",
				active: true,
				hasSignal: true,
			});
		});
	});
});
