/**
 * Heavyweight document text extraction: DOCX via mammoth, PDF via unpdf, plain
 * text with a UTF-8 fallback. Split from `utils.ts` so the parser graph is one
 * module the edge build can alias away (`parsers.edge.ts`) without touching the
 * pure helpers beside it, which edge code genuinely uses; `utils.ts` re-exports
 * these, so existing import sites keep working (#21327). The `await import(...)`
 * calls below keep the parsers off the Node startup path; they cannot keep them
 * out of a single-file worker bundle, which is what the edge alias is for.
 */
import type { Buffer } from "node:buffer";

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

const MAX_FALLBACK_SIZE_BYTES = 5 * 1024 * 1024;
const BINARY_CHECK_BYTES = 1024;

export async function extractTextFromFileBuffer(
	fileBuffer: Buffer,
	contentType: string,
	originalFilename: string,
): Promise<string> {
	const lowerContentType = contentType.toLowerCase();

	if (
		lowerContentType ===
		"application/vnd.openxmlformats-officedocument.wordprocessingml.document"
	) {
		try {
			// Loaded on use: mammoth is a CJS parser whose static import drags the
			// whole docx toolchain into every consumer bundle (edge included).
			const mammoth = await import("mammoth");
			const result = await mammoth.extractRawText({ buffer: fileBuffer });
			return result.value;
		} catch (docxError) {
			// error-policy:J2 Add document identity while preserving the parser cause.
			const errorMessage =
				docxError instanceof Error ? docxError.message : String(docxError);
			throw new Error(
				`Failed to parse DOCX file ${originalFilename}: ${errorMessage}`,
				{ cause: docxError },
			);
		}
	} else if (
		lowerContentType === "application/msword" ||
		originalFilename.toLowerCase().endsWith(".doc")
	) {
		throw new Error(
			`Legacy Microsoft Word documents are not supported: ${originalFilename}`,
		);
	} else if (
		lowerContentType.startsWith("text/") ||
		PLAIN_TEXT_CONTENT_TYPES.includes(lowerContentType)
	) {
		return fileBuffer.toString("utf-8");
	} else {
		if (fileBuffer.length > MAX_FALLBACK_SIZE_BYTES) {
			throw new Error(
				`File ${originalFilename} exceeds maximum size for fallback (${MAX_FALLBACK_SIZE_BYTES} bytes)`,
			);
		}

		const initialBytes = fileBuffer.subarray(
			0,
			Math.min(fileBuffer.length, BINARY_CHECK_BYTES),
		);
		if (initialBytes.includes(0)) {
			throw new Error(
				`File ${originalFilename} appears to be binary based on initial byte check`,
			);
		}

		try {
			const textContent = fileBuffer.toString("utf-8");
			if (textContent.includes("\ufffd")) {
				throw new Error(
					`File ${originalFilename} seems to be binary or has encoding issues (detected \ufffd)`,
				);
			}
			return textContent;
		} catch (fallbackError) {
			// error-policy:J2 Preserve the failed UTF-8 validation as the cause.
			throw new Error(
				`Unsupported content type: ${contentType} for ${originalFilename}. Fallback to plain text failed`,
				{ cause: fallbackError },
			);
		}
	}
}

export async function convertPdfToTextFromBuffer(
	pdfBuffer: Buffer,
	_filename?: string,
): Promise<string> {
	try {
		const uint8Array = new Uint8Array(
			pdfBuffer.buffer.slice(
				pdfBuffer.byteOffset,
				pdfBuffer.byteOffset + pdfBuffer.byteLength,
			),
		);

		// Loaded on use like mammoth above: unpdf's static import would pin the
		// PDF toolchain into every consumer bundle (edge included).
		const { extractText } = await import("unpdf");
		const result = await extractText(uint8Array, {
			mergePages: true,
		});

		if (result.text.trim().length === 0) {
			throw new Error("PDF contained no extractable text");
		}

		const cleanedText = result.text
			.split("\n")
			.map((line: string) => line.trim())
			.filter((line: string) => line.length > 0)
			.join("\n")
			.replace(/\n{3,}/g, "\n\n");

		return cleanedText;
	} catch (error) {
		// error-policy:J2 Preserve the PDF parser failure as the conversion cause.
		const errorMessage = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to convert PDF to text: ${errorMessage}`, {
			cause: error,
		});
	}
}
