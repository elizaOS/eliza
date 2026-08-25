/**
 * Exercises the MESSAGE follow-up action through the real default TriageService
 * and an in-process recording adapter. The suite covers context eligibility,
 * invalid inputs, draft persistence and projection, callback delivery, and
 * adapter failures without a live connector, model, or database.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
	Content,
	HandlerCallback,
	HandlerOptions,
	IAgentRuntime,
	Memory,
	State,
} from "../../../../types/index.ts";
import { createFakeRuntime } from "../__tests__/fake-runtime.ts";
import { BaseMessageAdapter } from "../adapters/base.ts";
import { __resetDefaultMessageRefStoreForTests } from "../message-ref-store.ts";
import {
	__resetDefaultTriageServiceForTests,
	getDefaultTriageService,
} from "../triage-service.ts";
import type { DraftRequest, MessageSource } from "../types.ts";
import { draftFollowupAction } from "./draftFollowup.ts";

class RecordingDraftAdapter extends BaseMessageAdapter {
	readonly source: MessageSource = "telegram";
	lastDraft: DraftRequest | undefined;
	createCount = 0;

	isAvailable(): boolean {
		return true;
	}

	protected createDraftImpl(
		_runtime: IAgentRuntime,
		draft: DraftRequest,
	): Promise<{ draftId: string; preview: string }> {
		this.createCount += 1;
		this.lastDraft = draft;
		return Promise.resolve({
			draftId: "telegram-draft-1",
			preview: `Telegram preview: ${draft.body}`,
		});
	}
}

const message = { content: { text: "Draft a follow-up" } } as Memory;

function options(parameters: Record<string, unknown>): HandlerOptions {
	return { parameters } as HandlerOptions;
}

function stateFor(primaryContext: string): State {
	return {
		values: { __contextRouting: { primaryContext } },
		data: {},
		text: "",
	};
}

describe("draftFollowupAction", () => {
	beforeEach(() => {
		__resetDefaultMessageRefStoreForTests();
		__resetDefaultTriageServiceForTests();
	});

	afterEach(() => {
		__resetDefaultTriageServiceForTests();
		__resetDefaultMessageRefStoreForTests();
	});

	it("is eligible only when the turn has a supported messaging context", async () => {
		await expect(
			draftFollowupAction.validate?.(
				createFakeRuntime(),
				message,
				stateFor("messaging"),
			),
		).resolves.toBe(true);
		await expect(
			draftFollowupAction.validate?.(
				createFakeRuntime(),
				message,
				stateFor("payments"),
			),
		).resolves.toBe(false);
	});

	it.each([
		[
			"unsupported source",
			{ source: "slack", to: ["alice"], body: "Hello" },
			"source must be one of the supported message sources",
		],
		["missing body", { source: "telegram", to: ["alice"] }, "body is required"],
		[
			"empty recipient list",
			{ source: "telegram", to: [" ", { name: "No handle" }], body: "Hello" },
			"to (at least one recipient) is required",
		],
	])(
		"rejects %s before creating or delivering a draft",
		async (_label, params, error) => {
			const adapter = new RecordingDraftAdapter();
			getDefaultTriageService().register(adapter);
			const delivered: Content[] = [];
			const callback: HandlerCallback = async (content) => {
				delivered.push(content);
				return [];
			};

			const result = await draftFollowupAction.handler(
				createFakeRuntime(),
				message,
				undefined,
				options(params),
				callback,
			);

			expect(result).toEqual({ success: false, text: error, error });
			expect(adapter.createCount).toBe(0);
			expect(delivered).toEqual([]);
		},
	);

	it("creates and persists a multi-recipient draft, then delivers its preview", async () => {
		const adapter = new RecordingDraftAdapter();
		const service = getDefaultTriageService();
		service.register(adapter);
		const delivered: Content[] = [];
		const callback: HandlerCallback = async (content) => {
			delivered.push(content);
			return [];
		};

		const result = await draftFollowupAction.handler(
			createFakeRuntime(),
			message,
			undefined,
			options({
				source: " TELEGRAM ",
				to: [" alice ", { handle: "bob", name: "Bob" }, ""],
				body: " Checking in ",
				subject: " Project status ",
				threadId: " thread-7 ",
			}),
			callback,
		);

		expect(adapter.lastDraft).toEqual({
			source: "telegram",
			to: [{ identifier: "alice" }, { identifier: "bob", displayName: "Bob" }],
			subject: "Project status",
			body: "Checking in",
			threadId: "thread-7",
		});
		expect(result).toEqual({
			success: true,
			text: "Drafted follow-up on telegram. Preview: Telegram preview: Checking in",
			data: {
				draftId: "telegram-draft-1",
				source: "telegram",
				preview: "Telegram preview: Checking in",
				to: ["alice", "bob"],
			},
		});
		expect(delivered).toEqual([
			{
				text: "Drafted follow-up on telegram. Preview: Telegram preview: Checking in",
				action: "MESSAGE",
			},
		]);
		expect(service.getStore().getDraft("telegram-draft-1")).toMatchObject({
			draftId: "telegram-draft-1",
			source: "telegram",
			to: [{ identifier: "alice" }, { identifier: "bob", displayName: "Bob" }],
			body: "Checking in",
			preview: "Telegram preview: Checking in",
			sent: false,
		});
	});

	it("supports a single recipient and body alias without a callback", async () => {
		const adapter = new RecordingDraftAdapter();
		getDefaultTriageService().register(adapter);

		const result = await draftFollowupAction.handler(
			createFakeRuntime(),
			message,
			undefined,
			options({ source: "telegram", to: "alice", text: "Hello" }),
		);

		expect(result?.success).toBe(true);
		expect(result?.data?.to).toEqual(["alice"]);
		expect(adapter.lastDraft).toEqual({
			source: "telegram",
			to: [{ identifier: "alice" }],
			subject: undefined,
			body: "Hello",
			threadId: undefined,
		});
	});

	it("propagates the real service error when no source adapter is registered", async () => {
		await expect(
			draftFollowupAction.handler(
				createFakeRuntime(),
				message,
				undefined,
				options({ source: "gmail", to: ["alice"], body: "Hello" }),
			),
		).rejects.toThrow('No adapter registered for source "gmail"');
	});
});
