/**
 * Per-action task runner.
 *
 * Each fixture targets a single named action with its parameter list. The
 * model emits just that action's parameter object. Label_match looks for the
 * expected parameter keys; extras are tolerated.
 *
 * Add more actions by appending entries to `src/fixtures/action.json`.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	buildMetric,
	checkParamsMatch,
	isPlainObject,
	tryParseJson,
} from "../metrics.ts";
import type {
	ActionFixture,
	CaseMetric,
	JsonValue,
	ModeAdapter,
	ModeRequest,
	PlannerParameterDescriptor,
	SkeletonHint,
} from "../types.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const FIXTURE_PATH = path.join(HERE, "..", "fixtures", "action.json");

interface ActionFixtureFile {
	note: string;
	cases: ActionFixture[];
}

export function loadActionFixtures(): ActionFixture[] {
	const raw = readFileSync(FIXTURE_PATH, "utf8");
	const parsed = JSON.parse(raw) as ActionFixtureFile;
	return parsed.cases;
}

/**
 * Group fixtures by their `actionName`. The runner then dispatches one
 * `action:<NAME>` task per group; the bench's `--task` filter can target a
 * specific action.
 */
export function groupFixturesByAction(
	fixtures: ActionFixture[],
): Map<string, ActionFixture[]> {
	const groups = new Map<string, ActionFixture[]>();
	for (const fixture of fixtures) {
		const list = groups.get(fixture.actionName);
		if (list) list.push(fixture);
		else groups.set(fixture.actionName, [fixture]);
	}
	return groups;
}

function buildSkeletonHint(params: PlannerParameterDescriptor[]): SkeletonHint {
	return {
		type: "object",
		freeFields: params.map((p) => ({
			key: p.name,
			kind: p.enum
				? "enum"
				: p.type === "string"
					? "string"
					: p.type === "number"
						? "number"
						: "boolean",
			enumValues: p.enum,
			description: p.description,
		})),
	};
}

function buildJsonSchema(params: PlannerParameterDescriptor[]): JsonValue {
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
		additionalProperties: false,
	};
	if (required.length > 0) out.required = required;
	return out;
}

function buildSystemPrompt(actionName: string): string {
	return [
		`You are Eliza, an AI assistant. You are emitting the parameters for the ${actionName} action.`,
		"Output a single JSON object that is the parameter set for this action — no wrapper, no prose, no extra fields outside of the action's parameter schema.",
	].join("\n");
}

function buildUserPrompt(fixture: ActionFixture): string {
	const paramSpec = fixture.parameters.map((p) => {
		const bits = [`name=${p.name}`, `type=${p.type}`];
		if (p.enum) bits.push(`enum=${p.enum.join("|")}`);
		if (p.required) bits.push("required");
		return `- ${bits.join(", ")}: ${p.description}`;
	});
	return [
		`action: ${fixture.actionName}`,
		"parameters:",
		...paramSpec,
		"",
		`context: ${fixture.context}`,
	].join("\n");
}

export async function runActionTask(args: {
	actionName: string;
	mode: ModeAdapter;
	n: number;
}): Promise<CaseMetric[]> {
	const groups = groupFixturesByAction(loadActionFixtures());
	const fixtures = groups.get(args.actionName) ?? [];
	if (fixtures.length === 0) return [];
	const metrics: CaseMetric[] = [];
	for (const fixture of fixtures) {
		const skeletonHint = buildSkeletonHint(fixture.parameters);
		const jsonSchema = buildJsonSchema(fixture.parameters);
		const userPrompt = buildUserPrompt(fixture);
		for (let i = 0; i < args.n; i += 1) {
			const request: ModeRequest = {
				taskId: `action:${args.actionName}` as `action:${string}`,
				caseId: `${fixture.id}#${i}`,
				systemPrompt: buildSystemPrompt(fixture.actionName),
				userPrompt,
				jsonSchema,
				skeletonHint,
				maxTokens: 128,
			};
			const result = await args.mode.generate(request);
			const parsed = tryParseJson(result.rawOutput);
			const parseSuccess = parsed !== null;
			const schemaValid = parseSuccess && isPlainObject(parsed);
			let labelMatch: boolean | null = null;
			if (schemaValid && parsed !== null) {
				labelMatch =
					Object.keys(fixture.expected_params).length === 0
						? true
						: checkParamsMatch(parsed, fixture.expected_params);
			}
			metrics.push(
				buildMetric({
					taskId: `action:${args.actionName}` as `action:${string}`,
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

/**
 * Enumerate every action covered by the fixture set — used by the CLI when
 * `--task action:all` is requested (running every grouped action runner).
 */
export function listActionNames(): string[] {
	return Array.from(groupFixturesByAction(loadActionFixtures()).keys()).sort();
}
