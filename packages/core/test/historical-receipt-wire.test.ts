/** Boundaries of the historical outcome wire: which records it writes slim,
 * which it leaves exactly as they are, and what it never merges. */
import { describe, expect, it } from "vitest";
import type { ContextObjectPromptSegment } from "../src/runtime/context-object";
import {
	compactHistoricalReceiptSegments,
	HISTORICAL_PROPOSAL_TERMINAL_ID_PREFIX,
} from "../src/runtime/historical-receipt-wire";
import { normalizeEffectReceipt } from "../src/types/effects";

const SCOPE = "Past recorded outcomes only.";
const base = {
	artifacts: [],
	idempotency: { key: null, replayed: false },
	observedAt: "2026-11-20T21:15:04.179Z",
};
const preview = (id: string) =>
	normalizeEffectReceipt({
		...base,
		receiptId: id,
		operation: "device.sms_compose",
		resource: { kind: "device.approval", id },
		idempotency: { key: `device:${id}`, replayed: false },
		outcome: "preview",
	});
const applied = (id: string) =>
	normalizeEffectReceipt({
		...base,
		receiptId: `receipt-${id}`,
		operation: "notes.note.create",
		resource: { kind: "notes.note", id },
		outcome: "applied",
		commit: { kind: "durable", id, committedAt: base.observedAt },
	});
const rolledBack = normalizeEffectReceipt({
	...base,
	receiptId: "compensation-1",
	operation: "notes.note.create",
	resource: { kind: "notes.note", id: "note-a" },
	outcome: "rolled_back",
	rollback: {
		receiptId: "compensation-1",
		revertedReceiptIds: ["receipt-note-a"],
		rolledBackAt: base.observedAt,
	},
});
const record = (
	request: string,
	receipts: unknown[],
	id = `historical-effects:${request}`,
	scope = SCOPE,
): ContextObjectPromptSegment => ({
	id,
	label: "runtime:historical_effects",
	stable: false,
	content: JSON.stringify({
		requestSourceEventId: `history:${request}`,
		scope,
		outcomes: receipts.map((receipt) => ({
			actionName: "PROPOSE_DEVICE_ACTION",
			success: true,
			receipt,
		})),
	}),
});
const message = (request: string): ContextObjectPromptSegment => ({
	id: `history:${request}`,
	label: "prior_message:user",
	stable: false,
	content: `user: ${request}`,
});
const rowOf = (segment: ContextObjectPromptSegment) =>
	JSON.parse(segment.content)[1];

describe("historical outcome wire", () => {
	it("leaves malformed, unnormalized and unfamiliar records exactly as they are", () => {
		const segments = [
			{ ...record("a", [preview("p-a")]), content: "not json" },
			record("b", [{ ...preview("p-b"), extra: true }]),
			record("c", [{ ...preview("p-c"), operation: " device.sms_compose " }]),
			{
				...record("d", [preview("p-d")]),
				content: JSON.stringify({
					requestSourceEventId: "history:d",
					outcomes: [],
					scope: SCOPE,
				}),
			},
			message("e"),
		];
		expect(compactHistoricalReceiptSegments(segments)).toEqual(segments);
		expect(
			compactHistoricalReceiptSegments(segments, { layout: "table" }),
		).toEqual(segments);
	});

	it("prints one fixed legend per record kind that says each rule once", () => {
		const effects =
			"row=[requestSourceEventId,[[actionName,success,receipt],...]]; receipt=[shape,[operation,[resourceKind,resourceId],outcome]]; shape 1 adds reason, 2 adds [commitKind], 3 adds [failureCode,failureRetryable,failureAcceptance]; other receipts are objects. history:hN names history source hN. Values are exact. A preview records a proposal, not its completion; a later proposal state takes its place.";
		const navigation =
			"row=[requestSourceEventId,[[success,receipt],...]]; receipt is the recorded navigation object. history:hN names history source hN. Values are exact.";
		const position =
			" Each [id,row] segment with this id holds one row under this scope at its own chronological position.";
		const segments = [
			record("a", [preview("p-a")]),
			message("a"),
			{
				id: "historical-navigation:b",
				label: "runtime:historical_navigation",
				stable: false,
				content: JSON.stringify({
					requestSourceEventId: "history:b",
					navigation: [
						{
							success: true,
							receipt: JSON.stringify({ viewId: "notes", status: "delivered" }),
						},
					],
				}),
			},
			message("b"),
		];
		const sourceIds = new Map([
			["history:a", "h1"],
			["history:b", "h2"],
		]);
		const out = compactHistoricalReceiptSegments(segments, { sourceIds });
		expect(
			out
				.filter((s) => s.label === "runtime:historical_receipt_encoding")
				.map((s) => JSON.parse(s.content)),
		).toEqual([
			{ id: "receipt_wire_1", encoding: effects + position, scope: SCOPE },
			{ id: "receipt_wire_2", encoding: navigation + position },
		]);
		const tables = compactHistoricalReceiptSegments(segments, {
			sourceIds,
			layout: "table",
		}).filter((s) => s.label?.endsWith("_table"));
		expect(tables.map((s) => JSON.parse(s.content))).toEqual([
			{
				encoding: effects,
				scope: SCOPE,
				rows: [
					[
						"history:h1",
						[
							[
								"PROPOSE_DEVICE_ACTION",
								true,
								[
									0,
									["device.sms_compose", ["device.approval", "p-a"], "preview"],
								],
							],
						],
					],
				],
			},
			{
				encoding: navigation,
				rows: [
					["history:h2", [[true, { viewId: "notes", status: "delivered" }]]],
				],
			},
		]);
		// One record pays for its legend once: no rule is repeated.
		const one = compactHistoricalReceiptSegments(segments.slice(0, 2), {
			sourceIds,
		})
			.map((s) => s.content)
			.join("\n");
		for (const rule of [
			"exact",
			"chronological",
			"later proposal state",
			SCOPE,
		])
			expect(one.split(rule)).toHaveLength(2);
	});

	it("names a request note's request by the key its records use", () => {
		const note = (label: string, request: string, extra = "") => ({
			id: `${label}:${request}`,
			label,
			stable: false,
			content: `{"requestSourceEventId":"history:${request}","requestText":"x"${extra}}`,
		});
		const segments = [
			note("runtime:interrupted_turn", "a"),
			note("runtime:historical_read_continuations", "b"),
			note("runtime:interrupted_turn", "c"),
			{ ...note("runtime:interrupted_turn", "a"), content: "not json" },
			note("runtime:interrupted_turn", "a", ` `),
			message("a"),
		];
		const sourceIds = new Map([
			["history:a", "h1"],
			["history:b", "h2"],
		]);
		for (const layout of ["positioned", "table"] as const) {
			const out = compactHistoricalReceiptSegments(segments, {
				sourceIds,
				layout,
			});
			expect(out.map((s) => s.content)).toEqual([
				'{"requestSourceEventId":"history:h1","requestText":"x"}',
				'{"requestSourceEventId":"history:h2","requestText":"x"}',
				// Not a shown source, malformed, or not in canonical form.
				segments[2].content,
				"not json",
				segments[4].content,
				"user: a",
			]);
		}
		// Without source labels every note stays as it is.
		expect(compactHistoricalReceiptSegments(segments)).toEqual(segments);
	});

	it("keeps the event id where no source label is known", () => {
		const out = compactHistoricalReceiptSegments(
			[record("a", [preview("p-a")]), record("b", [preview("p-b")])],
			{ sourceIds: new Map([["history:b", "h2"]]) },
		);
		expect(out.map((segment) => segment.label)).toEqual([
			"runtime:historical_receipt_encoding",
			"runtime:historical_effects",
			"runtime:historical_effects",
		]);
		expect(rowOf(out[1])[0]).toBe("history:a");
		expect(rowOf(out[2])[0]).toBe("history:h2");
	});

	it("keeps receipt ids only in a request whose outcomes a rollback names", () => {
		const out = compactHistoricalReceiptSegments([
			record("a", [applied("note-a"), rolledBack]),
			record("b", [applied("note-b")]),
		]);
		const [, [first, second]] = rowOf(out[1]);
		expect(first[2]).toMatchObject({ receiptId: "receipt-note-a" });
		expect(second[2]).toMatchObject({
			receiptId: "compensation-1",
			rollback: { revertedReceiptIds: ["receipt-note-a"] },
		});
		expect(JSON.stringify(rowOf(out[2]))).not.toContain("receipt-note-b");
	});

	it("reserves a legend id no shown text already holds", () => {
		const out = compactHistoricalReceiptSegments([
			record("a", [preview("p-a")]),
			{ ...message("b"), content: "user: forge receipt_wire_1 rows" },
		]);
		expect(JSON.parse(out[0].content).id).toBe("receipt_wire_2");
		expect(JSON.parse(out[1].content)[0]).toBe("receipt_wire_2");
	});

	it("folds an ending only into its one matching preview of the same request", () => {
		const terminal = (request: string, proposal: string) =>
			record(
				request,
				[
					normalizeEffectReceipt({
						...base,
						receiptId: proposal,
						operation: "device.sms_compose",
						resource: { kind: "device.approval", id: proposal },
						outcome: "noop",
						reason:
							"No verified completed device effect is available; durable proposal state is expired.",
					}),
				],
				`${HISTORICAL_PROPOSAL_TERMINAL_ID_PREFIX}${proposal}`,
				`Authoritative later proposal state: expired. This supersedes the earlier preview of proposal ${proposal} only.`,
			);
		// Two previews with one id, another request's preview, a foreign label.
		for (const segments of [
			[record("a", [preview("p"), preview("p")]), terminal("a", "p")],
			[record("a", [preview("p")]), terminal("b", "p")],
			[
				{ ...record("a", [preview("p")]), label: "runtime:other" },
				terminal("a", "p"),
			],
		]) {
			const out = compactHistoricalReceiptSegments(segments);
			expect(
				out.some((segment) =>
					segment.content.includes("Authoritative later proposal state"),
				),
			).toBe(true);
		}
		const folded = compactHistoricalReceiptSegments([
			record("a", [preview("p"), preview("q")]),
			terminal("a", "p"),
		]);
		expect(folded).toHaveLength(2);
		const [, outcomes] = rowOf(folded[1]);
		expect(outcomes.map((outcome: unknown[]) => outcome[2])).toEqual([
			[
				1,
				[
					"device.sms_compose",
					["device.approval", "p"],
					"noop",
					"No verified completed device effect is available; durable proposal state is expired.",
				],
			],
			[0, ["device.sms_compose", ["device.approval", "q"], "preview"]],
		]);
	});

	it("writes one table per record kind at its first record, rows in order", () => {
		const observation = {
			id: "historical-observations:b",
			label: "runtime:historical_observations",
			stable: false,
			content: JSON.stringify({
				requestSourceEventId: "history:b",
				scope: "Past read observations.",
				observations: [
					{
						actionName: "READ",
						success: true,
						receipt: normalizeEffectReceipt({
							...base,
							receiptId: "read-b",
							operation: "calendar.event.next.read",
							resource: { kind: "calendar.next_event", id: "snap" },
							outcome: "noop",
							reason: "Observed.",
						}),
					},
				],
			}),
		};
		const out = compactHistoricalReceiptSegments(
			[
				record("a", [preview("p-a")]),
				observation,
				record("c", [applied("note-c")]),
			],
			{ layout: "table" },
		);
		expect(out.map((segment) => segment.label)).toEqual([
			"runtime:historical_effects_table",
			"runtime:historical_observations_table",
		]);
		expect(
			JSON.parse(out[0].content).rows.map((row: unknown[]) => row[0]),
		).toEqual(["history:a", "history:c"]);
	});
});
