import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { V5_MESSAGE_HANDLER_TOOL_NAME } from "../prompts/message-handler";
import { runV5MessageRuntimeStage1 } from "../services/message";
import type {
	Action,
	ActionResult,
	HandlerCallback,
	HandlerOptions,
} from "../types/components";
import type { ContextRegistry } from "../types/contexts";
import type { Memory } from "../types/memory";
import { ModelType } from "../types/model";
import type { UUID } from "../types/primitives";
import type { IAgentRuntime } from "../types/runtime";
import type { State } from "../types/state";

const MSG_ID = "10000000-0000-0000-0000-000000000001" as UUID;
const SENDER_ID = "10000000-0000-0000-0000-000000000002" as UUID;
const AGENT_ID = "10000000-0000-0000-0000-000000000003" as UUID;
const ROOM_ID = "10000000-0000-0000-0000-000000000004" as UUID;
const RESPONSE_ID = "10000000-0000-0000-0000-000000000005" as UUID;

interface CannedResponse {
	expectModelType?: string;
	body: unknown;
}

function makeMessage(): Memory {
	return {
		id: MSG_ID,
		entityId: SENDER_ID,
		agentId: AGENT_ID,
		roomId: ROOM_ID,
		content: {
			text: "Build a production-ready full-stack task website, repair any implementation markers, then run lint, tests, and build before replying.",
			source: "test",
		},
		createdAt: 1,
	};
}

function makeState(): State {
	return {
		values: { availableContexts: "simple, general" },
		text: "Recent conversation: the operator wants an end-to-end website build with strict quality gates.",
		data: {
			providerOrder: ["RECENT_MESSAGES", "CONTEXT_BENCH"],
			providers: {
				RECENT_MESSAGES: {
					providerName: "RECENT_MESSAGES",
					text: "Operator requested a full-stack website build and quality verification.",
				},
				CONTEXT_BENCH: {
					providerName: "CONTEXT_BENCH",
					text: "Stress scenario: many tool steps, long generated artifacts, compaction, lint failure recovery, test pass, build pass, and trajectory export.",
				},
			},
		},
	};
}

function makeContextRegistry(): ContextRegistry {
	return {
		listAvailable: () => [
			{
				id: "simple",
				label: "Simple",
				description: "Direct reply only.",
				gate: { minRole: "GUEST" as const },
			},
			{
				id: "general",
				label: "General",
				description: "General agent work and local development tasks.",
				gate: { minRole: "GUEST" as const },
			},
		],
	} as unknown as ContextRegistry;
}

function makeRuntime(opts: {
	actions: Action[];
	responses: CannedResponse[];
	state: State;
	contextRegistry?: ContextRegistry;
}): IAgentRuntime {
	const queue = [...opts.responses];
	const calls: Array<{
		modelType: unknown;
		params: unknown;
		provider: unknown;
	}> = [];
	const runtime = {
		agentId: AGENT_ID,
		character: { name: "Test Agent", system: "You are concise." },
		actions: opts.actions,
		providers: [],
		contexts: opts.contextRegistry,
		composeState: vi.fn(async () => opts.state),
		emitEvent: vi.fn(async () => undefined),
		runActionsByMode: vi.fn(async () => []),
		useModel: vi.fn(
			async (modelType: unknown, params: unknown, provider: unknown) => {
				calls.push({ modelType, params, provider });
				if (queue.length === 0) {
					throw new Error(`Unexpected useModel call: ${String(modelType)}`);
				}
				const next = queue.shift();
				if (
					next?.expectModelType &&
					String(modelType) !== next.expectModelType
				) {
					throw new Error(
						`Expected ${next.expectModelType} but received ${String(modelType)}`,
					);
				}
				return next?.body;
			},
		),
		logger: {
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			trace: vi.fn(),
		},
	} as unknown as IAgentRuntime & { __calls: typeof calls };
	runtime.__calls = calls;
	return runtime;
}

function getCalls(runtime: IAgentRuntime): Array<{
	modelType: unknown;
	params: unknown;
	provider: unknown;
}> {
	return (
		runtime as unknown as {
			__calls: Array<{
				modelType: unknown;
				params: unknown;
				provider: unknown;
			}>;
		}
	).__calls;
}

function makeAction(opts: {
	name: string;
	parameters?: Action["parameters"];
	handler: (
		runtime: IAgentRuntime,
		message: Memory,
		state: State | undefined,
		options: HandlerOptions,
		callback?: HandlerCallback,
	) => Promise<ActionResult>;
}): Action {
	return {
		name: opts.name,
		description: `${opts.name} test action`,
		contexts: ["general"],
		similes: [],
		examples: [],
		parameters: opts.parameters ?? [],
		validate: async () => true,
		handler: opts.handler,
	} as unknown as Action;
}

function readRecordedTrajectories(agentId: string, rootDir: string): unknown[] {
	const dir = join(rootDir, agentId);
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return [];
	}
	return entries
		.filter((entry) => entry.endsWith(".json"))
		.map((entry) => JSON.parse(readFileSync(join(dir, entry), "utf8")));
}

let tempDir: string;
let originalEnv: NodeJS.ProcessEnv;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "v5-stress-compaction-"));
	originalEnv = { ...process.env };
	process.env.MILADY_TRAJECTORY_DIR = tempDir;
	process.env.MILADY_TRAJECTORY_RECORDING = "1";
	process.env.MILADY_TRAJECTORY_REVIEW_MODE = "1";
});

afterEach(() => {
	process.env = originalEnv;
	rmSync(tempDir, { recursive: true, force: true });
});

describe("v5 stress path — long build, compaction, gates, trajectory export", () => {
	it("runs a many-step website build simulation through compaction and exports reviewable trajectories", async () => {
		const implementationMarker = ["TO", "DO"].join("");
		const forbiddenMarkers = [
			implementationMarker,
			["ST", "UB"].join(""),
			["PLACE", "HOLDER"].join(""),
			["Not", " implemented"].join(""),
		];
		const forbiddenPattern = new RegExp(
			forbiddenMarkers
				.map((marker) => marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
				.join("|"),
			"i",
		);
		const files = new Map<string, string>();

		const generatedApp = [
			"// TaskFlow full-stack app",
			"import { useMemo, useState } from 'react';",
			"",
			"type Task = { id: string; title: string; owner: string; done: boolean };",
			"",
			"export function createTask(title: string, owner: string): Task {",
			"  return { id: String(Date.now()) + '-' + title, title, owner, done: false };",
			"}",
			"",
			"export function App() {",
			"  const [tasks, setTasks] = useState<Task[]>([createTask('Design API', 'Eliza')]);",
			"  const complete = (id: string) => setTasks((items) => items.map((item) => item.id === id ? { ...item, done: true } : item));",
			"  const open = useMemo(() => tasks.filter((task) => !task.done).length, [tasks]);",
			`  // ${implementationMarker}: replace temporary analytics label before release`,
			"  return <main><h1>TaskFlow</h1><p>{open} open tasks</p><button onClick={() => complete(tasks[0].id)}>Complete first</button></main>;",
			"}",
			"",
			...Array.from(
				{ length: 700 },
				(_, index) => `export const generatedMetric${index} = ${index};`,
			),
		].join("\n");

		const actions = [
			makeAction({
				name: "GENERATE_FULL_STACK_APP",
				handler: async () => ({
					success: true,
					text: `Generated TaskFlow app:\n${generatedApp}`,
					data: {
						actionName: "GENERATE_FULL_STACK_APP",
						files: {
							"src/App.tsx": generatedApp,
							"src/api/tasks.ts":
								"export const listTasks = () => [{ id: '1', title: 'Design API' }];\n",
							"package.json": JSON.stringify({
								scripts: {
									lint: "eslint .",
									test: "vitest run",
									build: "vite build",
								},
							}),
						},
					},
				}),
			}),
			makeAction({
				name: "WRITE_APP_FILES",
				handler: async (_runtime, _message, _state, options) => {
					const prior = options.actionContext?.getPreviousResult(
						"GENERATE_FULL_STACK_APP",
					);
					const generatedFiles = prior?.data?.files as
						| Record<string, string>
						| undefined;
					if (!generatedFiles) {
						return {
							success: false,
							text: "No generated files were available to write.",
						};
					}
					for (const [path, content] of Object.entries(generatedFiles)) {
						files.set(path, content);
					}
					return {
						success: true,
						text: `Wrote ${files.size} files to the app workspace.`,
						data: { actionName: "WRITE_APP_FILES", fileCount: files.size },
					};
				},
			}),
			makeAction({
				name: "RUN_QUALITY_GATE",
				parameters: [
					{
						name: "gate",
						description: "Quality gate to run",
						required: true,
						schema: {
							type: "string",
							enum: ["lint", "test", "build"],
						},
					},
				],
				handler: async (_runtime, _message, _state, options) => {
					const gate = String(options.parameters?.gate ?? "");
					if (gate === "lint") {
						const matches = [...files.entries()]
							.filter(([, content]) => forbiddenPattern.test(content))
							.map(([path]) => path);
						if (matches.length > 0) {
							return {
								success: false,
								text: `lint failed: forbidden implementation marker in ${matches.join(", ")}`,
								data: {
									actionName: "RUN_QUALITY_GATE",
									gate,
									matches,
								},
								error: "forbidden implementation marker",
							};
						}
						return {
							success: true,
							text: "lint passed with no implementation markers.",
							data: { actionName: "RUN_QUALITY_GATE", gate },
						};
					}
					if (gate === "test") {
						const app = files.get("src/App.tsx") ?? "";
						return {
							success: app.includes("createTask"),
							text: app.includes("createTask")
								? "tests passed: task creation flow is covered."
								: "tests failed: task creation flow missing.",
							data: { actionName: "RUN_QUALITY_GATE", gate },
						};
					}
					if (gate === "build") {
						const hasRequiredFiles =
							files.has("src/App.tsx") && files.has("src/api/tasks.ts");
						return {
							success: hasRequiredFiles,
							text: hasRequiredFiles
								? "build passed: client and API modules compiled."
								: "build failed: required modules missing.",
							data: { actionName: "RUN_QUALITY_GATE", gate },
						};
					}
					return {
						success: false,
						text: `unknown quality gate: ${gate}`,
						error: "unknown gate",
					};
				},
			}),
			makeAction({
				name: "REPAIR_APP_FILES",
				handler: async () => {
					for (const [path, content] of files.entries()) {
						files.set(
							path,
							content.replace(
								new RegExp(`\\s*// ${implementationMarker}:.*`, "g"),
								"",
							),
						);
					}
					return {
						success: true,
						text: "Repaired generated files and removed implementation markers.",
						data: { actionName: "REPAIR_APP_FILES" },
					};
				},
			}),
		];

		const state = makeState();
		const runtime = makeRuntime({
			actions,
			state,
			contextRegistry: makeContextRegistry(),
			responses: [
				{
					expectModelType: ModelType.RESPONSE_HANDLER,
					body: {
						text: "",
						toolCalls: [
							{
								id: "mh-1",
								name: V5_MESSAGE_HANDLER_TOOL_NAME,
								arguments: {
									processMessage: "RESPOND",
									plan: { contexts: ["general"] },
									thought:
										"The user requested a multi-step build and verification task.",
								},
							},
						],
					},
				},
				{
					expectModelType: ModelType.ACTION_PLANNER,
					body: {
						text: "",
						toolCalls: [
							{
								id: "generate-1",
								name: "GENERATE_FULL_STACK_APP",
								arguments: {},
							},
						],
					},
				},
				{
					expectModelType: ModelType.RESPONSE_HANDLER,
					body: JSON.stringify({
						success: true,
						decision: "CONTINUE",
						thought:
							"The app was generated; write the files and start quality gates.",
					}),
				},
				{
					expectModelType: ModelType.ACTION_PLANNER,
					body: {
						text: "",
						toolCalls: [
							{ id: "write-1", name: "WRITE_APP_FILES", arguments: {} },
							{
								id: "lint-1",
								name: "RUN_QUALITY_GATE",
								arguments: { gate: "lint" },
							},
						],
					},
				},
				{
					expectModelType: ModelType.RESPONSE_HANDLER,
					body: JSON.stringify({
						success: true,
						decision: "NEXT_RECOMMENDED",
						thought: "Files are written; run the queued lint gate.",
						recommendedToolCallId: "lint-1",
					}),
				},
				{
					expectModelType: ModelType.RESPONSE_HANDLER,
					body: JSON.stringify({
						success: false,
						decision: "CONTINUE",
						thought: "Lint caught a forbidden marker; replan a repair.",
					}),
				},
				{
					expectModelType: ModelType.ACTION_PLANNER,
					body: {
						text: "",
						toolCalls: [
							{ id: "repair-1", name: "REPAIR_APP_FILES", arguments: {} },
							{
								id: "lint-2",
								name: "RUN_QUALITY_GATE",
								arguments: { gate: "lint" },
							},
							{
								id: "test-1",
								name: "RUN_QUALITY_GATE",
								arguments: { gate: "test" },
							},
							{
								id: "build-1",
								name: "RUN_QUALITY_GATE",
								arguments: { gate: "build" },
							},
						],
					},
				},
				{
					expectModelType: ModelType.RESPONSE_HANDLER,
					body: JSON.stringify({
						success: true,
						decision: "NEXT_RECOMMENDED",
						thought: "Repair succeeded; rerun lint.",
						recommendedToolCallId: "lint-2",
					}),
				},
				{
					expectModelType: ModelType.RESPONSE_HANDLER,
					body: JSON.stringify({
						success: true,
						decision: "NEXT_RECOMMENDED",
						thought: "Lint is clean; run tests.",
						recommendedToolCallId: "test-1",
					}),
				},
				{
					expectModelType: ModelType.RESPONSE_HANDLER,
					body: JSON.stringify({
						success: true,
						decision: "NEXT_RECOMMENDED",
						thought: "Tests passed; run build.",
						recommendedToolCallId: "build-1",
					}),
				},
				{
					expectModelType: ModelType.RESPONSE_HANDLER,
					body: JSON.stringify({
						success: true,
						decision: "FINISH",
						thought:
							"All quality gates passed after repairing the implementation marker.",
						messageToUser:
							"Built the TaskFlow app, repaired the lint issue, and verified lint, tests, and build.",
					}),
				},
			],
		});

		const result = await runV5MessageRuntimeStage1({
			runtime,
			message: makeMessage(),
			state,
			responseId: RESPONSE_ID,
			plannerLoopConfig: {
				maxPlannerIterations: 12,
				maxToolCalls: 12,
				contextWindowTokens: 5_000,
				compactionReserveTokens: 1_000,
				compactionKeepSteps: 0,
			},
		});

		expect(result.kind).toBe("planned_reply");
		if (result.kind === "planned_reply") {
			expect(result.result.responseContent?.text).toContain("TaskFlow");
		}

		for (const [path, content] of files.entries()) {
			expect(path).toMatch(/\.(tsx|ts|json)$/);
			expect(content).not.toMatch(forbiddenPattern);
		}

		const calls = getCalls(runtime);
		const plannerCalls = calls.filter(
			(call) => call.modelType === ModelType.ACTION_PLANNER,
		);
		expect(plannerCalls.length).toBe(3);
		const secondPlannerMessages = JSON.stringify(
			(plannerCalls[1]?.params as { messages?: unknown[] } | undefined)
				?.messages ?? [],
		);
		expect(secondPlannerMessages).toContain("compaction");
		expect(secondPlannerMessages).not.toContain("x".repeat(1_000));

		const trajectories = readRecordedTrajectories(String(AGENT_ID), tempDir);
		expect(trajectories).toHaveLength(1);
		const exportPath = join(tempDir, "all-trajectories.jsonl");
		const jsonl =
			trajectories.map((trajectory) => JSON.stringify(trajectory)).join("\n") +
			"\n";
		writeFileSync(exportPath, jsonl, "utf8");
		const exported = readFileSync(exportPath, "utf8");
		expect(exported).toContain('"trajectoryId"');
		const reviewExportDir = process.env.MILADY_V5_STRESS_EXPORT_DIR;
		if (reviewExportDir) {
			mkdirSync(reviewExportDir, { recursive: true });
			writeFileSync(
				join(reviewExportDir, "v5-stress-trajectory.jsonl"),
				exported,
				"utf8",
			);
		}

		const trajectory = trajectories[0] as {
			status: string;
			stages: Array<{
				kind: string;
				tool?: {
					name: string;
					success: boolean;
					args?: Record<string, unknown>;
				};
				model?: {
					messages?: unknown[];
					prompt?: string;
					providerOptions?: {
						eliza?: {
							modelInputBudget?: {
								contextWindowTokens?: number;
								reserveTokens?: number;
							};
						};
					};
				};
			}>;
			metrics: {
				plannerIterations: number;
				toolCallsExecuted: number;
				toolCallFailures: number;
				evaluatorFailures: number;
				finalDecision: string;
			};
		};
		expect(trajectory.status).toBe("finished");
		expect(trajectory.metrics.toolCallsExecuted).toBe(7);
		expect(trajectory.metrics.toolCallFailures).toBe(1);
		expect(trajectory.metrics.evaluatorFailures).toBe(1);
		expect(trajectory.metrics.finalDecision).toBe("FINISH");
		expect(trajectory.stages.map((stage) => stage.kind)).toContain(
			"compaction",
		);
		expect(
			trajectory.stages.some(
				(stage) =>
					stage.kind === "tool" &&
					stage.tool?.name === "RUN_QUALITY_GATE" &&
					stage.tool.success === false,
			),
		).toBe(true);
		expect(
			trajectory.stages.filter((stage) => stage.kind === "planner"),
		).toHaveLength(3);
		const recordedPlannerPayload = JSON.stringify(
			trajectory.stages
				.filter((stage) => stage.kind === "planner")
				.map((stage) => stage.model?.messages ?? []),
		);
		expect(recordedPlannerPayload).toContain("compaction");
		expect(recordedPlannerPayload).not.toContain("x".repeat(1_000));
		const firstPlannerStage = trajectory.stages.find(
			(stage) => stage.kind === "planner",
		);
		expect(
			firstPlannerStage?.model?.providerOptions?.eliza?.modelInputBudget,
		).toMatchObject({
			contextWindowTokens: 5_000,
			reserveTokens: 1_000,
		});
	});
});
