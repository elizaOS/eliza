/** Exercises Android notification identifier decoding through the UDS route harness. */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { IAgentRuntime } from "@elizaos/core";

const list = mock(() => []);
const getUnreadCount = mock(() => 0);
const markRead = mock(async (_id: string) => true);
const markAllRead = mock(async () => 1);
const remove = mock(async (_id: string) => true);
const clear = mock(async () => undefined);

mock.module("@elizaos/core", () => ({
	NotificationService: {
		getAvailability: () => "ready",
		requestRecovery: () => ({ retryAfterSeconds: 1 }),
	},
	ServiceType: { NOTIFICATION: "notification" },
}));
mock.module("@elizaos/shared", () => ({
	readAliasedEnv: () => undefined,
}));

const { dispatchBufferedRequest } = await import("./dispatch.ts");

function runtimeWithNotifier(): IAgentRuntime {
	return {
		getService: () => ({
			list,
			getUnreadCount,
			markRead,
			markAllRead,
			remove,
			clear,
		}),
	} as unknown as IAgentRuntime;
}

const dispatchRoute = async () => {
	throw new Error("dispatchRoute must not run on notification encoding");
};

async function request(method: string, path: string) {
	return dispatchBufferedRequest(runtimeWithNotifier(), dispatchRoute, {
		method,
		path,
	});
}

describe("android notification id encoding", () => {
	beforeEach(() => {
		list.mockClear();
		getUnreadCount.mockClear();
		markRead.mockClear();
		markAllRead.mockClear();
		remove.mockClear();
		clear.mockClear();
	});

	test("canonical mark-read still reaches the notification store", async () => {
		const response = await request("POST", "/api/notifications/notif-1/read");
		expect(response.status).toBe(200);
		expect(JSON.parse(response.body)).toEqual({ ok: true });
		expect(markRead).toHaveBeenCalledWith("notif-1");
	});

	test("canonical percent-encoded hyphen still decodes before mark-read", async () => {
		const response = await request("POST", "/api/notifications/notif%2D1/read");
		expect(response.status).toBe(200);
		expect(markRead).toHaveBeenCalledWith("notif-1");
	});

	test("canonical delete still reaches the notification store", async () => {
		const response = await request("DELETE", "/api/notifications/notif-1");
		expect(response.status).toBe(200);
		expect(JSON.parse(response.body)).toEqual({ ok: true });
		expect(remove).toHaveBeenCalledWith("notif-1");
	});

	test.each(["%", "%2", "%ZZ", "%E0%A4"])(
		"rejects malformed mark-read id %s with 400 before store lookup",
		async (token) => {
			const response = await request(
				"POST",
				`/api/notifications/${token}/read`,
			);
			expect(response.status).toBe(400);
			expect(JSON.parse(response.body)).toEqual({
				error: "Invalid notification id: malformed URL encoding",
			});
			expect(markRead).not.toHaveBeenCalled();
		},
	);

	test.each(["%", "%2", "%ZZ"])(
		"rejects malformed delete id %s with 400 before store lookup",
		async (token) => {
			const response = await request("DELETE", `/api/notifications/${token}`);
			expect(response.status).toBe(400);
			expect(JSON.parse(response.body)).toEqual({
				error: "Invalid notification id: malformed URL encoding",
			});
			expect(remove).not.toHaveBeenCalled();
		},
	);

	test("list remains untouched", async () => {
		const response = await request("GET", "/api/notifications");
		expect(response.status).toBe(200);
		expect(list).toHaveBeenCalled();
		expect(markRead).not.toHaveBeenCalled();
		expect(remove).not.toHaveBeenCalled();
	});
});
