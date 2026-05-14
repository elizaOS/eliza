/**
 * Planner task runner.
 *
 * Each fixture ships a small action registry; the model picks one action and
 * fills its parameter object. Ground-truth label is the action name plus
 * the listed `expected_params` keys (deep-equal for each listed key — extras
 * tolerated).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	buildMetric,
	checkParamsMatch,
	checkPlannerSchema,
	isPlainObject,
	tryParseJson,
} from "../metrics.ts";
import type {
	CaseMetric,
	JsonValue,
	ModeAdapter,
	ModeRequest,
	PlannerActionDescriptor,
	PlannerFixture,
	PlannerParameterDescriptor,
	SkeletonHint,
} from "../types.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const FIXTURE_PATH = path.join(HERE, "..", "fixtures", "planner.json");

interface PlannerFixtureFile {
	note: string;
	cases: PlannerFixture[];
}

export function loadPlannerFixtures(): PlannerFixture[] {
	const raw = readFileSync(FIXTURE_PATH, "utf8");
	const parsed = JSON.parse(raw) as PlannerFixtureFile;
	return parsed.cases;
}

const SYSTEM_PROMPT = [
	"You are Eliza, an AI assistant. You are choosing ONE action to run for this user message.",
	'Output JSON of the form {"action": "<NAME>", "parameters": { ... }}.',
	"Choose the single best action from the available actions list. Match parameter names exactly. Fill enum-valued parameters with one of the listed enum values. No prose, no extra top-level fields.",
].join("\n");

function renderActionRegistry(actions: PlannerActionDescriptor[]): string {
	const lines: string[] = ["available_actions:"];
	for (const action of actions) {
		lines.push(`- name: ${action.name}`);
		lines.push(`  description: ${action.description}`);
		lines.push("  parameters:");
		for (const param of action.parameters) {
			const bits = [`name=${param.name}`, `type=${param.type}`];
			if (param.enum) bits.push(`enum=${param.enum.join("|")}`);
			if (param.required) bits.push("required");
			lines.push(`    - ${bits.join(", ")}`);
			lines.push(`      description: ${param.description}`);
		}
	}
	return lines.join("\n");
}

function buildSkeletonHint(actions: PlannerActionDescriptor[]): SkeletonHint {
	return {
		type: "object",
		freeFields: [
			{
				key: "action",
				kind: "enum",
				enumValues: actions.map((a) => a.name),
			},
			{
				key: "parameters",
				kind: "object",
			},
		],
	};
}

function buildJsonSchema(actions: PlannerActionDescriptor[]): JsonValue {
	const actionNames = actions.map((a) => a.name);
	// Each action contributes its own parameter object shape via `oneOf`.
	const oneOf: JsonValue[] = actions.map((a) => ({
		type: "object",
		properties: {
			action: { type: "string", const: a.name },
			parameters: paramsToSchema(a.parameters),
		},
		required: ["action", "parameters"],
		additionalProperties: false,
	}));
	return {
		type: "object",
		oneOf,
		properties: {
			action: { type: "string", enum: actionNames },
			parameters: { type: "object" },
		},
		required: ["action", "parameters"],
	};
}

function paramsToSchema(params: PlannerParameterDescriptor[]): JsonValue {
	const properties: Record<string, JsonValue> = {};
	const required: string[] = [];
	for (const param of params) {
		const schema: Record<string, JsonValue> = { type: param.type };
		if (param.enum) schema.enum = param.enum;
		schema.description = param.description;
		properties[param.name] = schema;
		if (param.required) required.push(param.name);
	}
	const out: Record<string, JsonValue> = {
		type: "object",
		properties,
		additionalProperties: true,
	};
	if (required.length > 0) out.required = required;
	return out;
}

function buildUserPrompt(fixture: PlannerFixture): string {
	return [
		renderActionRegistry(fixture.availableActions),
		"",
		`user_message: ${JSON.stringify(fixture.input)}`,
	].join("\n");
}

export async function runPlannerTask(args: {
	mode: ModeAdapter;
	n: number;
}): Promise<CaseMetric[]> {
	const fixtures = loadPlannerFixtures();
	const metrics: CaseMetric[] = [];
	for (const fixture of fixtures) {
		const skeletonHint = buildSkeletonHint(fixture.availableActions);
		const jsonSchema = buildJsonSchema(fixture.availableActions);
		const userPrompt = buildUserPrompt(fixture);
		for (let i = 0; i < args.n; i += 1) {
			const request: ModeRequest = {
				taskId: "planner",
				caseId: `${fixture.id}#${i}`,
				systemPrompt: SYSTEM_PROMPT,
				userPrompt,
				jsonSchema,
				skeletonHint,
				maxTokens: 256,
			};
			const result = await args.mode.generate(request);
			const parsed = tryParseJson(result.rawOutput);
			const parseSuccess = parsed !== null;
			const schemaValid = parseSuccess ? checkPlannerSchema(parsed) : false;
			let labelMatch: boolean | null = null;
			if (schemaValid && parsed !== null && isPlainObject(parsed)) {
				const actionMatch = parsed.action === fixture.expected_action_name;
				const paramsMatch =
					Object.keys(fixture.expected_params).length === 0
						? true
						: checkParamsMatch(parsed.parameters, fixture.expected_params);
				labelMatch = actionMatch && paramsMatch;
			}
			metrics.push(
				buildMetric({
					taskId: "planner",
					modeId: args.mode.id,
					caseId: request.caseId,
					result,
					parse_success: parseSuccess,
					schema_valid: schemaValid,
					label_match: labelMatch,
				}),
			);
		}
	}
	return metrics;
}
