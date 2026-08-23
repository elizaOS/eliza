/**
 * Unit tests for TRUST elevation request parsing, service orchestration, and
 * approved, denied, unavailable, and exceptional action results.
 */

import { describe, expect, test, vi } from "vitest";
import { requestElevationHandler } from "./requestElevation.ts";

const message = {
	entityId: "requester-id",
	roomId: "room-id",
	content: { text: "I need temporary access" },
};

function createHarness(
	elevationResult: unknown = {
		granted: true,
		expiresAt: 1_900_000_000_000,
	},
) {
	const evaluateTrust = vi.fn().mockResolvedValue({ overallTrust: 73 });
	const requestElevation = vi.fn().mockResolvedValue(elevationResult);
	const services = {
		"trust-engine": { trustEngine: { evaluateTrust } },
		"contextual-permissions": { permissionSystem: { requestElevation } },
	};
	const runtime = {
		agentId: "agent-id",
		getService: vi.fn((name: keyof typeof services) => services[name]),
	};

	return { evaluateTrust, requestElevation, runtime };
}

describe("TRUST request elevation", () => {
	test.each(["contextual-permissions", "trust-engine"])(
		"returns a structured failure when %s is unavailable",
		async (missingService) => {
			const { requestElevation, runtime } = createHarness();
			runtime.getService.mockImplementation((name) =>
				name === missingService ? undefined : ({} as never),
			);

			const result = await requestElevationHandler(
				runtime as never,
				message as never,
				undefined,
				{ parameters: { permissionAction: "manage_roles" } },
			);

			expect(result).toEqual({
				success: false,
				text: "Required trust services are not available.",
				error: "Required services not available",
				data: { actionName: "TRUST", subaction: "request_elevation" },
			});
			expect(requestElevation).not.toHaveBeenCalled();
		},
	);

	test.each([
		[undefined, "plain text"],
		[{ parameters: null }, "plain text"],
		[{ parameters: [] }, "plain text"],
		[{ parameters: { action: "request_elevation" } }, "plain text"],
	])("requires a permission action for options %j", async (options, text) => {
		const { evaluateTrust, requestElevation, runtime } = createHarness();

		const result = await requestElevationHandler(
			runtime as never,
			{ ...message, content: { text } } as never,
			undefined,
			options as never,
		);

		expect(result).toMatchObject({
			success: false,
			error: "No permission action specified",
			data: { actionName: "TRUST", subaction: "request_elevation" },
		});
		expect(evaluateTrust).not.toHaveBeenCalled();
		expect(requestElevation).not.toHaveBeenCalled();
	});

	test("parses JSON input and applies request defaults", async () => {
		const { evaluateTrust, requestElevation, runtime } = createHarness();

		await requestElevationHandler(
			runtime as never,
			{
				...message,
				content: {
					text: '{"action":"manage_messages","justification":"moderation"}',
				},
			} as never,
			undefined,
			undefined,
		);

		expect(evaluateTrust).toHaveBeenCalledWith("requester-id", "agent-id", {
			roomId: "room-id",
		});
		expect(requestElevation).toHaveBeenCalledWith({
			entityId: "requester-id",
			requestedPermission: { action: "manage_messages", resource: "*" },
			justification: "moderation",
			context: { roomId: "room-id", platform: "discord" },
			duration: 60 * 60 * 1000,
		});
	});

	test("prefers nested parameters over parsed text and converts duration to milliseconds", async () => {
		const { requestElevation, runtime } = createHarness();

		await requestElevationHandler(
			runtime as never,
			{
				...message,
				content: {
					text: '{"permissionAction":"from_text","resource":"text-resource","duration":5}',
				},
			} as never,
			undefined,
			{
				parameters: {
					permissionAction: "from_parameters",
					resource: "parameter-resource",
					justification: "parameter reason",
					duration: 2,
				},
			},
		);

		expect(requestElevation).toHaveBeenCalledWith(
			expect.objectContaining({
				requestedPermission: {
					action: "from_parameters",
					resource: "parameter-resource",
				},
				justification: "parameter reason",
				duration: 2 * 60 * 1000,
			}),
		);
	});

	test("uses plain text as justification when invalid JSON has nested parameters", async () => {
		const { requestElevation, runtime } = createHarness();

		await requestElevationHandler(
			runtime as never,
			message as never,
			undefined,
			{ parameters: { permissionAction: "manage_roles", duration: 0 } },
		);

		expect(requestElevation).toHaveBeenCalledWith(
			expect.objectContaining({
				justification: "I need temporary access",
				duration: 60 * 60 * 1000,
			}),
		);
	});

	test.each([
		[1_900_000_000_000, new Date(1_900_000_000_000).toLocaleString()],
		[undefined, "session end"],
	])("returns an approval with expiry %s", async (expiresAt, expiryText) => {
		const { runtime } = createHarness({ granted: true, expiresAt });

		const result = await requestElevationHandler(
			runtime as never,
			message as never,
			undefined,
			{ parameters: { permissionAction: "manage_roles" } },
		);

		expect(result).toEqual({
			success: true,
			text: `Elevation approved! You have been granted temporary manage_roles permissions until ${expiryText}.\n\nPlease use these permissions responsibly. All actions will be logged for audit.`,
			data: {
				actionName: "TRUST",
				subaction: "request_elevation",
				approved: true,
				expiresAt,
			},
		});
	});

	test.each([
		[undefined, ""],
		[[], ""],
		[
			["Build more trust", "Try a smaller scope"],
			"\n\nSuggestions:\n- Build more trust\n- Try a smaller scope",
		],
	])("returns a denial with suggestions %j", async (suggestions, suffix) => {
		const { runtime } = createHarness({
			granted: false,
			reason: "insufficient trust",
			suggestions,
		});

		const result = await requestElevationHandler(
			runtime as never,
			message as never,
			undefined,
			{ parameters: { permissionAction: "manage_roles" } },
		);

		expect(result).toEqual({
			success: false,
			text: `Elevation request denied: insufficient trust\n\nYour current trust score is 73/100.${suffix}`,
			data: {
				actionName: "TRUST",
				subaction: "request_elevation",
				approved: false,
				reason: "insufficient trust",
				currentTrust: 73,
			},
		});
	});

	test.each([
		[new Error("permission backend failed"), "permission backend failed"],
		["permission backend failed", "Unknown error"],
	])("translates a rejected elevation request %#", async (failure, error) => {
		const { requestElevation, runtime } = createHarness();
		requestElevation.mockRejectedValue(failure);

		const result = await requestElevationHandler(
			runtime as never,
			message as never,
			undefined,
			{ parameters: { permissionAction: "manage_roles" } },
		);

		expect(result).toEqual({
			success: false,
			text: "Failed to process elevation request. Please try again.",
			error,
			data: { actionName: "TRUST", subaction: "request_elevation" },
		});
	});
});
