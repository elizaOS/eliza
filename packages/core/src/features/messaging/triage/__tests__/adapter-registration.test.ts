import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IAgentRuntime } from "../../../../types/index.ts";
import { BaseMessageAdapter } from "../adapters/base.ts";
import { __resetDefaultMessageRefStoreForTests } from "../message-ref-store.ts";
import {
	__resetDefaultTriageServiceForTests,
	getDefaultTriageService,
} from "../triage-service.ts";
import type {
	ListOptions,
	MessageRef,
	MessageSource,
} from "../types.ts";
import { createFakeRuntime } from "./fake-runtime.ts";

/**
 * Mirrors what a connector plugin does at init: define an adapter for its own
 * source and register it into the shared TriageService. Core no longer ships
 * any connector-named adapters — they live in their owning plugins and register
 * themselves. These tests pin that contract.
 */
class TestConnectorAdapter extends BaseMessageAdapter {
	readonly source: MessageSource = "discord";

	isAvailable(runtime: IAgentRuntime): boolean {
		return runtime.getService("discord") != null;
	}

	protected async listMessagesImpl(
		_runtime: IAgentRuntime,
		_opts: ListOptions,
	): Promise<MessageRef[]> {
		return [
			{
				id: "discord:1",
				source: "discord",
				externalId: "1",
				from: { identifier: "u1" },
				to: [],
				snippet: "hi",
				receivedAtMs: 1_000,
				hasAttachments: false,
				isRead: false,
			},
		];
	}
}

describe("triage adapter registration", () => {
	beforeEach(() => {
		__resetDefaultTriageServiceForTests();
		__resetDefaultMessageRefStoreForTests();
	});

	afterEach(() => {
		__resetDefaultTriageServiceForTests();
		__resetDefaultMessageRefStoreForTests();
	});

	it("pre-registers no connector adapters in core", () => {
		const service = getDefaultTriageService();
		expect(service.listRegisteredSources()).toEqual([]);
		expect(service.getAdapter("discord")).toBeUndefined();
		expect(service.getAdapter("gmail")).toBeUndefined();
	});

	it("resolves an adapter registered the way a connector plugin does", async () => {
		const service = getDefaultTriageService();
		service.register(new TestConnectorAdapter());

		expect(service.listRegisteredSources()).toEqual(["discord"]);
		expect(service.getAdapter("discord")).toBeInstanceOf(TestConnectorAdapter);

		const runtime = createFakeRuntime({
			availableServices: new Set(["discord"]),
		});
		const refs = await service.triage(runtime, { sources: ["discord"] });
		expect(refs.map((r) => r.id)).toEqual(["discord:1"]);
	});

	it("skips a source with no registered adapter instead of throwing", async () => {
		const service = getDefaultTriageService();
		const runtime = createFakeRuntime();
		await expect(
			service.triage(runtime, { sources: ["telegram"] }),
		).resolves.toEqual([]);
	});
});
