/**
 * Exercises the real document service and checked-in PDF parser fixture across
 * canonical, mixed-case, and parameterized MIME values with in-memory storage.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { InMemoryDatabaseAdapter } from "../../database/inMemoryAdapter";
import { AgentRuntime } from "../../runtime";
import { MOCK_AGENT_ID } from "../../testing/mock-runtime";
import type { Character, Memory } from "../../types";
import { MemoryType } from "../../types";
import { DocumentService } from "./service.ts";

const PDF_FIXTURE_URL = new URL(
	"../../../../app-core/test/contracts/lib/openzeppelin-contracts/audits/2025-10-v5.5.pdf",
	import.meta.url,
);
const DOCUMENT_FRAGMENTS_TABLE = "document_fragments";

type ExtractedPdfArtifact = {
	fragmentCount: number;
	textLength: number;
	textDigest: string;
	textPrefix: string;
};

async function createRuntime(): Promise<AgentRuntime> {
	const adapter = new InMemoryDatabaseAdapter();
	await adapter.initialize();
	const runtime = new AgentRuntime({
		agentId: MOCK_AGENT_ID,
		character: {
			name: "DocumentPdfMimeTestAgent",
			bio: "Exercises PDF MIME routing through the real document service.",
			settings: {},
		} as Character,
		adapter,
		logLevel: "fatal",
	});
	return runtime;
}

async function ingestFixture(
	contentType: string,
): Promise<ExtractedPdfArtifact> {
	const runtime = await createRuntime();
	const service = new DocumentService(runtime);
	const content = (await readFile(PDF_FIXTURE_URL)).toString("base64");
	const result = await service.addDocument({
		agentId: MOCK_AGENT_ID,
		worldId: MOCK_AGENT_ID,
		roomId: MOCK_AGENT_ID,
		entityId: MOCK_AGENT_ID,
		clientDocumentId: MOCK_AGENT_ID,
		contentType,
		originalFilename: "2025-10-v5.5.blob",
		content,
	});
	const fragments = await runtime.getMemories({
		tableName: DOCUMENT_FRAGMENTS_TABLE,
		agentId: MOCK_AGENT_ID,
		roomId: MOCK_AGENT_ID,
		count: 10_000,
	});
	const text = fragments
		.filter(
			(fragment: Memory) =>
				fragment.metadata?.type === MemoryType.FRAGMENT &&
				fragment.metadata.documentId === result.clientDocumentId,
		)
		.sort(
			(a: Memory, b: Memory) =>
				Number(a.metadata?.position ?? 0) - Number(b.metadata?.position ?? 0),
		)
		.map((fragment: Memory) => fragment.content.text ?? "")
		.join("\n");

	return {
		fragmentCount: result.fragmentCount,
		textLength: text.length,
		textDigest: createHash("sha256").update(text).digest("hex"),
		textPrefix: text.slice(0, 80),
	};
}

describe("DocumentService PDF MIME routing", () => {
	test("extracts identical non-empty fragments for PDF MIME variants", async () => {
		const canonical = await ingestFixture("application/pdf");
		const uppercase = await ingestFixture("APPLICATION/PDF");
		const parameterized = await ingestFixture("application/pdf; charset=UTF-8");

		expect(canonical.fragmentCount).toBeGreaterThan(0);
		expect(canonical.textLength).toBeGreaterThan(0);
		expect(canonical.textPrefix.length).toBeGreaterThan(0);
		process.stderr.write(`PDF_MIME_ARTIFACT ${JSON.stringify(canonical)}\n`);
		expect(uppercase).toEqual(canonical);
		expect(parameterized).toEqual(canonical);
	});
});
