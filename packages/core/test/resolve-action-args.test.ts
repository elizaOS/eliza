/** Umbrella arg resolution must trust merged params over the extractor's stale missing list. */
import { describe, expect, it, vi } from "vitest";
import { resolveActionArgs } from "../src/actions/resolve-action-args";
import type { Memory } from "../src/types/memory";
import type { UUID } from "../src/types/primitives";
import type { IAgentRuntime } from "../src/types/runtime";

const subactions = {
	update: {
		description: "Update a note",
		descriptionCompressed: "Update a note",
		required: ["title", "body"],
	},
} as const;

function fakeRuntime(extractionJson: string) {
	return {
		useModel: vi.fn(async () => extractionJson),
		reportError: vi.fn(),
		logger: {
			warn: vi.fn(),
			info: vi.fn(),
			debug: vi.fn(),
			error: vi.fn(),
		},
	} as unknown as IAgentRuntime;
}

const message = {
	id: "44444444-4444-4444-8444-444444444444" as UUID,
	entityId: "33333333-3333-4333-8333-333333333333" as UUID,
	roomId: "22222222-2222-4222-8222-222222222222" as UUID,
	content: { text: "Update the note body to World" },
} as Memory;

describe("resolveActionArgs planner-supplied params", () => {
	it("resolves when the extractor lists a planner-supplied field as missing", async () => {
		// The planner supplied `title`; the extractor never sees planner params,
		// so it extracts `body` and still lists `title` as missing. The merged
		// params satisfy every required field, so this must resolve.
		const runtime = fakeRuntime(
			JSON.stringify({
				action: "update",
				params: { body: "World" },
				missing: ["title"],
				confidence: 0.9,
			}),
		);
		const result = await resolveActionArgs({
			runtime,
			message,
			actionName: "NOTE",
			subactions,
			options: { parameters: { action: "update", title: "Hello" } },
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.subaction).toBe("update");
			expect(result.params).toEqual({ title: "Hello", body: "World" });
		}
	});

	it("still fails when a required field is genuinely missing", async () => {
		const runtime = fakeRuntime(
			JSON.stringify({
				action: "update",
				params: {},
				missing: ["body"],
				confidence: 0.9,
			}),
		);
		const result = await resolveActionArgs({
			runtime,
			message,
			actionName: "NOTE",
			subactions,
			options: { parameters: { action: "update", title: "Hello" } },
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.missing).toEqual(["body"]);
		}
	});
});
