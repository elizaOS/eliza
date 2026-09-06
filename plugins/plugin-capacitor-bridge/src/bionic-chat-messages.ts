/** Preserves complete text messages for formatting by the loaded native model. */
import { ElizaError, type GenerateTextParams } from "@elizaos/core";

export interface BionicChatMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

function invalid(reason: string): never {
	throw new ElizaError(`Bionic chat input is invalid: ${reason}`, {
		code: "BIONIC_CHAT_INPUT_INVALID",
		context: { reason },
	});
}

export function buildBionicChatInput(params: GenerateTextParams): {
	messages: BionicChatMessage[];
	enableThinking: boolean;
} {
	if (
		params.attachments?.length ||
		params.tools?.length ||
		params.responseSchema ||
		params.responseSkeleton ||
		params.grammar ||
		params.prefill ||
		params.spanSamplerPlan
	) {
		invalid(
			"the text-only native path cannot discard attachments, tools, prefills, or structured-output controls",
		);
	}
	const messages: BionicChatMessage[] = [];
	if (params.messages?.length) {
		if (params.prompt !== undefined)
			invalid("provide messages or a prompt, not both");
		for (const message of params.messages) {
			if (
				message.role !== "system" &&
				message.role !== "user" &&
				message.role !== "assistant"
			) {
				invalid(`unsupported message role ${message.role}`);
			}
			if (typeof message.content !== "string")
				invalid("message content must be complete text");
			if (
				Object.keys(message).some((key) => key !== "role" && key !== "content")
			) {
				invalid(
					"additional message fields require a native capability that preserves them",
				);
			}
			messages.push({ role: message.role, content: message.content });
		}
	} else {
		const prompt =
			params.prompt ??
			params.promptSegments?.map((segment) => segment.content).join("");
		if (typeof prompt !== "string" || prompt.length === 0)
			invalid("no complete text was supplied");
		messages.push({ role: "user", content: prompt });
	}
	if (
		params.system !== undefined &&
		!(messages[0]?.role === "system" && messages[0].content === params.system)
	) {
		messages.unshift({ role: "system", content: params.system });
	}
	const options = params.providerOptions?.eliza;
	const thinking =
		options && typeof options === "object" && "thinking" in options
			? options.thinking
			: undefined;
	if (
		thinking !== undefined &&
		thinking !== "on" &&
		thinking !== "off" &&
		thinking !== "auto"
	) {
		invalid("thinking must be on, off, or auto");
	}
	return { messages, enableThinking: thinking !== "off" };
}
