/**
 * Live-only scenario for localized VIEWS create, show, search, and delete lifecycle.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
	CapturedAction,
	ScenarioContext,
	ScenarioTurnExecution,
} from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";
import {
	listViews,
	registerPluginViews,
	unregisterPluginViews,
} from "@elizaos/agent/api/views-registry";
import {
	jsonResponse,
	registerAppControlHttpHandler,
	resetAppControlHttpLoopback,
} from "../../../../packages/scenario-runner/test/scenarios/_helpers/app-control-http-loopback";

const VIEW_ID = "lifecycle-sketch";
const DISPLAY_NAME = "Lifecycle Sketch";
const PLUGIN_NAME = "@scenario/plugin-lifecycle-sketch";
const REPO_SOURCE_ROOT = path.resolve(import.meta.dirname, "../../../..");
const MIN_PLUGIN_TEMPLATE = path.join(
	REPO_SOURCE_ROOT,
	"packages",
	"elizaos",
	"templates",
	"min-plugin",
);

let scenarioRepoRoot = "";
let previousElizaRepoRoot: string | undefined;

type RuntimeAction = {
	name: string;
	validate?: (...args: unknown[]) => Promise<boolean> | boolean;
	handler?: (...args: unknown[]) => Promise<unknown> | unknown;
};

type RuntimeRoute = {
	type: string;
	path: string;
	handler: (...args: unknown[]) => Promise<void> | void;
};

type ScenarioRuntimeHarness = {
	actions?: RuntimeAction[];
	routes?: RuntimeRoute[];
	useModel?: (...args: unknown[]) => Promise<unknown>;
	__viewsCrudUseModelPatched?: boolean;
};

function toRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function readPath(value: unknown, pathExpression: string): unknown {
	let current = value;
	for (const segment of pathExpression.split(".").filter(Boolean)) {
		if (Array.isArray(current) && /^\d+$/.test(segment)) {
			current = current[Number(segment)];
			continue;
		}
		current = toRecord(current)[segment];
	}
	return current;
}

function actionParameters(action: CapturedAction): Record<string, unknown> {
	const params = toRecord(action.parameters);
	return toRecord(params.parameters ?? params);
}

function valuesEqual(actual: unknown, expected: unknown): boolean {
	return JSON.stringify(actual) === JSON.stringify(expected);
}

function expectViewsAction(
	execution: ScenarioTurnExecution,
	expected: {
		parameters?: Record<string, unknown>;
		responseIncludes?: string[];
		resultFields?: Record<string, unknown>;
		success?: boolean;
	},
): string | undefined {
	const action = execution.actionsCalled.find(
		(candidate) => candidate.actionName === "VIEWS",
	);
	if (!action) {
		return `expected VIEWS action, saw ${execution.actionsCalled.map((candidate) => candidate.actionName).join(", ") || "none"}`;
	}

	for (const [key, expectedValue] of Object.entries(expected.parameters ?? {})) {
		const actual = actionParameters(action)[key];
		if (!valuesEqual(actual, expectedValue)) {
			return `expected VIEWS parameter ${key}=${JSON.stringify(expectedValue)}, saw ${JSON.stringify(actual)}`;
		}
	}

	if (
		typeof expected.success === "boolean" &&
		action.result?.success !== expected.success
	) {
		return `expected VIEWS result.success=${expected.success}, saw ${JSON.stringify(action.result)}`;
	}

	for (const snippet of expected.responseIncludes ?? []) {
		if (!execution.responseText?.includes(snippet)) {
			return `expected response to include ${JSON.stringify(snippet)}, saw ${JSON.stringify(execution.responseText)}`;
		}
	}

	for (const [pathExpression, expectedValue] of Object.entries(
		expected.resultFields ?? {},
	)) {
		const actual = readPath(action.result, pathExpression);
		if (!valuesEqual(actual, expectedValue)) {
			return `expected VIEWS result.${pathExpression}=${JSON.stringify(expectedValue)}, saw ${JSON.stringify(actual)}`;
		}
	}

	return undefined;
}

function catalogViews() {
	return listViews({ includeAllKinds: true }).map((view) => ({
		id: view.id,
		label: view.label,
		path: view.path,
		pluginName: view.pluginName,
		viewType: view.viewType,
		available: view.available,
		viewKind: view.viewKind,
	}));
}

function assertCatalogMembership(
	status: number,
	body: unknown,
	expected: "present" | "absent",
): string | undefined {
	if (status !== 200) return `expected GET /api/views status 200, saw ${status}`;
	const views = Array.isArray(toRecord(body).views) ? toRecord(body).views : [];
	const match = views
		.map((view) => toRecord(view))
		.find((view) => view.id === VIEW_ID && view.pluginName === PLUGIN_NAME);
	if (expected === "present" && !match) {
		return `expected ${VIEW_ID} (${PLUGIN_NAME}) to be present in /api/views, saw ${JSON.stringify(views)}`;
	}
	if (expected === "absent" && match) {
		return `expected ${VIEW_ID} (${PLUGIN_NAME}) to be absent from /api/views, saw ${JSON.stringify(views)}`;
	}
	return undefined;
}

function readTaskParameters(options: unknown): Record<string, unknown> {
	const record = toRecord(options);
	return toRecord(record.parameters);
}

function parseSourceDir(task: unknown): string | undefined {
	if (typeof task !== "string") return undefined;
	return /^sourceDir:\s*(.+)$/m.exec(task)?.[1]?.trim();
}

async function registerLifecycleView(workdir: string) {
	await registerPluginViews(
		{
			name: PLUGIN_NAME,
			description: "Synthetic plugin view registered by the CRUD lifecycle scenario.",
			views: [
				{
					id: VIEW_ID,
					label: DISPLAY_NAME,
					description:
						"Synthetic lifecycle view used to prove create, edit, and delete affect the view catalog.",
					path: `/${VIEW_ID}`,
					viewType: "gui",
					viewKind: "release",
					bundleUrl:
						"data:text/javascript;charset=utf-8,export%20default%20function%20LifecycleSketch()%20%7B%20return%20null%3B%20%7D",
					tags: ["scenario", "crud", "lifecycle"],
				},
			],
		},
		workdir,
	);
}

async function ensureScenarioRepoRoot(): Promise<string> {
	scenarioRepoRoot = await fs.mkdtemp(
		path.join(os.tmpdir(), "views-crud-lifecycle-"),
	);
	await fs.mkdir(
		path.join(scenarioRepoRoot, "packages", "elizaos", "templates"),
		{ recursive: true },
	);
	await fs.cp(
		MIN_PLUGIN_TEMPLATE,
		path.join(
			scenarioRepoRoot,
			"packages",
			"elizaos",
			"templates",
			"min-plugin",
		),
		{ recursive: true },
	);
	await fs.mkdir(path.join(scenarioRepoRoot, "plugins"), { recursive: true });
	previousElizaRepoRoot = process.env.ELIZA_REPO_ROOT;
	process.env.ELIZA_REPO_ROOT = scenarioRepoRoot;
	return scenarioRepoRoot;
}

function installSyntheticCatalogApi(runtime: ScenarioRuntimeHarness) {
	runtime.routes ??= [];
	if (
		runtime.routes.some(
			(route) => route.type === "GET" && route.path === "/api/views",
		)
	) {
		return;
	}
	runtime.routes.push({
		type: "GET",
		path: "/api/views",
		handler: (_req: unknown, res: unknown) => {
			const response = res as {
				statusCode?: number;
				setHeader?: (name: string, value: string) => void;
				end?: (body: string) => void;
			};
			response.statusCode = 200;
			response.setHeader?.("Content-Type", "application/json; charset=utf-8");
			response.end?.(JSON.stringify({ views: catalogViews() }));
		},
	});
}

function installLoopbackCatalog() {
	resetAppControlHttpLoopback();
	registerAppControlHttpHandler((request) => {
		if (request.method === "GET" && request.pathname === "/api/views") {
			return jsonResponse({ views: catalogViews() });
		}
		if (
			request.method === "POST" &&
			request.pathname === "/api/plugins/uninstall"
		) {
			const body = toRecord(request.body);
			const name = typeof body.name === "string" ? body.name : "";
			if (name !== PLUGIN_NAME) {
				return jsonResponse(
					{ ok: false, error: `Unexpected uninstall target: ${name}` },
					422,
				);
			}
			unregisterPluginViews(PLUGIN_NAME);
			return jsonResponse({
				ok: true,
				message: `Plugin ${PLUGIN_NAME} uninstalled.`,
			});
		}
		return undefined;
	});
}

function installNameExtractionFixture(runtime: ScenarioRuntimeHarness) {
	if (runtime.__viewsCrudUseModelPatched || !runtime.useModel) return;
	const originalUseModel = runtime.useModel.bind(runtime);
	runtime.useModel = async (...args: unknown[]) => {
		const prompt = String(toRecord(args[1]).prompt ?? "");
		if (
			prompt.includes("You name a brand-new elizaOS UI view plugin") &&
			prompt.includes("lifecycle sketch")
		) {
			return `name: ${VIEW_ID}\ndisplayName: ${DISPLAY_NAME}`;
		}
		return originalUseModel(...args);
	};
	runtime.__viewsCrudUseModelPatched = true;
}

function installCodingTaskStub(runtime: ScenarioRuntimeHarness) {
	runtime.actions ??= [];
	const original = runtime.actions.find(
		(action) => action.name === "START_CODING_TASK",
	);
	const fakeAction = {
		name: "START_CODING_TASK",
		validate: async (...args: unknown[]) =>
			original?.validate ? Boolean(await original.validate(...args)) : true,
		handler: async (...args: unknown[]) => {
			const options = args[3];
			const parameters = readTaskParameters(options);
			const label =
				typeof parameters.label === "string"
					? parameters.label
					: "coding-task";
			const task = parameters.task;
			const workdir =
				parseSourceDir(task) ??
				path.join(scenarioRepoRoot, "plugins", `plugin-${VIEW_ID}`);

			if (
				label === `create-view:${VIEW_ID}` ||
				label === `edit-view:${VIEW_ID}`
			) {
				if (label === `create-view:${VIEW_ID}`) {
					await registerLifecycleView(workdir);
				}
				return {
					success: true,
					data: {
						agents: [
							{
								sessionId: `scenario-${label}`,
								agentType: "codex",
								workdir,
								label,
								status: "running",
								workspaceId: "scenario-workspace",
								branch: "scenario/views-crud-lifecycle",
							},
						],
					},
				};
			}

			if (original?.handler) return original.handler(...args);
			return {
				success: false,
				text: `Unexpected coding task label in views CRUD scenario: ${label}`,
			};
		},
	};
	const index = runtime.actions.findIndex(
		(action) => action.name === "START_CODING_TASK",
	);
	if (index >= 0) runtime.actions.splice(index, 1, fakeAction);
	else runtime.actions.push(fakeAction);
}

async function cleanupScenario(): Promise<string | undefined> {
	unregisterPluginViews(PLUGIN_NAME);
	resetAppControlHttpLoopback();
	if (previousElizaRepoRoot === undefined) {
		delete process.env.ELIZA_REPO_ROOT;
	} else {
		process.env.ELIZA_REPO_ROOT = previousElizaRepoRoot;
	}
	if (scenarioRepoRoot) {
		await fs.rm(scenarioRepoRoot, { recursive: true, force: true });
	}
	return undefined;
}

export default scenario({
	lane: "live-only",
	id: "views-crud-lifecycle-i18n",
	title: "VIEWS delete confirmation is LLM-driven across languages (JA/ES) — #10471",
	domain: "app-control",
	tags: ["app-control", "views", "create", "edit", "delete", "catalog"],
	isolation: "per-scenario",
	requires: {
		plugins: ["@elizaos/plugin-app-control"],
	},
	rooms: [
		{
			id: "main",
			source: "chat",
			title: "Views CRUD Lifecycle",
		},
	],
	seed: [
		{
			type: "custom",
			name: "install synthetic lifecycle view harness",
			apply: async (ctx: ScenarioContext) => {
				const runtime = ctx.runtime as ScenarioRuntimeHarness | undefined;
				if (!runtime) return "scenario runtime unavailable";

				unregisterPluginViews(PLUGIN_NAME);
				await ensureScenarioRepoRoot();
				installSyntheticCatalogApi(runtime);
				installLoopbackCatalog();
				installNameExtractionFixture(runtime);
				installCodingTaskStub(runtime);
				return undefined;
			},
		},
	],
	turns: [
		{
			kind: "action",
			name: "create lifecycle view",
			text: "Create a new lifecycle sketch view for validating view CRUD.",
			actionName: "VIEWS",
			options: {
				action: "create",
				intent: "Create a lifecycle sketch view for validating view CRUD.",
			},
			responseIncludesAny: [`Started view create task for ${DISPLAY_NAME}`],
			responseExcludes: ["already running", "Navigated to"],
			assertTurn: (execution) =>
				expectViewsAction(execution, {
					parameters: {
						action: "create",
						intent: "Create a lifecycle sketch view for validating view CRUD.",
					},
					responseIncludes: [`Started view create task for ${DISPLAY_NAME}`],
					success: true,
					resultFields: {
						"values.mode": "create",
						"values.subMode": "new",
						"values.name": VIEW_ID,
						"values.displayName": DISPLAY_NAME,
						"data.task.label": `create-view:${VIEW_ID}`,
					},
				}),
		},
		{
			kind: "api",
			name: "catalog contains lifecycle view after create",
			method: "GET",
			path: "/api/views",
			assertResponse: (status, body) =>
				assertCatalogMembership(status, body, "present"),
		},
		{
			kind: "action",
			name: "edit lifecycle view",
			text: "Edit the lifecycle sketch view to show an edited validation state.",
			actionName: "VIEWS",
			options: {
				action: "edit",
				view: VIEW_ID,
				intent: "Show an edited validation state in the lifecycle sketch view.",
			},
			responseIncludesAny: [`Started view edit task for ${DISPLAY_NAME}`],
			assertTurn: (execution) =>
				expectViewsAction(execution, {
					parameters: {
						action: "edit",
						view: VIEW_ID,
						intent:
							"Show an edited validation state in the lifecycle sketch view.",
					},
					responseIncludes: [`Started view edit task for ${DISPLAY_NAME}`],
					success: true,
					resultFields: {
						"values.mode": "edit",
						"values.viewId": VIEW_ID,
						"values.taskSessionId": `scenario-edit-view:${VIEW_ID}`,
						"data.task.label": `edit-view:${VIEW_ID}`,
					},
				}),
		},
		{
			kind: "action",
			name: "delete lifecycle view asks for confirmation",
			text: "Delete the lifecycle sketch view.",
			actionName: "VIEWS",
			options: {
				action: "delete",
				view: VIEW_ID,
			},
			responseIncludesAny: [
				`Are you sure you want to delete the ${DISPLAY_NAME} view`,
			],
			assertTurn: (execution) =>
				expectViewsAction(execution, {
					parameters: {
						action: "delete",
						view: VIEW_ID,
					},
					responseIncludes: [
						`Are you sure you want to delete the ${DISPLAY_NAME} view`,
					],
					success: true,
					resultFields: {
						"values.mode": "delete",
						"values.subMode": "confirm",
						"values.viewId": VIEW_ID,
						"values.pluginName": PLUGIN_NAME,
					},
				}),
		},
		{
			kind: "action",
			name: "confirm lifecycle view delete",
			// Non-English (Japanese) affirmation. The planner must map "yes, delete
			// it" in a non-Latin script to the structured VIEWS { confirm: true }
			// parameter — proving the delete confirmation is LLM-driven, not an
			// English-keyword `.includes("yes")` check (#10471).
			text: "はい、削除して",
			actionName: "VIEWS",
			options: {
				confirm: true,
			},
			responseIncludesAny: [`Deleted ${DISPLAY_NAME}`],
			responseExcludes: ["Deletion partially failed"],
			assertTurn: (execution) =>
				expectViewsAction(execution, {
					responseIncludes: [`Deleted ${DISPLAY_NAME}`],
					success: true,
					resultFields: {
						"values.mode": "delete",
						"values.viewId": VIEW_ID,
						"values.pluginName": PLUGIN_NAME,
						"data.unloadResult.ok": true,
					},
				}),
		},
		{
			kind: "api",
			name: "catalog excludes lifecycle view after delete",
			method: "GET",
			path: "/api/views",
			assertResponse: (status, body) =>
				assertCatalogMembership(status, body, "absent"),
		},
	],
	finalChecks: [
		{
			type: "actionCalled",
			actionName: "VIEWS",
			status: "success",
			minCount: 4,
		},
		{
			type: "selectedAction",
			actionName: "VIEWS",
		},
		{
			type: "selectedActionArguments",
			actionName: "VIEWS",
			includesAll: [
				/"create"/,
				/"edit"/,
				/"delete"/,
				new RegExp(VIEW_ID),
				new RegExp(PLUGIN_NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
			],
		},
		{
			type: "judgeRubric",
			name: "views-crud-full-lifecycle-i18n",
			rubric:
				"The trajectory must show one owner-gated VIEWS lifecycle for the same synthetic view: create dispatch succeeds without claiming the view is already running, GET /api/views contains the new lifecycle-sketch view after create, edit dispatch succeeds for that same view, delete asks for confirmation, the yes turn reports Deleted rather than partial failure, and GET /api/views no longer contains the view after delete.",
			minimumScore: 0.7,
		},
		{
			type: "custom",
			name: "cleanup synthetic lifecycle fixture",
			predicate: cleanupScenario,
		},
	],
});
