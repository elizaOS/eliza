/**
 * The `DOCUMENTS` dynamic provider: injects the agent's relevant and recent
 * documents into the prompt for the `documents` context. It pulls the
 * relevant fragments (via `DocumentService.searchDocuments`) plus the list
 * of available/recent documents (via `listDocuments`), rendering snippets and
 * document IDs the agent can cite or follow up to read. Returns an
 * empty/unavailable payload when no `DocumentService` is registered. Gated to the
 * exact `documents` and `knowledge` contexts and a minimum `USER` role, with
 * per-turn cache scope.
 */
import {
	type IAgentRuntime,
	type Memory,
	MemoryType,
	type Provider,
} from "../../types";
import { addHeader } from "../../utils";
import { DocumentService } from "./service.ts";
import type { DocumentMetadataExtended } from "./types.ts";
import { normalizeDocumentSourceValue } from "./utils.ts";

function getDocumentTitle(memory: Memory, index: number): string {
	const metadata = memory.metadata as DocumentMetadataExtended | undefined;
	const title =
		metadata?.title ?? metadata?.filename ?? metadata?.documentTitle;
	return typeof title === "string" && title.trim().length > 0
		? title.trim()
		: `Document ${index + 1}`;
}

export function renderPinnedDocuments(
	documents: Memory[],
	_tokenBudget?: number,
): { text: string; truncated: boolean; includedIds: Array<Memory["id"]> } {
	const pinned = documents
		.filter((document) => {
			const metadata = document.metadata as
				| DocumentMetadataExtended
				| undefined;
			return metadata?.type === MemoryType.DOCUMENT && metadata.pinned === true;
		})
		.sort((a, b) => {
			const titleOrder = getDocumentTitle(a, 0).localeCompare(
				getDocumentTitle(b, 0),
			);
			return titleOrder || String(a.id ?? "").localeCompare(String(b.id ?? ""));
		});
	const includedIds: Array<Memory["id"]> = [];
	const blocks: string[] = [];
	for (const [index, document] of pinned.entries()) {
		const block = `## ${getDocumentTitle(document, index)} (${document.id})\n${document.content.text ?? ""}`;
		blocks.push(block);
		includedIds.push(document.id);
	}
	return { text: blocks.join("\n\n"), truncated: false, includedIds };
}

function summarizeDocument(memory: Memory, index: number) {
	const metadata = memory.metadata as DocumentMetadataExtended | undefined;
	return {
		id: memory.id,
		name: getDocumentTitle(memory, index),
		scope: metadata?.scope ?? "global",
		source: normalizeDocumentSourceValue(metadata?.source),
		updatedAt:
			typeof metadata?.editedAt === "number"
				? metadata.editedAt
				: memory.createdAt,
	};
}

export const documentsProvider: Provider = {
	name: "DOCUMENTS",
	description:
		"Relevant and recent documents from the agent document store, including snippets and document IDs for follow-up reads.",
	position: -10,
	dynamic: true,
	// Context gates use exact membership rather than expanding parent/child
	// relationships. Stage 1 can route stored-knowledge requests directly to
	// `knowledge`, so both exact contexts must opt into the same scoped provider.
	contexts: ["documents", "knowledge"],
	contextGate: { anyOf: ["documents", "knowledge"] },
	cacheStable: false,
	cacheScope: "turn",
	roleGate: { minRole: "USER" },

	get: async (runtime: IAgentRuntime, message: Memory) => {
		const service = runtime.getService<DocumentService>(
			DocumentService.serviceType,
		);
		if (!service) {
			return {
				text: "",
				values: {
					documentsAvailable: false,
					documentsRelevant: [],
					documents: [],
				},
				data: { available: false },
			};
		}

		const { relevantFragments, documents, pinnedDocuments } =
			await service.composeProviderDocuments(message, {
				limit: Number.MAX_SAFE_INTEGER,
			});
		const pinned = renderPinnedDocuments(pinnedDocuments);
		const relevantSnippets = relevantFragments.map((fragment, index) => {
			const metadata = fragment.metadata as
				| DocumentMetadataExtended
				| undefined;
			return {
				id: fragment.id,
				documentId: metadata?.documentId,
				name:
					metadata?.filename ??
					metadata?.title ??
					(typeof metadata?.documentTitle === "string"
						? metadata.documentTitle
						: undefined) ??
					`Snippet ${index + 1}`,
				text: fragment.content.text ?? "",
				score: fragment.similarity,
				scope: metadata?.scope ?? "global",
			};
		});

		const summaries = documents
			.filter((memory) => memory.metadata?.type === MemoryType.DOCUMENT)
			.map(summarizeDocument);
		const recentDocuments = summaries;

		const snippetsText = relevantSnippets
			.map((item) => `- [${item.name}] ${item.text}`)
			.join("\n");
		const recentText = recentDocuments
			.map((item) => `- ${item.name} (${item.id}, ${item.scope})`)
			.join("\n");
		const text = addHeader(
			"# Documents",
			[
				pinned.text
					? `Pinned knowledge (always applicable):\n${pinned.text}`
					: "",
				snippetsText,
				recentText ? `Recent documents:\n${recentText}` : "",
			]
				.filter(Boolean)
				.join("\n\n"),
		);

		const payload = {
			documents: summaries,
			documentsAvailable: summaries.length > 0,
			documentsRelevant: relevantSnippets,
			recentDocuments,
			documentsCount: summaries.length,
			pinnedDocumentIds: pinned.includedIds,
			pinnedDocumentsTruncated: pinned.truncated,
		};

		return {
			text,
			values: payload,
			data: {
				...payload,
				available: true,
			},
		};
	},
};
