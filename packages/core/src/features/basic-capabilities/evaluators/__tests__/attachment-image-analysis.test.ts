import { describe, expect, it, vi } from "vitest";
import type {
	EvaluatorRunContext,
	Memory,
	State,
	UUID,
} from "../../../../types/index.ts";
import { ContentType, ModelType } from "../../../../types/index.ts";
import { attachmentImageAnalysisEvaluator } from "../attachment-image-analysis.ts";

const AGENT_ID = "00000000-0000-0000-0000-000000000001" as UUID;
const ENTITY_ID = "00000000-0000-0000-0000-000000000002" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-000000000003" as UUID;
const MESSAGE_ID = "00000000-0000-0000-0000-0000000000aa" as UUID;

type MockRuntime = {
	agentId: UUID;
	character: { name: string };
	useModel: ReturnType<typeof vi.fn>;
	createMemory: ReturnType<typeof vi.fn>;
	getService: ReturnType<typeof vi.fn>;
	logger: {
		debug: ReturnType<typeof vi.fn>;
		info: ReturnType<typeof vi.fn>;
		warn: ReturnType<typeof vi.fn>;
		error: ReturnType<typeof vi.fn>;
		trace: ReturnType<typeof vi.fn>;
	};
};

function makeRuntime(
	useModelImpl: (modelType: string, params: unknown) => Promise<unknown>,
): MockRuntime {
	return {
		agentId: AGENT_ID,
		character: { name: "TestAgent" },
		useModel: vi.fn(useModelImpl),
		createMemory: vi.fn(async () => "00000000-0000-0000-0000-0000000000ff"),
		getService: vi.fn(() => undefined),
		logger: {
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			trace: vi.fn(),
		},
	};
}

function makeMessage(
	attachments: Array<{
		id: string;
		url: string;
		contentType?: (typeof ContentType)[keyof typeof ContentType];
		title?: string;
	}> = [],
): Memory {
	return {
		id: MESSAGE_ID,
		entityId: ENTITY_ID,
		agentId: AGENT_ID,
		roomId: ROOM_ID,
		content: {
			text: "look at this",
			attachments,
		},
		createdAt: Date.now(),
	} as Memory;
}

function makeContext(
	runtime: MockRuntime,
	message: Memory,
): EvaluatorRunContext {
	return {
		runtime: runtime as unknown as EvaluatorRunContext["runtime"],
		message,
		options: {},
	};
}

describe("attachmentImageAnalysisEvaluator", () => {
	it("shouldRun is false when the message has no attachments", async () => {
		const runtime = makeRuntime(async () => "");
		const message = makeMessage();
		const result = await attachmentImageAnalysisEvaluator.shouldRun(
			makeContext(runtime, message),
		);
		expect(result).toBe(false);
	});

	it("shouldRun is false when attachments are present but none are images", async () => {
		const runtime = makeRuntime(async () => "");
		const message = makeMessage([
			{
				id: "att-1",
				url: "https://example.com/file.pdf",
				contentType: ContentType.DOCUMENT,
			},
		]);
		const result = await attachmentImageAnalysisEvaluator.shouldRun(
			makeContext(runtime, message),
		);
		expect(result).toBe(false);
	});

	it("shouldRun is true when any attachment is an image by contentType", async () => {
		const runtime = makeRuntime(async () => "");
		const message = makeMessage([
			{
				id: "att-1",
				url: "https://example.com/file.bin",
				contentType: ContentType.IMAGE,
			},
		]);
		const result = await attachmentImageAnalysisEvaluator.shouldRun(
			makeContext(runtime, message),
		);
		expect(result).toBe(true);
	});

	it("shouldRun is true when attachment URL ends with an image extension", async () => {
		const runtime = makeRuntime(async () => "");
		const message = makeMessage([
			{ id: "att-1", url: "https://example.com/photo.PNG" },
		]);
		const result = await attachmentImageAnalysisEvaluator.shouldRun(
			makeContext(runtime, message),
		);
		expect(result).toBe(true);
	});

	it("prepare calls IMAGE_DESCRIPTION per image and persists an analysis memory each", async () => {
		const runtime = makeRuntime(async (modelType) => {
			expect(modelType).toBe(ModelType.IMAGE_DESCRIPTION);
			return {
				title: "Two cats on a sofa",
				description: "Two cats lounging on a beige sofa.",
				text: "Two cats lounging on a beige sofa with a window in the background.",
			};
		});
		const message = makeMessage([
			{
				id: "att-1",
				url: "https://example.com/cat1.jpg",
				contentType: ContentType.IMAGE,
			},
			{
				id: "att-2",
				url: "https://example.com/cat2.jpg",
				contentType: ContentType.IMAGE,
			},
		]);
		const context = {
			...makeContext(runtime, message),
			state: { values: {}, data: {}, text: "" } as State,
		};
		const prepared = await attachmentImageAnalysisEvaluator.prepare?.(context);
		expect(prepared).toBeDefined();
		expect(prepared?.analyses).toHaveLength(2);
		expect(runtime.useModel).toHaveBeenCalledTimes(2);
		expect(runtime.createMemory).toHaveBeenCalledTimes(2);

		const firstCreate = runtime.createMemory.mock.calls[0] as [
			Memory,
			string,
			boolean,
		];
		const [memory, tableName] = firstCreate;
		expect(tableName).toBe("image_analyses");
		expect(memory.roomId).toBe(ROOM_ID);
		expect(memory.agentId).toBe(AGENT_ID);
		expect(memory.content.type).toBe("image_analysis");
		expect(memory.content.source).toBe("attachment_image_analysis_evaluator");
		expect(memory.content.text).toContain("Two cats");
		expect(memory.metadata?.type).toBe("custom");
		expect((memory.metadata as Record<string, unknown>).attachmentId).toBe(
			"att-1",
		);
		expect((memory.metadata as Record<string, unknown>).tags).toEqual(
			expect.arrayContaining(["image_analysis", "attachment", "auto_capture"]),
		);
	});

	it("prepare swallows per-attachment errors and continues with remaining images", async () => {
		const runtime = makeRuntime(async (_modelType, params) => {
			const url = (params as { imageUrl: string }).imageUrl;
			if (url.endsWith("bad.jpg")) {
				throw new Error("vision failed");
			}
			return {
				title: "Photo",
				description: "A photo.",
				text: "A photo.",
			};
		});
		const message = makeMessage([
			{
				id: "att-bad",
				url: "https://example.com/bad.jpg",
				contentType: ContentType.IMAGE,
			},
			{
				id: "att-ok",
				url: "https://example.com/ok.jpg",
				contentType: ContentType.IMAGE,
			},
		]);
		const context = {
			...makeContext(runtime, message),
			state: { values: {}, data: {}, text: "" } as State,
		};
		const prepared = await attachmentImageAnalysisEvaluator.prepare?.(context);
		expect(prepared?.analyses).toHaveLength(1);
		expect(prepared?.analyses[0].attachmentId).toBe("att-ok");
		expect(runtime.createMemory).toHaveBeenCalledTimes(1);
		expect(runtime.logger.warn).toHaveBeenCalled();
	});

	it("parse normalizes the LLM output into { processed }", () => {
		expect(
			attachmentImageAnalysisEvaluator.parse?.({ processed: true }),
		).toEqual({ processed: true });
		expect(
			attachmentImageAnalysisEvaluator.parse?.({ processed: "yes" }),
		).toEqual({ processed: false });
		expect(attachmentImageAnalysisEvaluator.parse?.(null)).toEqual({
			processed: false,
		});
	});

	it("declares the expected name, priority, and schema", () => {
		expect(attachmentImageAnalysisEvaluator.name).toBe(
			"attachmentImageAnalysis",
		);
		expect(attachmentImageAnalysisEvaluator.priority).toBe(60);
		const schema = attachmentImageAnalysisEvaluator.schema as {
			type: string;
			properties: Record<string, unknown>;
			required: string[];
		};
		expect(schema.type).toBe("object");
		expect(schema.required).toEqual(["processed"]);
		expect(schema.properties.processed).toBeDefined();
	});
});
