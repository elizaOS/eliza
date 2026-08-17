/**
 * Edge-target replacement for `parsers.ts`, aliased in by
 * `edgeRuntimeSourcesPlugin` at build time (#21327). The Node parsers reach
 * mammoth and unpdf through `await import(...)`, which keeps them off the Node
 * startup path but cannot keep them out of a single-file worker bundle — the
 * bundler inlines both graphs (~2.1 MB minified) into every cold start. Document
 * extraction is already declared unavailable on this target (`documents` is
 * `false` in `nativeRuntimeFeatureDefaults`), so these entry points fail closed
 * with a named, greppable error instead of shipping parsers that are never
 * meant to run here.
 */
import type { Buffer } from "node:buffer";

const UNSUPPORTED_MESSAGE =
	"Document text extraction is unavailable on the edge runtime: the mammoth/unpdf parser graph is excluded from this bundle and the documents feature is disabled on this target";

export async function extractTextFromFileBuffer(
	_fileBuffer: Buffer,
	contentType: string,
	originalFilename: string,
): Promise<string> {
	throw new Error(
		`${UNSUPPORTED_MESSAGE} (requested ${contentType} for ${originalFilename})`,
	);
}

export async function convertPdfToTextFromBuffer(
	_pdfBuffer: Buffer,
	filename?: string,
): Promise<string> {
	throw new Error(
		`${UNSUPPORTED_MESSAGE} (requested PDF conversion${filename ? ` for ${filename}` : ""})`,
	);
}
