/**
 * Per-source failure isolation in TriageService.triage() / search().
 *
 * Regression: a single adapter throwing (e.g. the pre-implementation Discord
 * stub's NotYetImplementedError) aborted the entire cross-connector sweep,
 * so "triage my messages" died even when other connectors were healthy.
 * The service now degrades per-source and only rethrows when failures leave
 * zero results overall (a broken sweep must not masquerade as an empty inbox).
 */

import { describe, expect, it } from "vitest";
import { ElizaError } from "../../../../errors.ts";
import type { IAgentRuntime } from "../../../../types/index.ts";
import { BaseMessageAdapter } from "../adapters/base.ts";
import { MessageRefStore } from "../message-ref-store.ts";
import {
	CONNECTOR_NOT_CONNECTED,
	isConnectorNotConnectedError,
	TriageService,
} from "../triage-service.ts";
import {
	type ListOptions,
	type MessageAdapterCapabilities,
	type MessageRef,
	type MessageSource,
	NotYetImplementedError,
} from "../types.ts";
import { createFakeRuntime } from "./fake-runtime.ts";

function ref(source: MessageSource, id: string): MessageRef {
	return {
		id: `${source}:${id}`,
		source,
		externalId: id,
		from: { identifier: "someone@example.com" },
		to: [],
		snippet: `hello from ${source}`,
		receivedAtMs: Date.now(),
		hasAttachments: false,
		isRead: false,
	};
}

class HealthyAdapter extends BaseMessageAdapter {
	constructor(
		readonly source: MessageSource,
		private readonly refs: MessageRef[],
	) {
		super();
	}
	isAvailable(): boolean {
		return true;
	}
	capabilities(): MessageAdapterCapabilities {
		return {
			list: true,
			search: false,
			manage: {},
			send: {},
			worlds: "single",
			channels: "none",
		};
	}
	protected listMessagesImpl(
		_runtime: IAgentRuntime,
		_opts: ListOptions,
	): Promise<MessageRef[]> {
		return Promise.resolve(this.refs);
	}
}

/** Available but unimplemented — the exact shape of the old Discord stub. */
class ThrowingAdapter extends BaseMessageAdapter {
	constructor(readonly source: MessageSource) {
		super();
	}
	isAvailable(): boolean {
		return true;
	}
}

describe("TriageService per-source failure isolation", () => {
	it("triage() returns healthy-source results when another source throws", async () => {
		const service = new TriageService(new MessageRefStore());
		service.register(new HealthyAdapter("gmail", [ref("gmail", "g1")]));
		service.register(new ThrowingAdapter("discord"));

		const ranked = await service.triage(createFakeRuntime(), {
			sources: ["gmail", "discord"],
		});

		expect(ranked).toHaveLength(1);
		expect(ranked[0].source).toBe("gmail");
	});

	it("triage() rethrows when failures leave zero results", async () => {
		const service = new TriageService(new MessageRefStore());
		service.register(new ThrowingAdapter("discord"));

		await expect(
			service.triage(createFakeRuntime(), { sources: ["discord"] }),
		).rejects.toBeInstanceOf(NotYetImplementedError);
	});

	it("triage() rethrows when the only failure hides behind an honest empty source", async () => {
		const service = new TriageService(new MessageRefStore());
		service.register(new HealthyAdapter("gmail", []));
		service.register(new ThrowingAdapter("discord"));

		await expect(
			service.triage(createFakeRuntime(), { sources: ["gmail", "discord"] }),
		).rejects.toBeInstanceOf(NotYetImplementedError);
	});

	it("triage() with only empty healthy sources resolves to []", async () => {
		const service = new TriageService(new MessageRefStore());
		service.register(new HealthyAdapter("gmail", []));

		await expect(
			service.triage(createFakeRuntime(), { sources: ["gmail"] }),
		).resolves.toEqual([]);
	});

	it("search() returns healthy-source hits when another source throws", async () => {
		const service = new TriageService(new MessageRefStore());
		service.register(new HealthyAdapter("gmail", [ref("gmail", "g2")]));
		service.register(new ThrowingAdapter("discord"));

		const hits = await service.search(createFakeRuntime(), {
			sources: ["gmail", "discord"],
			content: "hello",
		});

		expect(hits).toHaveLength(1);
		expect(hits[0].source).toBe("gmail");
	});

	it("search() rethrows when failures leave zero hits", async () => {
		const service = new TriageService(new MessageRefStore());
		service.register(new ThrowingAdapter("discord"));

		await expect(
			service.search(createFakeRuntime(), {
				sources: ["discord"],
				content: "hello",
			}),
		).rejects.toBeInstanceOf(NotYetImplementedError);
	});
});

/**
 * The connector's steady "nothing connected" state, discovered at time of use:
 * `isAvailable` answers only "is the plugin's service registered", so an
 * enabled-but-never-connected connector throws CONNECTOR_NOT_CONNECTED from
 * inside the read. That source must classify as unavailable — not as a warned
 * failure — while a sweep of only such sources still surfaces the honest cause
 * instead of presenting "not connected" as an empty inbox.
 */
class NotConnectedAdapter extends BaseMessageAdapter {
	constructor(readonly source: MessageSource) {
		super();
	}
	isAvailable(): boolean {
		return true;
	}
	capabilities(): MessageAdapterCapabilities {
		return {
			list: true,
			search: false,
			manage: {},
			send: {},
			worlds: "single",
			channels: "none",
		};
	}
	protected listMessagesImpl(): Promise<MessageRef[]> {
		throw new ElizaError("No Google account is connected.", {
			code: CONNECTOR_NOT_CONNECTED,
		});
	}
}

describe("TriageService not-connected classification", () => {
	it("files a not-connected source under unavailable, not failed", async () => {
		const service = new TriageService(new MessageRefStore());
		service.register(new HealthyAdapter("discord", [ref("discord", "d1")]));
		service.register(new NotConnectedAdapter("gmail"));

		const { refs, receipt } = await service.triageWithReceipt(
			createFakeRuntime(),
			{ sources: ["discord", "gmail"] },
		);

		expect(refs).toHaveLength(1);
		expect(receipt.unavailable).toEqual(["gmail"]);
		expect(receipt.failed).toEqual([]);
		expect(receipt.succeeded).toEqual(["discord"]);
	});

	it("surfaces the typed cause when the only requested source is not connected", async () => {
		const service = new TriageService(new MessageRefStore());
		service.register(new NotConnectedAdapter("gmail"));

		const attempt = service.triage(createFakeRuntime(), {
			sources: ["gmail"],
		});
		await expect(attempt).rejects.toSatisfy((error: unknown) =>
			isConnectorNotConnectedError(error),
		);
	});

	it("search() classifies a not-connected source the same way", async () => {
		const service = new TriageService(new MessageRefStore());
		service.register(new HealthyAdapter("discord", [ref("discord", "d2")]));
		service.register(new NotConnectedAdapter("gmail"));

		const { refs, receipt } = await service.searchWithReceipt(
			createFakeRuntime(),
			{ sources: ["discord", "gmail"], content: "hello" },
		);

		expect(refs).toHaveLength(1);
		expect(receipt.unavailable).toContain("gmail");
		expect(receipt.failed).toEqual([]);
	});
});
