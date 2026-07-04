/**
 * Drives the real processAttachments path over a stubbed fetch and hand-built,
 * spec-valid PDF bytes, so document extraction (including real unpdf parsing)
 * runs unmocked for every allow-listed upload type.
 */
import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ContentType,
	type IAgentRuntime,
	type Media,
	type UUID,
} from "../../types/index.ts";
import { processAttachments } from "./index.ts";

/**
 * #10714 — every document type on the chat upload allow-list
 * (text/plain, text/csv, text/markdown, application/pdf) must become readable
 * text on the attachment, not be silently skipped. This drives the real
 * `processAttachments` path (real `unpdf` PDF extraction, no mock) and asserts
 * each type lands its content on `attachment.text`.
 */

const agentId = "00000000-0000-0000-0000-0000000000aa" as UUID;

function makeRuntime(): IAgentRuntime {
	return {
		agentId,
		logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
	} as unknown as IAgentRuntime;
}

function doc(url: string): Media {
	return { id: url, url, contentType: ContentType.DOCUMENT } as Media;
}

/**
 * Build a minimal, valid single-page PDF with known text and a correct xref
 * table, so even a strict parser accepts it. Real bytes → real extraction.
 */
function buildPdf(text: string): Buffer {
	const stream = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET`;
	const objs = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
		`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
	];
	let body = "%PDF-1.4\n";
	const offsets: number[] = [];
	objs.forEach((o, i) => {
		offsets.push(body.length);
		body += `${i + 1} 0 obj\n${o}\nendobj\n`;
	});
	const xrefStart = body.length;
	body += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
	for (const off of offsets) {
		body += `${String(off).padStart(10, "0")} 00000 n \n`;
	}
	body += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
	return Buffer.from(body, "latin1");
}

type FetchResult = {
	contentType: string;
	text?: string;
	bytes?: Buffer;
};

function stubFetch(byUrl: Record<string, FetchResult>): void {
	vi.stubGlobal("fetch", async (input: string | URL) => {
		const url = typeof input === "string" ? input : input.toString();
		const hit = byUrl[url];
		if (!hit) throw new Error(`unexpected fetch: ${url}`);
		return {
			ok: true,
			statusText: "OK",
			headers: {
				get: (h: string) => (/content-type/i.test(h) ? hit.contentType : null),
			},
			text: async () => hit.text ?? "",
			arrayBuffer: async () => {
				const b = hit.bytes ?? Buffer.from(hit.text ?? "", "utf-8");
				return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
			},
		} as unknown as Response;
	});
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("processAttachments — document types (#10714)", () => {
	it("reads a text/plain document onto attachment.text", async () => {
		const url = "https://media.test/notes.txt";
		stubFetch({
			[url]: {
				contentType: "text/plain; charset=utf-8",
				text: "plain notes body",
			},
		});
		const [out] = await processAttachments([doc(url)], makeRuntime());
		expect(out.text).toBe("plain notes body");
		expect(out.title).toBe("Text File");
	});

	it("reads a text/csv document (previously skipped) onto attachment.text", async () => {
		const url = "https://media.test/data.csv";
		const csv = "name,score\nada,99\ngrace,97";
		stubFetch({ [url]: { contentType: "text/csv; charset=utf-8", text: csv } });
		const [out] = await processAttachments([doc(url)], makeRuntime());
		expect(out.text).toBe(csv);
	});

	it("reads a text/markdown document (previously skipped) onto attachment.text", async () => {
		const url = "https://media.test/readme.md";
		const md = "# Title\n\n- one\n- two";
		stubFetch({
			[url]: { contentType: "text/markdown; charset=utf-8", text: md },
		});
		const [out] = await processAttachments([doc(url)], makeRuntime());
		expect(out.text).toBe(md);
	});

	it("extracts real text from an application/pdf document (previously skipped)", async () => {
		const url = "https://media.test/report.pdf";
		stubFetch({
			[url]: {
				contentType: "application/pdf",
				bytes: buildPdf("Hello PDF from Eliza 10714"),
			},
		});
		const [out] = await processAttachments([doc(url)], makeRuntime());
		expect(out.text).toBe("Hello PDF from Eliza 10714");
		expect(out.title).toBe("PDF Document");
	});

	it("leaves an already-extracted document untouched (no refetch)", async () => {
		const url = "https://media.test/cached.txt";
		stubFetch({}); // any fetch would throw
		const pre = { ...doc(url), text: "already here" } as Media;
		const [out] = await processAttachments([pre], makeRuntime());
		expect(out.text).toBe("already here");
	});
});
