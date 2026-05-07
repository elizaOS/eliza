import { describe, expect, it, vi } from "vitest";
import { readAttachmentAction } from "../features/working-memory/readAttachmentAction.ts";
import type {
	HandlerCallback,
	IAgentRuntime,
	Media,
	Memory,
	UUID,
} from "../types";
import { ContentType, ModelType } from "../types";

const AGENT_ID = "11111111-1111-1111-1111-111111111111" as UUID;
const ENTITY_ID = "22222222-2222-2222-2222-222222222222" as UUID;
const ROOM_ID = "33333333-3333-3333-3333-333333333333" as UUID;

type ModelResponder =
	| string
	| ((modelType: ModelType, params: Record<string, unknown>) => unknown);

function runtimeWithModels(
	responder: ModelResponder,
	recentMessages: Memory[] = [],
): IAgentRuntime {
	return {
		agentId: AGENT_ID,
		getConversationLength: () => 20,
		getMemories: vi.fn(async () => recentMessages),
		useModel: vi.fn(async (modelType, params) =>
			typeof responder === "function"
				? responder(modelType, params)
				: responder,
		),
		logger: {
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
		},
	} as unknown as IAgentRuntime;
}

function attachment(overrides: Partial<Media> = {}): Media {
	const id = overrides.id ?? "attachment-1";
	const contentType = overrides.contentType ?? ContentType.DOCUMENT;
	const extension =
		contentType === ContentType.IMAGE
			? "png"
			: contentType === ContentType.AUDIO
				? "mp3"
				: contentType === ContentType.VIDEO
					? "mp4"
					: "txt";
	return {
		id,
		url:
			overrides.url ??
			`https://cdn.discordapp.com/attachments/1/${id}.${extension}`,
		title: overrides.title ?? `${id}.${extension}`,
		source: overrides.source ?? "Discord",
		contentType,
		text: overrides.text,
		description: overrides.description,
	};
}

function message(text: string, attachments: Media[] = [attachment()]): Memory {
	return {
		id: "44444444-4444-4444-4444-444444444444" as UUID,
		agentId: AGENT_ID,
		entityId: ENTITY_ID,
		roomId: ROOM_ID,
		createdAt: Date.now(),
		content: {
			text,
			source: "discord",
			attachments,
		},
	};
}

async function runReadAttachment(params: {
	responder: ModelResponder;
	request: string;
	attachments?: Media[];
	recentMessages?: Memory[];
}) {
	const runtime = runtimeWithModels(
		params.responder,
		params.recentMessages ?? [],
	);
	const callback = vi.fn(async () => []) as HandlerCallback;
	const result = await readAttachmentAction.handler?.(
		runtime,
		message(params.request, params.attachments),
		undefined,
		undefined,
		callback,
	);
	return { callback, result, runtime };
}

describe("READ_ATTACHMENT", () => {
	it("validates current-message attachments without requiring attachment keywords", async () => {
		const runtime = runtimeWithModels("unused");

		await expect(
			readAttachmentAction.validate?.(
				runtime,
				message("proofread this and list typos", [
					attachment({
						text: "Add the ingerdients to the bowl.",
					}),
				]),
			),
		).resolves.toBe(true);
	});

	for (const scenario of [
		{
			name: "answers exact-value document requests",
			request: "read this and reply with only the secret phrase",
			content: "Secret phrase: saffron-anchor\nReturn only the secret phrase.",
			answer: "saffron-anchor",
			promptIncludes: ["reply with only the secret phrase", "saffron-anchor"],
		},
		{
			name: "keeps proofreading instructions separate from document content",
			request: "proofread this and list typos only",
			content: "Recipe note: Add the ingerdients to a bowl and stir gently.",
			answer: "Typo: ingerdients -> ingredients.",
			promptIncludes: [
				"proofread this and list typos only",
				"Add the ingerdients to a bowl",
			],
		},
		{
			name: "answers reasoning questions from document content",
			request: "which recipe can I make with lentils onion carrot and broth?",
			content:
				"Lentil soup: lentils, onion, carrot, broth\nPancakes: flour, milk, eggs",
			answer:
				"You can make lentil soup with lentils, onion, carrot, and broth.",
			promptIncludes: ["which recipe can I make", "Pancakes: flour"],
		},
		{
			name: "answers exact-value URL requests from link content",
			request: "open this url and reply only with the secret phrase",
			content: "<html><body>Secret phrase: velvet-lantern-7419</body></html>",
			answer: "velvet-lantern-7419",
			promptIncludes: [
				"open this url and reply only with the secret phrase",
				"velvet-lantern-7419",
			],
			contentType: ContentType.LINK,
			source: "Web",
			title: "proof",
			url: "https://example.org/proof",
		},
	]) {
		it(scenario.name, async () => {
			const { callback, result, runtime } = await runReadAttachment({
				responder: scenario.answer,
				request: scenario.request,
				attachments: [
					attachment({
						text: scenario.content,
						contentType: scenario.contentType,
						source: scenario.source ?? "Plaintext",
						title: scenario.title ?? "message.txt",
						url: scenario.url,
					}),
				],
			});

			expect(callback).toHaveBeenCalledWith({
				text: scenario.answer,
				actions: ["READ_ATTACHMENT_SUCCESS"],
				source: "discord",
			});
			expect(result?.text).toBe(scenario.answer);
			const prompt = (
				vi.mocked(runtime.useModel).mock.calls[0]?.[1] as {
					prompt?: string;
				}
			).prompt;
			for (const expected of scenario.promptIncludes) {
				expect(prompt).toContain(expected);
			}
			expect(prompt).not.toContain("ID: attachment-1");
			expect(prompt).not.toContain("file attachment");
		});
	}

	it("keeps metadata output when the user explicitly asks for attachment details", async () => {
		const { result, runtime } = await runReadAttachment({
			responder: "unused",
			request: "show file details",
			attachments: [
				attachment({
					text: "Stored text.",
					source: "Plaintext",
				}),
			],
		});

		expect(result?.text).toContain("ID: attachment-1");
		expect(result?.text).toContain("Stored content: yes");
		expect(runtime.useModel).not.toHaveBeenCalled();
	});

	it("sizes answer token budget from attachment content length", async () => {
		const longContent = "alpha beta gamma delta ".repeat(600);
		const { result, runtime } = await runReadAttachment({
			responder: "summary",
			request: "summarize this document",
			attachments: [
				attachment({
					text: longContent,
					source: "Plaintext",
				}),
			],
		});

		expect(result?.text).toBe("summary");
		const expectedTokens = Math.min(
			Math.max(Math.ceil(longContent.length / 4), 1024),
			4096,
		);
		expect(runtime.useModel).toHaveBeenCalledWith(
			ModelType.TEXT_SMALL,
			expect.objectContaining({
				maxTokens: expectedTokens,
			}),
		);
	});

	it("answers image requests from generated image descriptions", async () => {
		const imageAttachment = attachment({
			id: "image-1",
			contentType: ContentType.IMAGE,
			text: undefined,
			description: undefined,
		});
		const { callback, result, runtime } = await runReadAttachment({
			responder: (modelType) =>
				modelType === ModelType.IMAGE_DESCRIPTION
					? "description: a red square with a black border"
					: "red square",
			request: "what shape is in the image? keep it short",
			attachments: [imageAttachment],
		});

		expect(callback).toHaveBeenCalledWith({
			text: "red square",
			actions: ["READ_ATTACHMENT_SUCCESS"],
			source: "discord",
		});
		expect(result?.text).toBe("red square");
		expect(runtime.useModel).toHaveBeenNthCalledWith(
			1,
			ModelType.IMAGE_DESCRIPTION,
			expect.objectContaining({ imageUrl: imageAttachment.url }),
		);
		expect(runtime.useModel).toHaveBeenNthCalledWith(
			2,
			ModelType.TEXT_SMALL,
			expect.objectContaining({
				prompt: expect.stringContaining("a red square with a black border"),
			}),
		);
	});

	it("answers with all current-message attachments in context", async () => {
		const { result, runtime } = await runReadAttachment({
			responder: "Lentil soup is the matching recipe.",
			request: "use the recipes file and tell me what I can make",
			attachments: [
				attachment({
					id: "recipes",
					title: "recipes.txt",
					text: "Lentil soup: lentils, onion, carrot, broth\nPancakes: flour, milk, eggs",
				}),
				attachment({
					id: "shopping",
					title: "shopping.txt",
					text: "Current ingredients: lentils, onion, carrot, broth",
				}),
			],
		});

		expect(result?.text).toBe("Lentil soup is the matching recipe.");
		expect(result?.data?.attachmentIds).toEqual(["recipes", "shopping"]);
		const prompt = (
			vi.mocked(runtime.useModel).mock.calls[0]?.[1] as {
				prompt?: string;
			}
		).prompt;
		expect(prompt).toContain("Attachment 1: recipes.txt");
		expect(prompt).toContain("Lentil soup: lentils, onion, carrot, broth");
		expect(prompt).toContain("Attachment 2: shopping.txt");
		expect(prompt).toContain("Current ingredients: lentils");
		expect(prompt).not.toContain("Select the attachment ID");
	});

	it("answers from several current-message images when descriptions are available", async () => {
		const descriptions = [
			"description: a red square",
			"description: a green triangle",
			"Both images are simple colored shapes.",
		];
		const { result, runtime } = await runReadAttachment({
			responder: () => descriptions.shift() ?? "",
			request: "what do these images show? keep it short",
			attachments: [
				attachment({
					id: "image-1",
					title: "first.png",
					contentType: ContentType.IMAGE,
					text: undefined,
					description: undefined,
				}),
				attachment({
					id: "image-2",
					title: "second.png",
					contentType: ContentType.IMAGE,
					text: undefined,
					description: undefined,
				}),
			],
		});

		expect(result?.text).toBe("Both images are simple colored shapes.");
		expect(result?.data?.attachmentIds).toEqual(["image-1", "image-2"]);
		expect(runtime.useModel).toHaveBeenNthCalledWith(
			1,
			ModelType.IMAGE_DESCRIPTION,
			expect.objectContaining({ imageUrl: expect.stringContaining("image-1") }),
		);
		expect(runtime.useModel).toHaveBeenNthCalledWith(
			2,
			ModelType.IMAGE_DESCRIPTION,
			expect.objectContaining({ imageUrl: expect.stringContaining("image-2") }),
		);
		const prompt = (
			vi.mocked(runtime.useModel).mock.calls[2]?.[1] as {
				prompt?: string;
			}
		).prompt;
		expect(prompt).toContain("Attachment 1: first.png");
		expect(prompt).toContain("a red square");
		expect(prompt).toContain("Attachment 2: second.png");
		expect(prompt).toContain("a green triangle");
	});

	it("answers from stored media transcripts", async () => {
		const { result, runtime } = await runReadAttachment({
			responder: "preheat the oven to 375 degrees",
			request: "what temp does the video say?",
			attachments: [
				attachment({
					id: "video-1",
					contentType: ContentType.VIDEO,
					text: "Transcript: The speaker says to preheat the oven to 375 degrees.",
				}),
			],
		});

		expect(result?.text).toBe("preheat the oven to 375 degrees");
		expect(runtime.useModel).toHaveBeenCalledWith(
			ModelType.TEXT_SMALL,
			expect.objectContaining({
				prompt: expect.stringContaining("Transcript: The speaker says"),
			}),
		);
	});

	it("validates previous-message media requests by media wording", async () => {
		const previous = message("", [
			attachment({
				contentType: ContentType.AUDIO,
				text: undefined,
				description: undefined,
			}),
		]);
		previous.createdAt = Date.now() - 1000;
		const runtime = runtimeWithModels("unused", [previous]);

		await expect(
			readAttachmentAction.validate?.(
				runtime,
				message("what does the audio say?", []),
			),
		).resolves.toBe(true);
	});

	it("keeps media-without-transcript replies user-facing", async () => {
		const { callback, result, runtime } = await runReadAttachment({
			responder: "unused",
			request: "what does this audio say?",
			attachments: [
				attachment({
					contentType: ContentType.AUDIO,
					text: undefined,
					description: undefined,
				}),
			],
		});

		expect(callback).toHaveBeenCalledWith({
			text: "I don't have a transcript for that attachment yet.",
			actions: ["READ_ATTACHMENT_SUCCESS"],
			source: "discord",
		});
		expect(result?.text).toBe(
			"I don't have a transcript for that attachment yet.",
		);
		expect(runtime.useModel).not.toHaveBeenCalled();
	});

	it("keeps multi-image missing-description replies user-facing", async () => {
		const { result, runtime } = await runReadAttachment({
			responder: "",
			request: "what do these images show?",
			attachments: [
				attachment({
					id: "image-1",
					contentType: ContentType.IMAGE,
					text: undefined,
					description: undefined,
				}),
				attachment({
					id: "image-2",
					contentType: ContentType.IMAGE,
					text: undefined,
					description: undefined,
				}),
			],
		});

		expect(result?.text).toBe(
			"I couldn't generate readable descriptions for those images.",
		);
		expect(runtime.useModel).toHaveBeenCalledTimes(2);
	});

	it("keeps image provider failures out of the user reply", async () => {
		const { result, runtime } = await runReadAttachment({
			responder: () => {
				throw new Error("401 Unauthorized");
			},
			request: "what do these images show?",
			attachments: [
				attachment({
					id: "image-1",
					contentType: ContentType.IMAGE,
					text: undefined,
					description: undefined,
				}),
				attachment({
					id: "image-2",
					contentType: ContentType.IMAGE,
					text: undefined,
					description: undefined,
				}),
			],
		});

		expect(result?.text).toBe(
			"I couldn't generate readable descriptions for those images.",
		);
		expect(String(result?.text)).not.toContain("401");
		expect(runtime.logger.warn).toHaveBeenCalledTimes(2);
	});
});
