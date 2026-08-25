/**
 * Branch coverage for heavyweight document text extraction
 * (`extractTextFromFileBuffer`, `convertPdfToTextFromBuffer`).
 *
 * The harness drives the real parsers with in-memory fixtures only: synthetic
 * PDF objects are assembled byte-by-byte with correct xref offsets and DOCX
 * packages are serialized as stored-entry zip bytes by a local writer, so every
 * assertion below records observed behavior of the production parser graph
 * (mammoth, unpdf) with nothing mocked.
 */
import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
	convertPdfToTextFromBuffer,
	extractTextFromFileBuffer,
} from "./parsers.ts";

const DOCX_CONTENT_TYPE =
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document";

// Mirrors the module-private PLAIN_TEXT_CONTENT_TYPES list.
const PLAIN_TEXT_CONTENT_TYPES = [
	"application/typescript",
	"text/typescript",
	"text/x-python",
	"application/x-python-code",
	"application/yaml",
	"text/yaml",
	"application/x-yaml",
	"application/json",
	"text/markdown",
	"text/csv",
];

/**
 * Builds a minimal single-page PDF whose body shows one text row per entry,
 * each baseline `gap` points below the previous, with a correct xref table so
 * unpdf parses it without recovery.
 */
function buildSinglePagePdf(rows: string[], gap = 40): Buffer {
	const streamOps = rows
		.map(
			(row, index) => `BT /F1 24 Tf 72 ${700 - index * gap} Td (${row}) Tj ET`,
		)
		.join("\n");
	const bodies = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
		`<< /Length ${streamOps.length} >>\nstream\n${streamOps}\nendstream`,
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
	];
	let out = "%PDF-1.4\n";
	const offsets: number[] = [];
	for (let index = 0; index < bodies.length; index++) {
		offsets.push(Buffer.byteLength(out, "latin1"));
		out += `${index + 1} 0 obj\n${bodies[index]}\nendobj\n`;
	}
	const xrefStart = Buffer.byteLength(out, "latin1");
	out += `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`;
	for (const offset of offsets) {
		out += `${String(offset).padStart(10, "0")} 00000 n \n`;
	}
	out += `trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
	return Buffer.from(out, "latin1");
}

// CRC-32 (IEEE 802.3) over stored bytes, the checksum every zip reader validates.
function crc32(bytes: Buffer): number {
	let crc = -1;
	for (const byte of bytes) {
		crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
	}
	return (crc ^ -1) >>> 0;
}

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) {
			c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		}
		table[n] = c >>> 0;
	}
	return table;
})();

/**
 * Builds a real DOCX (OPC package) as an uncompressed zip so mammoth parses it
 * exactly like a Word-produced file, without depending on a zip library.
 */
function buildMinimalDocx(paragraphText: string): Buffer {
	const files: Array<[string, string]> = [
		[
			"[Content_Types].xml",
			'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
		],
		[
			"_rels/.rels",
			'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
		],
		[
			"word/document.xml",
			`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${paragraphText}</w:t></w:r></w:p></w:body></w:document>`,
		],
	];

	const chunks: Buffer[] = [];
	const central: Buffer[] = [];
	let offset = 0;
	for (const [name, content] of files) {
		const nameBytes = Buffer.from(name, "utf8");
		const data = Buffer.from(content, "utf8");
		const checksum = crc32(data);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(0, 6);
		local.writeUInt16LE(0, 8);
		local.writeUInt16LE(0, 10);
		local.writeUInt16LE(0x21, 12);
		local.writeUInt32LE(checksum, 14);
		local.writeUInt32LE(data.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(nameBytes.length, 26);
		local.writeUInt16LE(0, 28);
		chunks.push(local, nameBytes, data);

		const entry = Buffer.alloc(46);
		entry.writeUInt32LE(0x02014b50, 0);
		entry.writeUInt16LE(20, 4);
		entry.writeUInt16LE(20, 6);
		entry.writeUInt16LE(0, 8);
		entry.writeUInt16LE(0, 10);
		entry.writeUInt16LE(0, 12);
		entry.writeUInt16LE(0x21, 14);
		entry.writeUInt32LE(checksum, 16);
		entry.writeUInt32LE(data.length, 20);
		entry.writeUInt32LE(data.length, 24);
		entry.writeUInt16LE(nameBytes.length, 28);
		entry.writeUInt32LE(offset, 42);
		central.push(entry, nameBytes);

		offset += 30 + nameBytes.length + data.length;
	}
	const centralStart = offset;
	const centralDirectory = Buffer.concat(central);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(files.length, 8);
	eocd.writeUInt16LE(files.length, 10);
	eocd.writeUInt32LE(centralDirectory.length, 12);
	eocd.writeUInt32LE(centralStart, 16);
	return Buffer.concat([...chunks, centralDirectory, eocd]);
}

describe("extractTextFromFileBuffer", () => {
	it("returns UTF-8 bytes verbatim for text/plain", async () => {
		const text = await extractTextFromFileBuffer(
			Buffer.from("héllo wörld\nsecond line"),
			"text/plain",
			"notes.txt",
		);
		expect(text).toBe("héllo wörld\nsecond line");
	});

	it("matches text/* content types case-insensitively", async () => {
		const text = await extractTextFromFileBuffer(
			Buffer.from("UPPER"),
			"TEXT/PLAIN",
			"upper.txt",
		);
		expect(text).toBe("UPPER");
	});

	it("passes through every declared non-text/* plain content type", async () => {
		for (const contentType of PLAIN_TEXT_CONTENT_TYPES) {
			const payload = `payload-for-${contentType}`;
			const text = await extractTextFromFileBuffer(
				Buffer.from(payload),
				contentType,
				"asset",
			);
			expect(text).toBe(payload);
		}
	});

	it("rejects legacy .doc content with the unsupported-format error", async () => {
		await expect(
			extractTextFromFileBuffer(
				Buffer.from("junk"),
				"application/msword",
				"old.doc",
			),
		).rejects.toThrow(
			"Legacy Microsoft Word documents are not supported: old.doc",
		);
	});

	it("rejects a .doc extension even when the content type is modern", async () => {
		await expect(
			extractTextFromFileBuffer(
				Buffer.from("junk"),
				"application/octet-stream",
				"legacy.DOC",
			),
		).rejects.toThrow(
			"Legacy Microsoft Word documents are not supported: legacy.DOC",
		);
	});

	it("rejects unknown content types whose first kilobyte contains a NUL byte", async () => {
		await expect(
			extractTextFromFileBuffer(
				Buffer.from([0x41, 0x00, 0x42]),
				"application/octet-stream",
				"bin.bin",
			),
		).rejects.toThrow(
			"File bin.bin appears to be binary based on initial byte check",
		);
	});

	it("only scans the first 1024 bytes when checking for binary data", async () => {
		const buffer = Buffer.alloc(1026, 0x41);
		buffer[1024] = 0;
		buffer[1025] = 0x42;

		const text = await extractTextFromFileBuffer(
			buffer,
			"application/octet-stream",
			"edge.bin",
		);

		expect(text).toBe(`${"A".repeat(1024)}\u0000B`);
	});

	it("wraps replacement-character fallback failures with document identity", async () => {
		const error = await extractTextFromFileBuffer(
			Buffer.from([0xff, 0xfe, 0x41]),
			"application/octet-stream",
			"weird.xyz",
		).catch((caught: Error) => caught);

		expect(error).toBeInstanceOf(Error);
		expect(error.message).toBe(
			"Unsupported content type: application/octet-stream for weird.xyz. Fallback to plain text failed",
		);
		expect((error.cause as Error).message).toContain("weird.xyz");
	});

	it("rejects fallback files larger than five mebibytes before decoding", async () => {
		await expect(
			extractTextFromFileBuffer(
				Buffer.alloc(5 * 1024 * 1024 + 1, 0x41),
				"application/octet-stream",
				"big.dat",
			),
		).rejects.toThrow(
			"File big.dat exceeds maximum size for fallback (5242880 bytes)",
		);
	});

	it("accepts a clean fallback payload of exactly the size limit", async () => {
		const text = await extractTextFromFileBuffer(
			Buffer.alloc(5 * 1024 * 1024, 0x41),
			"application/octet-stream",
			"ok.dat",
		);
		expect(text.length).toBe(5 * 1024 * 1024);
	});

	it("extracts raw text from a real DOCX package", async () => {
		const docx = buildMinimalDocx("Hello from a real docx");

		const text = await extractTextFromFileBuffer(
			docx,
			DOCX_CONTENT_TYPE,
			"real.docx",
		);

		expect(text).toBe("Hello from a real docx\n\n");
	});

	it("wraps DOCX parse failures while preserving the parser cause", async () => {
		const error = await extractTextFromFileBuffer(
			Buffer.from("not a zip"),
			DOCX_CONTENT_TYPE,
			"broken.docx",
		).catch((caught: Error) => caught);

		expect(error).toBeInstanceOf(Error);
		expect(
			error.message.startsWith("Failed to parse DOCX file broken.docx:"),
		).toBe(true);
		expect(error.cause).toBeInstanceOf(Error);
	});
});

describe("convertPdfToTextFromBuffer", () => {
	it("extracts text from a hand-built single-page PDF", async () => {
		const text = await convertPdfToTextFromBuffer(
			buildSinglePagePdf(["Hello from eliza"]),
		);
		expect(text).toBe("Hello from eliza");
	});

	it("joins separately positioned text rows with newlines", async () => {
		const text = await convertPdfToTextFromBuffer(
			buildSinglePagePdf(["first row", "second row", "third row"]),
		);
		expect(text).toBe("first row\nsecond row\nthird row");
	});

	it("trims each extracted line and drops blank inter-row gaps", async () => {
		const padded = await convertPdfToTextFromBuffer(
			buildSinglePagePdf(["  spaced  ", "tight"]),
		);
		expect(padded).toBe("spaced\ntight");

		const wideGap = await convertPdfToTextFromBuffer(
			buildSinglePagePdf(["alpha", "omega"], 200),
		);
		expect(wideGap).toBe("alpha\nomega");
	});

	it("wraps structural PDF failures with the conversion prefix and cause", async () => {
		const error = await convertPdfToTextFromBuffer(
			Buffer.from("this is not a pdf at all"),
		).catch((caught: Error) => caught);

		expect(error).toBeInstanceOf(Error);
		expect(error.message.startsWith("Failed to convert PDF to text:")).toBe(
			true,
		);
		expect(error.cause).toBeInstanceOf(Error);
	});

	it("reports a structurally valid PDF that yields no text", async () => {
		const error = await convertPdfToTextFromBuffer(
			buildSinglePagePdf([]),
		).catch((caught: Error) => caught);

		expect(error).toBeInstanceOf(Error);
		expect(error.message).toBe(
			"Failed to convert PDF to text: PDF contained no extractable text",
		);
	});
});
