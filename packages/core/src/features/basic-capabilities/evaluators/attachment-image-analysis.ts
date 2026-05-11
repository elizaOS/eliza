import { v4 } from "uuid";
import { imageDescriptionTemplate } from "../../../prompts.ts";
import { EvaluatorPriority } from "../../../services/evaluator-priorities.ts";
import {
	OPTIMIZED_PROMPT_SERVICE,
	type OptimizedPromptService,
} from "../../../services/optimized-prompt.ts";
import { resolveOptimizedPrompt } from "../../../services/optimized-prompt-resolver.ts";
import type {
	Evaluator,
	IAgentRuntime,
	JSONSchema,
	Media,
	Memory,
} from "../../../types/index.ts";
import {
	asUUID,
	ContentType,
	MemoryType,
	ModelType,
} from "../../../types/index.ts";
import { parseJSONObjectFromText } from "../../../utils.ts";

const EVALUATOR_NAME = "attachmentImageAnalysis";
const EVALUATOR_SOURCE = "attachment_image_analysis_evaluator";
const MEMORY_TABLE = "image_analyses";

interface AnalysisRecord {
	attachmentId: string;
	title: string;
	description: string;
	text: string;
}

interface ImageDescriptionJson {
	description?: string;
	title?: string;
	text?: string;
}

interface AttachmentImageAnalysisPrepared {
	analyses: AnalysisRecord[];
}

interface AttachmentImageAnalysisOutput {
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

function hasImageAttachment(message: Memory): boolean {
	const attachments = message.content?.attachments;
	if (!Array.isArray(attachments) || attachments.length === 0) {
		return false;
	}
	return attachments.some((attachment) => isImageAttachment(attachment));
}

function isImageAttachment(attachment: Media): boolean {
	if (attachment.contentType === ContentType.IMAGE) {
		return true;
	}
	const url = attachment.url ?? "";
	return /\.(png|jpe?g|gif|webp|bmp|heic|heif)(?:$|\?)/i.test(url);
}

function normalizeImageDescriptionResponse(
	response: unknown,
): { title: string; description: string; text: string } | null {
	if (typeof response === "string") {
		const parsed = parseJSONObjectFromText(
			response,
		) as ImageDescriptionJson | null;
		if (parsed && (parsed.description || parsed.text)) {
			return {
				title: parsed.title ?? "Image",
				description: parsed.description ?? "",
				text: parsed.text ?? parsed.description ?? "",
			};
		}
		const trimmed = response.trim();
		if (trimmed.length > 0) {
			return {
				title: "Image",
				description: trimmed,
				text: trimmed,
			};
		}
		return null;
	}
	if (response && typeof response === "object") {
		const obj = response as ImageDescriptionJson;
		if (obj.description || obj.text || obj.title) {
			return {
				title: obj.title ?? "Image",
				description: obj.description ?? obj.text ?? "",
				text: obj.text ?? obj.description ?? "",
			};
		}
	}
	return null;
}

async function analyzeImageAttachment(
	runtime: IAgentRuntime,
	attachment: Media,
): Promise<AnalysisRecord | null> {
	const imageUrl = attachment.url?.trim();
	if (!imageUrl) {
		return null;
	}

	const optimizedPromptService = runtime.getService<OptimizedPromptService>(
		OPTIMIZED_PROMPT_SERVICE,
	);
	const prompt = resolveOptimizedPrompt(
		optimizedPromptService,
		"media_description",
		imageDescriptionTemplate,
	);

	const response = await runtime.useModel(ModelType.IMAGE_DESCRIPTION, {
		prompt,
		imageUrl,
	});
	const normalized = normalizeImageDescriptionResponse(response);
	if (!normalized) {
		return null;
	}
	return {
		attachmentId: attachment.id,
		title: normalized.title || attachment.title || "Image",
		description: normalized.description,
		text: normalized.text,
	};
}

async function persistAnalysis(
	runtime: IAgentRuntime,
	message: Memory,
	analysis: AnalysisRecord,
): Promise<void> {
	const memory: Memory = {
		id: asUUID(v4()),
		entityId: runtime.agentId,
		agentId: runtime.agentId,
		roomId: message.roomId,
		content: {
			text: analysis.text || analysis.description,
			type: "image_analysis",
			source: EVALUATOR_SOURCE,
		},
		metadata: {
			type: MemoryType.CUSTOM,
			source: EVALUATOR_SOURCE,
			sourceId: message.id,
			tags: ["image_analysis", "attachment", "auto_capture"],
			attachmentId: analysis.attachmentId,
			title: analysis.title,
			description: analysis.description,
			timestamp: Date.now(),
		},
		createdAt: Date.now(),
	};

	await runtime.createMemory(memory, MEMORY_TABLE, false);
}

export const attachmentImageAnalysisEvaluator: Evaluator<
	AttachmentImageAnalysisOutput,
	AttachmentImageAnalysisPrepared
> = {
	name: EVALUATOR_NAME,
	description:
		"Auto-captures vision descriptions for inbound image attachments and persists them as image_analyses memories.",
	priority: EvaluatorPriority.INBOUND_ATTACHMENT_IMAGE,
	schema: SCHEMA,

	async shouldRun({ message }) {
		return hasImageAttachment(message);
	},

	async prepare({ runtime, message }) {
		const attachments = (message.content?.attachments ?? []) as Media[];
		const imageAttachments = attachments.filter(isImageAttachment);
		const analyses: AnalysisRecord[] = [];

		for (const attachment of imageAttachments) {
			try {
				const analysis = await analyzeImageAttachment(runtime, attachment);
				if (!analysis) {
					continue;
				}
				analyses.push(analysis);
				await persistAnalysis(runtime, message, analysis);
			} catch (error) {
				runtime.logger?.warn?.(
					{
						src: "evaluator:attachment-image-analysis",
						agentId: runtime.agentId,
						attachmentId: attachment.id,
						err: error instanceof Error ? error.message : String(error),
					},
					"Image attachment analysis failed",
				);
			}
		}

		return { analyses };
	},

	prompt({ prepared }) {
		return `${prepared.analyses.length} inbound image attachment(s) were analyzed and persisted by the runtime. Return {"processed": true} to acknowledge.`;
	},

	parse(output) {
		if (output && typeof output === "object" && !Array.isArray(output)) {
			const record = output as Record<string, unknown>;
			return { processed: record.processed === true };
		}
		return { processed: false };
	},
};
