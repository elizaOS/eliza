/**
 * Exercises DOCUMENT action paging through its production handler with a
 * deterministic service boundary. It proves exact line/fragment pages,
 * continuation revisions, stale-source rejection, and absence of source-body
 * duplication in structured action projections.
 */
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type {
	HandlerOptions,
	IAgentRuntime,
	Memory,
	UUID,
} from "../../../types/index.ts";
import { isReadView } from "../../../types/index.ts";
import { documentAction } from "../actions.ts";
import { DocumentService } from "../service.ts";

const AGENT_ID = "10000000-0000-4000-8000-000000000001" as UUID;
const USER_ID = "10000000-0000-4000-8000-000000000002" as UUID;
const ROOM_ID = "10000000-0000-4000-8000-000000000003" as UUID;
const DOCUMENT_ID = "10000000-0000-4000-8000-000000000004" as UUID;

function request(): Memory {
	return {
		id: "10000000-0000-4000-8000-000000000005" as UUID,
		agentId: AGENT_ID,
		entityId: USER_ID,
		roomId: ROOM_ID,
		content: { text: "read the stored document" },
	} as Memory;
}

function options(parameters: Record<string, unknown>): HandlerOptions {
	return { parameters } as HandlerOptions;
}

function harness(text: string) {
	let currentText = text;
	let currentRevision = 7;
	const service = {
		getDocumentById: vi.fn(async () => {
			throw new Error("whole-document lookup must not be used for paging");
		}),
		readDocumentRange: vi.fn(
			async (
				_documentId: UUID,
				params: {
					unit: "line" | "fragment" | "byte";
					offset: number;
					limit: number;
				},
			) => {
				if (params.unit === "byte") {
					const bytes = Buffer.from(currentText, "utf8");
					const text = bytes
						.subarray(params.offset, params.offset + params.limit)
						.toString("utf8");
					return {
						unit: "byte" as const,
						text,
						start: params.offset,
						end: params.offset + Buffer.byteLength(text, "utf8"),
						total: bytes.length,
						documentRevision: currentRevision,
						revisionAttemptId: `native-secret-${currentRevision}`,
						sourceFingerprint: `sha256:${createHash("sha256")
							.update(currentText)
							.digest("hex")}`,
						examinedSourceSegments: 1,
						returnedSourceSegments: 1,
						sourceBytesRead: text.length,
						returnedSourceBytes: text.length,
						sourceQueryCount: 2,
					};
				}
				const lines =
					currentText.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/gu) ?? [];
				const units =
					params.unit === "line"
						? lines
						: lines
								.reduce<string[]>((fragments, line) => {
									const last = fragments.length - 1;
									if (last < 0) fragments.push(line);
									else fragments[last] += line;
									if (line.replace(/[\r\n]/gu, "").trim().length === 0) {
										fragments.push("");
									}
									return fragments;
								}, [])
								.filter(Boolean);
				const pageText = units
					.slice(params.offset, params.offset + params.limit)
					.join("");
				return {
					unit: params.unit,
					text: pageText,
					start: params.offset,
					end: Math.min(params.offset + params.limit, units.length),
					total: units.length,
					documentRevision: currentRevision,
					revisionAttemptId: `native-secret-${currentRevision}`,
					sourceFingerprint: `sha256:${createHash("sha256")
						.update(currentText)
						.digest("hex")}`,
					examinedSourceSegments: 1,
					returnedSourceSegments: 1,
					sourceBytesRead: Buffer.byteLength(pageText, "utf8"),
					returnedSourceBytes: Buffer.byteLength(pageText, "utf8"),
					sourceQueryCount: 2,
				};
			},
		),
	};
	const runtime = {
		agentId: AGENT_ID,
		getService: <T>(type: string): T | null =>
			type === DocumentService.serviceType ? (service as T) : null,
		registerSearchCategory: vi.fn(),
		getSetting: vi.fn(),
		reportError: vi.fn(),
	} as unknown as IAgentRuntime;
	return {
		runtime,
		service,
		setText(value: string, bumpDeclaredRevision = true) {
			currentText = value;
			if (bumpDeclaredRevision) currentRevision += 1;
		},
	};
}

describe("DOCUMENT progressive read", () => {
	it("reads late line pages exactly and carries only ReadView metadata in structured data", async () => {
		const lines = Array.from(
			{ length: 205 },
			(_, index) => `line-${index}\r\n`,
		);
		const source = lines.join("");
		const { runtime } = harness(source);
		const first = await documentAction.handler?.(
			runtime,
			request(),
			undefined,
			options({ action: "read", documentId: DOCUMENT_ID, limit: 100 }),
		);
		expect(first).toBeDefined();
		const firstView = (first?.data as { readView?: unknown } | undefined)
			?.readView;
		expect(isReadView(firstView)).toBe(true);
		const revision = (firstView as { slice: { revision: string } }).slice
			.revision;
		expect(revision).toMatch(/^rev:[a-f0-9]{64}$/u);
		expect(revision).not.toContain("native-secret");

		const late = await documentAction.handler?.(
			runtime,
			request(),
			undefined,
			options({
				action: "read",
				documentId: DOCUMENT_ID,
				offset: 200,
				limit: 5,
				expectedRevision: revision,
			}),
		);
		expect(late?.text).toBe(lines.slice(200).join(""));
		const serializedData = JSON.stringify(late?.data);
		expect(serializedData).not.toContain("line-200");
		expect(JSON.stringify(late?.promptData)).not.toContain("line-200");
		const view = (
			late?.data as { readView: { slice: Record<string, unknown> } } | undefined
		)?.readView;
		expect(view).toBeDefined();
		expect(view?.slice).toMatchObject({
			range: { unit: "line", start: 200, end: 205, total: 205 },
			completeness: "complete",
		});
		expect(view.slice.sliceSha256).toBe(
			createHash("sha256")
				.update(late?.text ?? "")
				.digest("hex"),
		);
	});

	it("reassembles exact fragment pages without losing blank-line separators", async () => {
		const source = "alpha\r\n\r\nbeta\n\ngamma";
		const { runtime } = harness(source);
		const pages: string[] = [];
		let offset = 0;
		let revision: string | undefined;
		for (;;) {
			const result = await documentAction.handler?.(
				runtime,
				request(),
				undefined,
				options({
					action: "read",
					documentId: DOCUMENT_ID,
					unit: "fragment",
					offset,
					limit: 1,
					...(revision ? { expectedRevision: revision } : {}),
				}),
			);
			pages.push(result?.text ?? "");
			const view = (
				result?.data as
					| {
							readView: {
								slice: {
									hasMore: boolean;
									nextOffset?: number;
									revision?: string;
								};
							};
					  }
					| undefined
			)?.readView;
			expect(view).toBeDefined();
			if (!view) throw new Error("missing read view");
			revision = view.slice.revision;
			if (!view.slice.hasMore) break;
			offset = view.slice.nextOffset as number;
		}
		expect(pages.join("")).toBe(source);
	});

	it("exposes giant-unit fallback as an advancing partial byte page", async () => {
		const { runtime, service } = harness("unused");
		service.readDocumentRange.mockResolvedValueOnce({
			unit: "byte",
			text: "bounded prefix",
			start: 0,
			end: 14,
			total: 1_000_000,
			documentRevision: 7,
			revisionAttemptId: "native-secret-7",
			sourceFingerprint: `sha256:${"a".repeat(64)}`,
			examinedSourceSegments: 5,
			returnedSourceSegments: 3,
			sourceBytesRead: 256 * 1024,
			returnedSourceBytes: 14,
			sourceQueryCount: 2,
		});
		const result = await documentAction.handler?.(
			runtime,
			request(),
			undefined,
			options({ action: "read", documentId: DOCUMENT_ID, unit: "line" }),
		);
		expect(result?.text).toBe("bounded prefix");
		expect(result?.data).toMatchObject({
			readView: {
				slice: {
					range: { unit: "byte", start: 0, end: 14, total: 1_000_000 },
					completeness: "partial-recoverable",
					hasMore: true,
					nextOffset: 14,
				},
			},
		});
	});

	it("fails explicitly when the source changes between pages", async () => {
		const { runtime, setText } = harness("one\ntwo\nthree\n");
		const first = await documentAction.handler?.(
			runtime,
			request(),
			undefined,
			options({ action: "read", documentId: DOCUMENT_ID, limit: 1 }),
		);
		const revision = (
			first?.data as { readView: { slice: { revision: string } } } | undefined
		)?.readView.slice.revision;
		expect(revision).toBeDefined();
		// A faulty adapter may replace text without advancing its native revision.
		// The opaque paging revision must still detect the source change.
		setText("changed\ntwo\nthree\n", false);
		const stale = await documentAction.handler?.(
			runtime,
			request(),
			undefined,
			options({
				action: "read",
				documentId: DOCUMENT_ID,
				offset: 1,
				limit: 1,
				expectedRevision: revision,
			}),
		);
		expect(stale?.success).toBe(false);
		expect(stale?.values).toMatchObject({ error: "stale_revision" });
		expect(stale?.text).not.toContain("two");
	});

	it.each([
		{ offset: -1 },
		{ offset: 3 },
		{ offset: Number.MAX_SAFE_INTEGER + 1 },
		{ limit: -1 },
		{ limit: 0 },
		{ limit: 101 },
	])("fails explicitly for an invalid read range %#", async (range) => {
		const { runtime } = harness("one\ntwo\n");
		const result = await documentAction.handler?.(
			runtime,
			request(),
			undefined,
			options({ action: "read", documentId: DOCUMENT_ID, ...range }),
		);
		expect(result?.success).toBe(false);
		expect(result?.values).toMatchObject({
			error: "DOCUMENT_READ_INVALID_RANGE",
		});
	});
});
