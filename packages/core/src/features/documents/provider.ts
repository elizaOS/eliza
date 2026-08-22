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

import { logger } from "../../logger";
import {
	type IAgentRuntime,
	type Memory,
	MemoryType,
	type Provider,
} from "../../types";
import { addHeader } from "../../utils";
import { truncateWellFormed } from "../../utils/well-formed.ts";
import { DocumentService } from "./service.ts";
import type { DocumentMetadataExtended } from "./types.ts";
import { normalizeDocumentSourceValue } from "./utils.ts";

const PINNED_DOCUMENT_TOKEN_BUDGET = 8_000;
const APPROXIMATE_CHARACTERS_PER_TOKEN = 4;

export const PINNED_DOCUMENT_TRUNCATION_MARKER =
	"[Pinned document content omitted from this prompt. Use DOCUMENT read with its document ID to page the exact source.]";

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
	tokenBudget = PINNED_DOCUMENT_TOKEN_BUDGET,
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
	const maximumCharacters = tokenBudget * APPROXIMATE_CHARACTERS_PER_TOKEN;
	let truncated = false;
	const identityCatalog = pinned
		.map(
			(document, index) =>
				`- ${getDocumentTitle(document, index)} (${document.id}; reference: document:${document.id})`,
		)
		.join("\n");
	const fixedCharacters =
		identityCatalog.length + PINNED_DOCUMENT_TRUNCATION_MARKER.length + 4;
	const fairContentCharacters =
		pinned.length === 0
			? 0
			: Math.max(
					0,
					Math.floor((maximumCharacters - fixedCharacters) / pinned.length),
				);
	for (const [index, document] of pinned.entries()) {
		const content = document.content.text ?? "";
		const excerpt = truncateWellFormed(content, fairContentCharacters);
		const block = `## ${getDocumentTitle(document, index)} (${document.id})\n${excerpt}`;
		blocks.push(block);
		includedIds.push(document.id);
		if (excerpt.length < content.length) truncated = true;
	}
	if (truncated) {
		blocks.push(`${PINNED_DOCUMENT_TRUNCATION_MARKER}\n${identityCatalog}`);
	}
	return { text: blocks.join("\n\n"), truncated, includedIds };
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
				limit: 25,
			});
		const pinned = renderPinnedDocuments(pinnedDocuments);
		if (pinned.truncated) {
			logger.warn(
				{
					tokenBudget: PINNED_DOCUMENT_TOKEN_BUDGET,
					pinnedDocumentCount: pinnedDocuments.length,
					includedDocumentCount: pinned.includedIds.length,
				},
				"[DocumentsProvider] Pinned document content was explicitly truncated; exact content remains available through paged DOCUMENT reads",
			);
		}
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
