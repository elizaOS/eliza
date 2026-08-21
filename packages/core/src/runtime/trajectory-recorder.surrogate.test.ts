/**
 * Unicode integrity for trajectory recorder truncation, pinned against the
 * REAL exports of `./trajectory-recorder.ts` (this file previously re-declared
 * a local copy of the call site, so the production lines were unpinned).
 *
 * Two distinct cuts are covered:
 *  - `applyTrajectoryFieldCap` cuts on a **UTF-8 byte** budget. Decoding a raw
 *    byte slice substitutes U+FFFD REPLACEMENT CHARACTER for a straddled
 *    multi-byte sequence, so the cut must land on a character boundary.
 *  - `truncateRecordString` (reached through `encodeTrajectoryFieldValue`)
 *    cuts on a **UTF-16 code unit** budget and must not split a surrogate pair.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	applyTrajectoryFieldCap,
	captureSkillInvocationIO,
	captureToolStageIO,
	createJsonFileTrajectoryRecorder,
	encodeTrajectoryFieldValue,
	type RecordedStage,
	type RecordedTrajectory,
} from "./trajectory-recorder.ts";

const TRUNCATION_SUFFIX = "...[truncated]";
const SUFFIX_BYTES = Buffer.byteLength(TRUNCATION_SUFFIX, "utf8");
const REPLACEMENT_CHARACTER = "�";
const RECORD_SANITIZE_MAX_STRING_CHARS = 64 * 1024;

const FOX = "\u{1F98A}"; // U+1F98A, 4 UTF-8 bytes / 2 UTF-16 code units
const YEN = "¥"; // 2 UTF-8 bytes
const EURO = "€"; // 3 UTF-8 bytes

function isWellFormed(value: string): boolean {
	return (value as unknown as { isWellFormed(): boolean }).isWellFormed();
}

describe("applyTrajectoryFieldCap byte-budget truncation", () => {
	test("a straddled astral character is dropped, never decoded to U+FFFD", () => {
		// cap 17 => 3-byte slice budget, which lands 3 bytes into a 4-byte fox.
		const { value, marker } = applyTrajectoryFieldCap(
			"output",
			FOX.repeat(50),
			17,
		);
		expect(value).toBe(TRUNCATION_SUFFIX);
		expect(value).not.toContain(REPLACEMENT_CHARACTER);
		expect(marker).toEqual({
			field: "output",
			originalBytes: 200,
			capBytes: 17,
		});
	});

	test("offset x cap sweep never emits U+FFFD, never exceeds the cap, stays well-formed", () => {
		const offending: string[] = [];
		for (let prefix = 0; prefix < 8; prefix++) {
			for (let cap = 15; cap < 120; cap++) {
				const input = `${"a".repeat(prefix)}${FOX.repeat(50)}`;
				const { value } = applyTrajectoryFieldCap("input", input, cap);
				if (
					value.includes(REPLACEMENT_CHARACTER) ||
					Buffer.byteLength(value, "utf8") > cap ||
					!isWellFormed(value)
				) {
					offending.push(`prefix=${prefix} cap=${cap}`);
				}
			}
		}
		expect(offending).toEqual([]);
	});

	test("a whole astral character that still fits is kept intact", () => {
		// cap 18 => 4-byte slice budget: exactly one fox fits.
		const { value } = applyTrajectoryFieldCap("output", FOX.repeat(50), 18);
		expect(value).toBe(`${FOX}${TRUNCATION_SUFFIX}`);
		expect(Buffer.byteLength(value, "utf8")).toBe(18);
	});

	test("ASCII caps to the exact byte budget (no over-rejection)", () => {
		for (const cap of [15, 16, 64, 256, 1024]) {
			const { value } = applyTrajectoryFieldCap(
				"output",
				"a".repeat(4096),
				cap,
			);
			expect(value).toBe(
				`${"a".repeat(cap - SUFFIX_BYTES)}${TRUNCATION_SUFFIX}`,
			);
			expect(Buffer.byteLength(value, "utf8")).toBe(cap);
		}
	});

	test("2-byte and 3-byte BMP text keeps every character that fits", () => {
		for (let cap = 15; cap < 120; cap++) {
			const budget = cap - SUFFIX_BYTES;

			const yen = applyTrajectoryFieldCap("output", YEN.repeat(200), cap).value;
			expect(yen).toBe(
				`${YEN.repeat(Math.floor(budget / 2))}${TRUNCATION_SUFFIX}`,
			);

			const euro = applyTrajectoryFieldCap(
				"output",
				EURO.repeat(200),
				cap,
			).value;
			expect(euro).toBe(
				`${EURO.repeat(Math.floor(budget / 3))}${TRUNCATION_SUFFIX}`,
			);
		}
	});

	test("under-cap values pass through byte-identically with no marker", () => {
		const input = `mixed ${YEN}${EURO}${FOX} text`;
		const { value, marker } = applyTrajectoryFieldCap("input", input, 1024);
		expect(value).toBe(input);
		expect(marker).toBeNull();
	});

	test("a pre-existing lone surrogate becomes exactly one U+FFFD (encoding), and the cap adds none", () => {
		// Buffer encoding of a lone surrogate already yields U+FFFD; the cap must
		// not manufacture a second one at the boundary.
		const input = `\ud800${FOX.repeat(50)}`;
		for (let cap = 15; cap < 120; cap++) {
			const { value } = applyTrajectoryFieldCap("output", input, cap);
			expect(isWellFormed(value)).toBe(true);
			expect(Buffer.byteLength(value, "utf8")).toBeLessThanOrEqual(cap);
			expect(value.split(REPLACEMENT_CHARACTER).length - 1).toBeLessThanOrEqual(
				1,
			);
		}
	});
});

describe("capture seams inherit the byte-cap guarantee", () => {
	test("captureToolStageIO caps input/output/error without corrupting them", () => {
		const captured = captureToolStageIO({
			input: FOX.repeat(400),
			output: FOX.repeat(400),
			error: FOX.repeat(400),
			capBytes: 129,
		});
		for (const field of [captured.input, captured.output, captured.errorText]) {
			expect(field).toBeDefined();
			expect(field).not.toContain(REPLACEMENT_CHARACTER);
			expect(isWellFormed(field as string)).toBe(true);
			expect(Buffer.byteLength(field as string, "utf8")).toBeLessThanOrEqual(
				129,
			);
		}
		expect(captured.truncated).toHaveLength(3);
	});

	test("captureSkillInvocationIO caps args/result without corrupting them", () => {
		const captured = captureSkillInvocationIO({
			args: FOX.repeat(400),
			result: FOX.repeat(400),
			capBytes: 133,
		});
		for (const field of [captured.args, captured.result]) {
			expect(field).not.toContain(REPLACEMENT_CHARACTER);
			expect(isWellFormed(field as string)).toBe(true);
			expect(Buffer.byteLength(field as string, "utf8")).toBeLessThanOrEqual(
				133,
			);
		}
		expect(captured.truncated?.map((m) => m.field).sort()).toEqual([
			"args",
			"result",
		]);
	});
});

describe("persisted trajectory JSON on disk", () => {
	let tmpDir: string;
	const originalLogging = process.env.ELIZA_TRAJECTORY_LOGGING;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "trajectory-surrogate-"));
		// The unified recording gate (#13775) defaults OFF under NODE_ENV=test.
		process.env.ELIZA_TRAJECTORY_LOGGING = "1";
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
		if (originalLogging === undefined) {
			delete process.env.ELIZA_TRAJECTORY_LOGGING;
		} else {
			process.env.ELIZA_TRAJECTORY_LOGGING = originalLogging;
		}
	});

	test("a capped tool-stage output is written to the file without U+FFFD", async () => {
		const recorder = createJsonFileTrajectoryRecorder({ rootDir: tmpDir });
		const id = recorder.startTrajectory({
			agentId: "agent-surrogate",
			roomId: "room-1",
			rootMessage: { id: "msg-1", text: `hello ${FOX}`, sender: "user-1" },
		});
		// 1024-byte cap => 1010-byte slice budget, which lands 3 bytes into the
		// 252nd fox: exactly the boundary that used to decode to U+FFFD.
		const io = captureToolStageIO({
			output: `aaa${FOX.repeat(300)}`,
			capBytes: 1024,
		});
		const stage: RecordedStage = {
			stageId: "stage-tool-WEB_SEARCH-1",
			kind: "tool",
			startedAt: 1,
			endedAt: 2,
			latencyMs: 1,
			tool: {
				name: "WEB_SEARCH",
				args: {},
				result: {},
				success: true,
				durationMs: 1,
				output: io.output,
				truncated: io.truncated,
			},
		};
		await recorder.recordStage(id, stage);
		await recorder.endTrajectory(id, "finished");

		const raw = await fs.readFile(
			path.join(tmpDir, "agent-surrogate", `${id}.json`),
			"utf8",
		);
		expect(raw).not.toContain(REPLACEMENT_CHARACTER);
		const parsed = JSON.parse(raw) as RecordedTrajectory;
		const persisted = parsed.stages[0]?.tool?.output as string;
		expect(persisted).toBeDefined();
		expect(persisted).not.toContain(REPLACEMENT_CHARACTER);
		expect(isWellFormed(persisted)).toBe(true);
		expect(persisted.endsWith(`${FOX}${TRUNCATION_SUFFIX}`)).toBe(true);
		expect(Buffer.byteLength(persisted, "utf8")).toBeLessThanOrEqual(1024);
	});
});

describe("record-string truncation via encodeTrajectoryFieldValue", () => {
	const targetPreview =
		RECORD_SANITIZE_MAX_STRING_CHARS - TRUNCATION_SUFFIX.length;

	/** The recorder's 64K code-unit record cap, exercised through a real export. */
	function truncatedRecordString(value: string): string {
		const encoded = encodeTrajectoryFieldValue({ record: value });
		return (JSON.parse(encoded) as { record: string }).record;
	}

	test("emoji at the preview boundary backs off without a lone surrogate", () => {
		const out = truncatedRecordString(
			`${"a".repeat(targetPreview - 1)}${FOX}${"b".repeat(1000)}`,
		);
		expect(isWellFormed(out)).toBe(true);
		expect(out.endsWith(TRUNCATION_SUFFIX)).toBe(true);
		expect(out.length).toBe(targetPreview - 1 + TRUNCATION_SUFFIX.length);
	});

	test("an emoji that ends exactly on the preview boundary is kept intact", () => {
		const out = truncatedRecordString(
			`${"a".repeat(targetPreview - 2)}${FOX}${"b".repeat(1000)}`,
		);
		expect(isWellFormed(out)).toBe(true);
		expect(out.length).toBe(targetPreview + TRUNCATION_SUFFIX.length);
		expect(out.endsWith(`${FOX}${TRUNCATION_SUFFIX}`)).toBe(true);
	});

	test("a short record string with an emoji passes through untouched", () => {
		const input = `Step execution log with fox ${FOX} emoji`;
		expect(truncatedRecordString(input)).toBe(input);
	});

	test("a lone high surrogate is sanitized before truncation", () => {
		const out = truncatedRecordString(
			`bad \ud800 surrogate ${"x".repeat(70000)}`,
		);
		expect(isWellFormed(out)).toBe(true);
		expect(out.includes("\ud800")).toBe(false);
		expect(out.endsWith(TRUNCATION_SUFFIX)).toBe(true);
	});

	test("sweep of offsets around the 64K cap all stay well-formed", () => {
		for (let offset = -5; offset <= 5; offset++) {
			const out = truncatedRecordString(
				`${"a".repeat(targetPreview + offset)}${FOX}${"b".repeat(1000)}`,
			);
			expect(isWellFormed(out)).toBe(true);
			expect(() => JSON.stringify({ record: out })).not.toThrow();
		}
	});
});
