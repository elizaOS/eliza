/**
 * Exercises MIME-variant PDF ingestion through the real DocumentService,
 * unpdf parser, fragmenter, AgentRuntime, and in-memory persistence. The
 * checked-in audit fixture is deliberately uploaded with a non-PDF filename so
 * MIME routing, rather than the extension fallback, determines extraction.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { InMemoryDatabaseAdapter } from "../../database/inMemoryAdapter.ts";
import { AgentRuntime } from "../../runtime.ts";
import type { Character, Memory, UUID } from "../../types/index.ts";
import { DocumentService } from "./service.ts";

const AGENT_ID = "00000000-0000-4000-8000-000000019153" as UUID;
const PDF_FIXTURE_PATH = fileURLToPath(
	new URL(
		"../../../../app-core/test/contracts/lib/openzeppelin-contracts/audits/2025-10-v5.5.pdf",
		import.meta.url,
	),
);

type ExtractionSnapshot = {
	length: number;
	text: string;
	digest: string;
};

function fragmentPosition(fragment: Memory): number {
	const position = fragment.metadata?.position;
	if (typeof position !== "number") {
		throw new Error(`Fragment ${fragment.id} has no numeric position`);
	}
	return position;
}

async function ingestPdf(
	pdfBase64: string,
	contentType: string,
): Promise<ExtractionSnapshot> {
	const adapter = new InMemoryDatabaseAdapter();
	await adapter.initialize();
	const runtime = new AgentRuntime({
		agentId: AGENT_ID,
		character: {
			name: "DocumentMimeRegressionTestAgent",
			bio: "Exercises deterministic PDF MIME routing.",
			settings: {},
		} as Character,
		adapter,
		logLevel: "fatal",
	});
	const service = new DocumentService(runtime);
	const result = await service.addDocument({
		agentId: AGENT_ID,
		worldId: AGENT_ID,
		roomId: AGENT_ID,
		entityId: AGENT_ID,
		clientDocumentId: AGENT_ID,
		contentType,
		originalFilename: "openzeppelin-v5.5-audit.bin",
		content: pdfBase64,
	});

	const fragments = (
		await runtime.getMemories({
			tableName: "document_fragments",
			agentId: AGENT_ID,
			roomId: AGENT_ID,
			count: 10_000,
		})
	)
		.filter(
			(fragment) => fragment.metadata?.documentId === result.clientDocumentId,
		)
		.sort((left, right) => fragmentPosition(left) - fragmentPosition(right));
	expect(fragments).toHaveLength(result.fragmentCount);

	const text = fragments
		.map((fragment) => {
			if (typeof fragment.content.text !== "string") {
				throw new Error(`Fragment ${fragment.id} has no text`);
			}
			return fragment.content.text;
		})
		.join("\n");

	return {
		length: text.length,
		text,
		digest: createHash("sha256").update(text).digest("hex"),
	};
}

describe("DocumentService PDF MIME routing regression", () => {
	it("extracts identical text for canonical, uppercase, and parameterized PDF MIME values", async () => {
		const pdfBase64 = (await readFile(PDF_FIXTURE_PATH)).toString("base64");
		const canonical = await ingestPdf(pdfBase64, "application/pdf");
		const uppercase = await ingestPdf(pdfBase64, "APPLICATION/PDF");
		const parameterized = await ingestPdf(
			pdfBase64,
			"application/pdf; charset=UTF-8",
		);

		expect(canonical.length).toBeGreaterThan(1_000);
		for (const variant of [uppercase, parameterized]) {
			expect(variant.length).toBe(canonical.length);
			expect(variant.text).toBe(canonical.text);
			expect(variant.digest).toBe(canonical.digest);
		}
	}, 120_000);
});
