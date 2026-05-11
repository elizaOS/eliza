import { v4 } from "uuid";
import { EvaluatorPriority } from "../../../services/evaluator-priorities.ts";
import type {
	Evaluator,
	IAgentRuntime,
	JSONSchema,
	Memory,
} from "../../../types/index.ts";
import { asUUID } from "../../../types/index.ts";
import { MemoryType, ModelType } from "../../../types/index.ts";

const EVALUATOR_NAME = "linkExtraction";
const EVALUATOR_SOURCE = "link_extraction_evaluator";
const MEMORY_TABLE = "links";
const URL_REGEX = /https?:\/\/[^\s<>"'`)]+/gi;
const MAX_LINKS_PER_MESSAGE = 5;
const SUMMARY_FETCH_TIMEOUT_MS = 5_000;
const SUMMARY_MAX_INPUT_CHARS = 4_000;

interface LinkRecord {
	url: string;
	title: string;
	summary: string;
}

interface LinkExtractionPrepared {
	links: LinkRecord[];
}

interface LinkExtractionOutput {
	processed: boolean;
}

const SCHEMA: JSONSchema = {
	type: "object",
	properties: {
		processed: { type: "boolean" },
	},
	required: ["processed"],
	additionalProperties: false,
};

function getMessageText(message: Memory): string {
	const content = message.content;
	if (!content) {
		return "";
	}
	const text = content.text;
	return typeof text === "string" ? text : "";
}

function extractUrls(text: string): string[] {
	const matches = text.match(URL_REGEX);
	if (!matches) {
		return [];
	}
	const seen = new Set<string>();
	const urls: string[] = [];
	for (const raw of matches) {
		const trimmed = stripTrailingPunctuation(raw);
		if (!trimmed) {
			continue;
		}
		if (seen.has(trimmed)) {
			continue;
		}
		seen.add(trimmed);
		urls.push(trimmed);
		if (urls.length >= MAX_LINKS_PER_MESSAGE) {
			break;
		}
	}
	return urls;
}

function stripTrailingPunctuation(url: string): string {
	let result = url;
	while (result.length > 0 && /[.,;:!?\])}>]/.test(result.slice(-1))) {
		result = result.slice(0, -1);
	}
	return result;
}

function hasUrl(message: Memory): boolean {
	const text = getMessageText(message);
	if (!text) {
		return false;
	}
	URL_REGEX.lastIndex = 0;
	return URL_REGEX.test(text);
}

function extractTitle(html: string): string {
	const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
	if (titleMatch?.[1]) {
		return decodeHtmlEntities(titleMatch[1])
			.replace(/\s+/g, " ")
			.trim()
			.slice(0, 200);
	}
	const ogMatch = html.match(
		/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i,
	);
	if (ogMatch?.[1]) {
		return decodeHtmlEntities(ogMatch[1]).trim().slice(0, 200);
	}
	return "";
}

function decodeHtmlEntities(value: string): string {
	return value
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/gi, "'")
		.replace(/&nbsp;/gi, " ");
}

function stripTags(html: string): string {
	return html
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

async function fetchLinkPreview(
	url: string,
): Promise<{ title: string; bodyChunk: string } | null> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), SUMMARY_FETCH_TIMEOUT_MS);
	try {
		const response = await fetch(url, {
			signal: controller.signal,
			redirect: "follow",
			headers: {
				accept: "text/html,application/xhtml+xml",
				"user-agent": "Mozilla/5.0 (compatible; ElizaLinkPreview/1.0)",
			},
		});
		if (!response.ok) {
			return null;
		}
		const contentType = response.headers.get("content-type") ?? "";
		if (!/text\/html|application\/xhtml/i.test(contentType)) {
			return null;
		}
		const html = (await response.text()).slice(0, 200_000);
		const title = extractTitle(html);
		const bodyChunk = stripTags(html).slice(0, SUMMARY_MAX_INPUT_CHARS);
		return { title, bodyChunk };
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

async function summarizeLink(
	runtime: IAgentRuntime,
	url: string,
	title: string,
	bodyChunk: string,
): Promise<string> {
	if (!bodyChunk.trim()) {
		return "";
	}
	const prompt = `Summarize the following web page in one short paragraph (max 3 sentences). Focus on what the page is about. Do not invent details.

URL: ${url}
Title: ${title || "(unknown)"}
Body excerpt:
${bodyChunk}

Summary:`;
	const response = await runtime.useModel(ModelType.TEXT_SMALL, { prompt });
	if (typeof response === "string") {
		return response.trim().slice(0, 1_000);
	}
	return "";
}

async function buildLinkRecord(
	runtime: IAgentRuntime,
	url: string,
): Promise<LinkRecord> {
	const baseRecord: LinkRecord = {
		url,
		title: "",
		summary: "",
	};
	const preview = await fetchLinkPreview(url);
	if (!preview) {
		return baseRecord;
	}
	baseRecord.title = preview.title;
	try {
		baseRecord.summary = await summarizeLink(
			runtime,
			url,
			preview.title,
			preview.bodyChunk,
		);
	} catch (error) {
		runtime.logger?.warn?.(
			{
				src: "evaluator:link-extraction",
				agentId: runtime.agentId,
				url,
				err: error instanceof Error ? error.message : String(error),
			},
			"Link summarization failed",
		);
	}
	return baseRecord;
}

async function persistLink(
	runtime: IAgentRuntime,
	message: Memory,
	link: LinkRecord,
): Promise<void> {
	const text = link.summary || link.title || link.url;
	const memory: Memory = {
		id: asUUID(v4()),
		entityId: runtime.agentId,
		agentId: runtime.agentId,
		roomId: message.roomId,
		content: {
			text,
			type: "link",
			source: EVALUATOR_SOURCE,
			url: link.url,
		},
		metadata: {
			type: MemoryType.CUSTOM,
			source: EVALUATOR_SOURCE,
			sourceId: message.id,
			tags: ["link", "auto_capture"],
			url: link.url,
			title: link.title,
			summary: link.summary,
			timestamp: Date.now(),
		},
		createdAt: Date.now(),
	};

	await runtime.createMemory(memory, MEMORY_TABLE, false);
}

export const linkExtractionEvaluator: Evaluator<
	LinkExtractionOutput,
	LinkExtractionPrepared
> = {
	name: EVALUATOR_NAME,
	description:
		"Auto-captures http(s) URLs from inbound message text, optionally fetches a title/summary, and persists them as link memories.",
	priority: EvaluatorPriority.INBOUND_LINK_EXTRACTION,
	schema: SCHEMA,

	async shouldRun({ message }) {
		return hasUrl(message);
	},

	async prepare({ runtime, message }) {
		const text = getMessageText(message);
		const urls = extractUrls(text);
		const links: LinkRecord[] = [];

		for (const url of urls) {
			try {
				const record = await buildLinkRecord(runtime, url);
				links.push(record);
				await persistLink(runtime, message, record);
			} catch (error) {
				runtime.logger?.warn?.(
					{
						src: "evaluator:link-extraction",
						agentId: runtime.agentId,
						url,
						err: error instanceof Error ? error.message : String(error),
					},
					"Link extraction failed",
				);
			}
		}

		return { links };
	},

	prompt({ prepared }) {
		return `${prepared.links.length} inbound http(s) URL(s) were captured and persisted by the runtime. Return {"processed": true} to acknowledge.`;
	},

	parse(output) {
		if (output && typeof output === "object" && !Array.isArray(output)) {
			const record = output as Record<string, unknown>;
			return { processed: record.processed === true };
		}
		return { processed: false };
	},
};
