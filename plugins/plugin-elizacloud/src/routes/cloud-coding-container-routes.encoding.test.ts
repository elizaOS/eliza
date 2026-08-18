/** Exercises cloud coding-container sync identifier decoding before service dispatch. */
import type http from "node:http";
import { describe, expect, it, vi } from "vitest";

const CLOUD_CONTAINER_SERVICE_TYPE = "cloud-container-service";

vi.mock("@elizaos/shared", () => ({
	CLOUD_CONTAINER_SERVICE_TYPE,
	PromoteVfsToCloudContainerRequestSchema: {
		safeParse: (body: unknown) => ({ success: true, data: body }),
	},
	RequestCodingAgentContainerRequestSchema: {
		safeParse: (body: unknown) => ({ success: true, data: body }),
	},
	SyncCloudCodingContainerRequestSchema: {
		safeParse: (body: unknown) => ({ success: true, data: body }),
	},
}));

const { handleCloudCodingContainerRoute } = await import(
	"./cloud-coding-container-routes"
);

function requestWithBody(body: unknown): http.IncomingMessage {
	return {
		body,
		headers: {},
		method: "POST",
		url: "/",
	} as http.IncomingMessage & { body: unknown };
}

function responseSink(): http.ServerResponse & { jsonBody: () => unknown } {
	let body = "";
	const sink = {
		headersSent: false,
		statusCode: 200,
		setHeader: () => {},
		end: (chunk?: unknown) => {
			body = typeof chunk === "string" ? chunk : String(chunk ?? "");
			sink.headersSent = true;
			return {} as http.ServerResponse;
		},
		jsonBody: () => JSON.parse(body),
	};
	return sink as http.ServerResponse & { jsonBody: () => unknown };
}

function unusedService() {
	return {
		promoteVfsToCloudContainer: vi.fn(async () => {
			throw new Error("unexpected promote");
		}),
		requestCodingAgentContainer: vi.fn(async () => {
			throw new Error("unexpected request");
		}),
		syncCodingContainerChanges: vi.fn(async () => {
			throw new Error("unexpected sync");
		}),
	};
}

describe("POST /api/cloud/coding-containers/:id/sync encoding", () => {
	it("canonical container id still reaches sync", async () => {
		let capturedContainerId: string | null = null;
		const service = {
			...unusedService(),
			syncCodingContainerChanges: vi.fn(
				async (containerId: string, request: Record<string, unknown>) => {
					capturedContainerId = containerId;
					return {
						success: true,
						data: { syncId: "sync-1", containerId, request },
					};
				},
			),
		};
		const runtime = { getService: () => service };
		const response = responseSink();

		await handleCloudCodingContainerRoute(
			requestWithBody({
				direction: "pull",
				target: {
					sourceKind: "workspace",
					workspaceId: "workspace-1",
					baseRevision: "rev-1",
				},
			}),
			response,
			"/api/cloud/coding-containers/container-1/sync",
			"POST",
			{ runtime: runtime as never },
		);

		expect(capturedContainerId).toBe("container-1");
		expect(service.syncCodingContainerChanges).toHaveBeenCalledTimes(1);
		expect(response.statusCode).toBe(200);
	});

	it("canonical percent-encoded slash still decodes before sync", async () => {
		let capturedContainerId: string | null = null;
		const service = {
			...unusedService(),
			syncCodingContainerChanges: vi.fn(async (containerId: string) => {
				capturedContainerId = containerId;
				return { success: true, data: { containerId } };
			}),
		};
		const runtime = { getService: () => service };
		const response = responseSink();

		await handleCloudCodingContainerRoute(
			requestWithBody({
				direction: "pull",
				target: {
					sourceKind: "workspace",
					workspaceId: "workspace-1",
					baseRevision: "rev-1",
				},
			}),
			response,
			"/api/cloud/coding-containers/container%2Fone/sync",
			"POST",
			{ runtime: runtime as never },
		);

		expect(capturedContainerId).toBe("container/one");
		expect(service.syncCodingContainerChanges).toHaveBeenCalledTimes(1);
	});

	it("POST promotions is untouched", async () => {
		const service = unusedService();
		service.promoteVfsToCloudContainer = vi.fn(async () => ({
			success: true,
			data: { promotionId: "promo-1" },
		}));
		const runtime = {
			getService: (serviceType: string) =>
				serviceType === CLOUD_CONTAINER_SERVICE_TYPE ? service : null,
		};
		const response = responseSink();

		const handled = await handleCloudCodingContainerRoute(
			requestWithBody({
				source: { sourceKind: "project", projectId: "vfs-project-1" },
			}),
			response,
			"/api/cloud/coding-containers/promotions",
			"POST",
			{ runtime: runtime as never },
		);

		expect(handled).toBe(true);
		expect(service.syncCodingContainerChanges).not.toHaveBeenCalled();
		expect(service.promoteVfsToCloudContainer).toHaveBeenCalled();
	});

	it.each(["%", "%2", "%ZZ", "%E0%A4"])(
		"rejects malformed container id %s with 400",
		async (token) => {
			const service = unusedService();
			const runtime = { getService: () => service };
			const response = responseSink();

			const handled = await handleCloudCodingContainerRoute(
				requestWithBody({
					direction: "pull",
					target: {
						sourceKind: "workspace",
						workspaceId: "workspace-1",
						baseRevision: "rev-1",
					},
				}),
				response,
				`/api/cloud/coding-containers/${token}/sync`,
				"POST",
				{ runtime: runtime as never },
			);

			expect(handled).toBe(true);
			expect(response.statusCode).toBe(400);
			expect(response.jsonBody()).toEqual({
				error: "Invalid container id: malformed URL encoding",
			});
			expect(service.syncCodingContainerChanges).not.toHaveBeenCalled();
		},
	);
});
