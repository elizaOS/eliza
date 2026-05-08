import { beforeEach, describe, expect, it } from "vitest";

import { listInboxAction } from "../actions/listInbox.ts";
import {
	__resetDefaultMessageRefStoreForTests,
	getDefaultMessageRefStore,
} from "../message-ref-store.ts";
import { __resetDefaultTriageServiceForTests } from "../triage-service.ts";
import type { MessageRef } from "../types.ts";
import { createFakeRuntime } from "./fake-runtime.ts";

function messageRef(overrides: Partial<MessageRef>): MessageRef {
	return {
		id: "msg",
		source: "gmail",
		externalId: "external-msg",
		from: { identifier: "alice@example.com" },
		to: [{ identifier: "owner@example.com" }],
		snippet: "hello",
		receivedAtMs: 1_000,
		hasAttachments: false,
		isRead: false,
		...overrides,
	};
}

describe("listInboxAction", () => {
	beforeEach(() => {
		__resetDefaultMessageRefStoreForTests();
		__resetDefaultTriageServiceForTests();
	});

	it("filters cached unread messages to the requested sources", async () => {
		getDefaultMessageRefStore().saveMessages([
			messageRef({
				id: "gmail-1",
				source: "gmail",
				externalId: "gmail-external-1",
				snippet: "gmail hit",
				receivedAtMs: 3_000,
			}),
			messageRef({
				id: "discord-1",
				source: "discord",
				externalId: "discord-external-1",
				snippet: "discord miss",
				receivedAtMs: 2_000,
			}),
			messageRef({
				id: "signal-1",
				source: "signal",
				externalId: "signal-external-1",
				snippet: "signal hit",
			}),
		]);

		const result = await listInboxAction.handler(
			createFakeRuntime(),
			messageRef({ id: "turn", source: "gmail" }) as never,
			undefined,
			{ parameters: { sources: ["gmail", "signal"] } } as never,
		);

		expect(result.success).toBe(true);
		expect(result.data).toMatchObject({ total: 2, returned: 2 });
		expect(
			(result.data?.messages as Array<{ id: string }>).map((message) => message.id),
		).toEqual(["gmail-1", "signal-1"]);
	});
});
