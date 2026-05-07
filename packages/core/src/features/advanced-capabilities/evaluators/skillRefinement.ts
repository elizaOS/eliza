/**
 * Skill refinement evaluator.
 *
 * When a curated skill participated in a trajectory that failed (or was
 * retried), ask an LLM to propose a diff against the current SKILL.md.
 *
 * Refinement budget: the first three auto-refinements are applied directly to
 * the active skill (provenance.refinedCount increments, derivedFromTrajectory
 * + createdAt update). After that, additional proposed refinements are staged
 * under `~/.eliza/skills/curated/proposed/<name>/SKILL.md` so the user can
 * review them via the Settings → Learned Skills panel.
 *
 * Triggers when:
 *   - a curated skill was used in the latest trajectory (TrajectoryStep.usedSkills,
 *     falling back to trajectory.metadata.usedSkills)
 *   - the trajectory's status is "failed" OR a retry signal is present in
 *     metadata.retryCount/metadata.retryDetected
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../../../logger.ts";
import type {
	ActionResult,
	EvaluationExample,
	Evaluator,
	IAgentRuntime,
} from "../../../types/index.ts";
import { ModelType } from "../../../types/index.ts";
import { resolveStateDir } from "../../../utils/state-dir.ts";
import {
	formatTrajectoryForPrompt,
	getTrajectoryService,
	parseJsonObject,
	type SkillTrajectoryService,
	type SkillTrajectory as Trajectory,
	type SkillTrajectoryListItem as TrajectoryListItem,
} from "./trajectory-evaluator-utils.ts";

const EVAL_NAME = "SKILL_REFINEMENT";
const EVAL_DESCRIPTION =
	"Refines curated SKILL.md files when they participated in a failing or retried trajectory.";
const MAX_AUTO_REFINEMENTS = 3;

const REFINEMENT_PROMPT = `You are improving a SKILL.md file because the agent recently failed or
retried while using it.

Return a JSON object matching the provided schema. Do not include prose or fences.

If refinement is warranted:
- refine: true
- newBody: full replacement markdown body, no frontmatter
- reason: short reason

If no refinement is warranted:
- refine: false
- reason: short reason

Rules:
- newBody MUST be the complete replacement markdown body (the frontmatter is
  preserved separately and updated automatically).
- newBody MUST NOT contain a YAML frontmatter block (---).
- Keep the skill focused: tighten steps, add guardrails for the failure mode,
  remove ambiguity. Do not invent capabilities the agent does not have.`;

interface RefinementDraft {
	refine: boolean;
	reason?: string;
	newBody?: string;
}

const REFINEMENT_RESPONSE_SCHEMA = {
	type: "object",
	properties: {
		refine: { type: "boolean" },
		reason: { type: "string" },
		newBody: { type: "string" },
	},
	required: ["refine"],
};

function getActiveSkillsDir(): string {
	return join(resolveStateDir(), "skills", "curated", "active");
}

function getProposedSkillsDir(): string {
	return join(resolveStateDir(), "skills", "curated", "proposed");
}

function parseRefinementResponse(raw: unknown): RefinementDraft | null {
	const obj =
		raw && typeof raw === "object" && !Array.isArray(raw)
			? (raw as Record<string, unknown>)
			: typeof raw === "string"
				? parseJsonObject(raw)
				: null;
	if (!obj) return null;
	const draft: RefinementDraft = { refine: obj.refine === true };
	if (typeof obj.reason === "string") draft.reason = obj.reason;
	if (typeof obj.newBody === "string") draft.newBody = obj.newBody;
	return draft;
}

interface ParsedSkillFile {
	frontmatter: Record<string, unknown>;
	body: string;
}

function parseSkillFile(content: string): ParsedSkillFile | null {
	const normalized = content.replace(/\r\n/g, "\n");
	if (!normalized.startsWith("---")) {
		return null;
	}
	const endIdx = normalized.indexOf("\n---", 3);
	if (endIdx === -1) {
		return null;
	}
	const yaml = normalized.slice(4, endIdx);
	const body = normalized.slice(endIdx + 4).replace(/^\n+/, "");
	const frontmatter = parseYamlBlock(yaml);
	return { frontmatter, body };
}

/**
 * Tiny YAML reader for the constrained subset we emit (flat keys, plus a
 * single-level `provenance:` map). Anything richer falls through unchanged.
 */
function parseYamlBlock(yaml: string): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	const lines = yaml.split("\n");
	let i = 0;
	while (i < lines.length) {
		const rawLine = lines[i];
		i += 1;
		if (rawLine === undefined) continue;
		const line = rawLine.replace(/\s+$/, "");
		if (!line || line.startsWith("#")) continue;
		if (/^\s/.test(line)) continue;
		const colonIdx = line.indexOf(":");
		if (colonIdx === -1) continue;
		const key = line.slice(0, colonIdx).trim();
		const value = line.slice(colonIdx + 1).trim();
		if (value === "") {
			const child: Record<string, unknown> = {};
			while (i < lines.length) {
				const nextRaw = lines[i];
				if (nextRaw === undefined) break;
				if (!/^\s+\S/.test(nextRaw)) break;
				const sub = nextRaw.trim();
				const subColon = sub.indexOf(":");
				if (subColon === -1) {
					i += 1;
					continue;
				}
				const subKey = sub.slice(0, subColon).trim();
				const subValRaw = sub.slice(subColon + 1).trim();
				child[subKey] = coerceScalar(subValRaw);
				i += 1;
			}
			result[key] = child;
			continue;
		}
		result[key] = coerceScalar(value);
	}
	return result;
}

function coerceScalar(value: string): unknown {
	if (value === "true") return true;
	if (value === "false") return false;
	if (value === "null" || value === "~") return null;
	if (/^-?\d+$/.test(value)) return Number(value);
	if (/^-?\d+\.\d+$/.test(value)) return Number(value);
	if (
		(value.startsWith('"') && value.endsWith('"')) ||
		(value.startsWith("'") && value.endsWith("'"))
	) {
		return value.slice(1, -1);
	}
	return value;
}

function escapeYamlScalar(value: string): string {
	if (/[:#"'\n]/.test(value)) {
		return JSON.stringify(value);
	}
	return value;
}

function serializeSkillFile(
	frontmatter: Record<string, unknown>,
	body: string,
): string {
	const lines: string[] = ["---"];
	for (const [key, value] of Object.entries(frontmatter)) {
		if (value && typeof value === "object" && !Array.isArray(value)) {
			lines.push(`${key}:`);
			for (const [subKey, subValue] of Object.entries(
				value as Record<string, unknown>,
			)) {
				lines.push(`  ${subKey}: ${formatYamlValue(subValue)}`);
			}
		} else {
			lines.push(`${key}: ${formatYamlValue(value)}`);
		}
	}
	lines.push("---");
	lines.push("");
	lines.push(body.trimEnd());
	lines.push("");
	return lines.join("\n");
}

function formatYamlValue(value: unknown): string {
	if (value === null || value === undefined) return "null";
	if (typeof value === "boolean" || typeof value === "number") {
		return String(value);
	}
	if (typeof value === "string") return escapeYamlScalar(value);
	return JSON.stringify(value);
}

function trajectoryUsedSkills(trajectory: Trajectory): string[] {
	const collected = new Set<string>();
	for (const step of trajectory.steps ?? []) {
		const used = step.usedSkills;
		if (Array.isArray(used)) {
			for (const name of used) {
				if (typeof name === "string" && name.trim()) {
					collected.add(name.trim());
				}
			}
		}
	}
	const metaUsed = trajectory.metadata?.usedSkills;
	if (Array.isArray(metaUsed)) {
		for (const name of metaUsed) {
			if (typeof name === "string" && name.trim()) {
				collected.add(name.trim());
			}
		}
	}
	return [...collected];
}

function trajectoryFailedOrRetried(trajectory: Trajectory): boolean {
	const status = trajectory.metrics?.finalStatus ?? "";
	if (status === "failed") return true;
	const meta = trajectory.metadata ?? {};
	const retryCount = meta.retryCount;
	if (typeof retryCount === "number" && retryCount > 0) return true;
	if (meta.retryDetected === true) return true;
	return false;
}

function pickMostRecent(
	items: TrajectoryListItem[],
): TrajectoryListItem | undefined {
	if (items.length === 0) return undefined;
	const sorted = [...items].sort((a, b) => (b.endTime ?? 0) - (a.endTime ?? 0));
	return sorted[0];
}

function locateActiveSkill(name: string): string | null {
	const skillPath = join(getActiveSkillsDir(), name, "SKILL.md");
	if (existsSync(skillPath)) return skillPath;
	return null;
}

export const skillRefinementEvaluator: Evaluator = {
	name: EVAL_NAME,
	description: EVAL_DESCRIPTION,
	similes: [],
	alwaysRun: false,
	examples: [] as EvaluationExample[],

	validate: async (runtime: IAgentRuntime): Promise<boolean> => {
		const service = getTrajectoryService(runtime);
		if (!service?.listTrajectories || !service.getTrajectoryDetail)
			return false;
		const list = await service.listTrajectories({ limit: 5 });
		const latest = pickMostRecent(list.trajectories ?? []);
		if (!latest) return false;
		const detail = await service.getTrajectoryDetail(latest.id);
		if (!detail) return false;
		if (!trajectoryFailedOrRetried(detail)) return false;
		return trajectoryUsedSkills(detail).length > 0;
	},

	handler: async (
		runtime: IAgentRuntime,
	): Promise<ActionResult | undefined> => {
		const service = getTrajectoryService(runtime);
		if (!service?.listTrajectories || !service.getTrajectoryDetail)
			return undefined;
		const list = await service.listTrajectories({ limit: 5 });
		const latest = pickMostRecent(list.trajectories ?? []);
		if (!latest) return undefined;
		const trajectory = await service.getTrajectoryDetail(latest.id);
		if (!trajectory) return undefined;
		if (!trajectoryFailedOrRetried(trajectory)) return undefined;
		const skills = trajectoryUsedSkills(trajectory);
		if (skills.length === 0) return undefined;

		const refinedNames: string[] = [];
		const proposedNames: string[] = [];
		const trajectoryDigest = formatTrajectoryForPrompt(trajectory, {
			statusLabel: "Final status",
		});

		for (const skillName of skills) {
			const activePath = locateActiveSkill(skillName);
			if (!activePath) continue;
			const currentText = readFileSync(activePath, "utf-8");
			const parsed = parseSkillFile(currentText);
			if (!parsed) {
				logger.warn(
					{
						src: "plugin:advanced-capabilities:evaluator:skill_refinement",
						agentId: runtime.agentId,
						skillName,
					},
					"Active skill file did not parse — skipping refinement",
				);
				continue;
			}

			const prompt = `${REFINEMENT_PROMPT}\n\nCurrent SKILL.md body:\n${parsed.body}\n\nFailing trajectory:\n${trajectoryDigest}`;
			const response = await runtime.useModel(ModelType.OBJECT_LARGE, {
				prompt,
				schema: REFINEMENT_RESPONSE_SCHEMA,
			});
			if (!response) continue;
			const draft = parseRefinementResponse(response);
			if (!draft?.refine || !draft.newBody) continue;
			if (draft.newBody.includes("---")) {
				logger.warn(
					{
						src: "plugin:advanced-capabilities:evaluator:skill_refinement",
						agentId: runtime.agentId,
						skillName,
					},
					"Refinement body contained frontmatter delimiter — skipping",
				);
				continue;
			}

			const provenanceRaw = parsed.frontmatter.provenance;
			const provenance: Record<string, unknown> =
				provenanceRaw &&
				typeof provenanceRaw === "object" &&
				!Array.isArray(provenanceRaw)
					? { ...(provenanceRaw as Record<string, unknown>) }
					: {
							source: "human",
							createdAt: new Date().toISOString(),
							refinedCount: 0,
						};

			const currentRefinedCount =
				typeof provenance.refinedCount === "number"
					? provenance.refinedCount
					: 0;
			const nowIso = new Date().toISOString();

			if (currentRefinedCount < MAX_AUTO_REFINEMENTS) {
				provenance.source = "agent-refined";
				provenance.derivedFromTrajectory = trajectory.trajectoryId;
				provenance.createdAt = nowIso;
				provenance.refinedCount = currentRefinedCount + 1;
				const newFrontmatter = {
					...parsed.frontmatter,
					provenance,
				};
				writeFileSync(
					activePath,
					serializeSkillFile(newFrontmatter, draft.newBody),
					"utf-8",
				);
				refinedNames.push(skillName);
				logger.info(
					{
						src: "plugin:advanced-capabilities:evaluator:skill_refinement",
						agentId: runtime.agentId,
						skillName,
						refinedCount: provenance.refinedCount,
					},
					"Auto-applied skill refinement",
				);
			} else {
				// Gradient mode — the LLM-diff auto-budget is exhausted, so we
				// switch to the native `prompt-evolution` optimizer. It pulls
				// trajectories tagged with this skill and rewrites the SKILL.md
				// body via the optimizer instead of by single-shot LLM diff.
				//
				// We dynamic-import the optimizer module so @elizaos/core does
				// not gain a hard dependency on @elizaos/app-training; the
				// import resolves only when the training package is installed
				// (which is the case in this monorepo). When the import fails,
				// we fall back to the previous "stage for human review"
				// behaviour so the closed loop never silently drops a refinement.
				const gradientResult = await tryGradientRefinement({
					runtime,
					trajectoryService: service,
					skillName,
					skillBody: parsed.body,
				});
				if (gradientResult) {
					const lineage = Array.isArray(provenance.optimizationLineage)
						? [
								...(provenance.optimizationLineage as Array<{
									optimizer: string;
									score: number;
									datasetSize: number;
									generatedAt: string;
								}>),
							]
						: [];
					lineage.push({
						optimizer: gradientResult.optimizer,
						score: gradientResult.score,
						datasetSize: gradientResult.datasetSize,
						generatedAt: nowIso,
					});
					provenance.source = "agent-refined";
					provenance.derivedFromTrajectory = trajectory.trajectoryId;
					provenance.createdAt = nowIso;
					provenance.optimizationLineage = lineage;
					const newFrontmatter = {
						...parsed.frontmatter,
						provenance,
					};
					writeFileSync(
						activePath,
						serializeSkillFile(newFrontmatter, gradientResult.optimizedBody),
						"utf-8",
					);
					refinedNames.push(skillName);
					logger.info(
						{
							src: "plugin:advanced-capabilities:evaluator:skill_refinement",
							agentId: runtime.agentId,
							skillName,
							optimizer: gradientResult.optimizer,
							score: gradientResult.score,
							datasetSize: gradientResult.datasetSize,
						},
						"Gradient-mode skill refinement applied via native optimizer",
					);
					continue;
				}
				const proposedDir = join(getProposedSkillsDir(), skillName);
				if (existsSync(proposedDir)) {
					logger.debug(
						{
							src: "plugin:advanced-capabilities:evaluator:skill_refinement",
							agentId: runtime.agentId,
							skillName,
						},
						"Refinement already proposed — skipping",
					);
					continue;
				}
				mkdirSync(proposedDir, { recursive: true });
				provenance.source = "agent-refined";
				provenance.derivedFromTrajectory = trajectory.trajectoryId;
				provenance.createdAt = nowIso;
				const stagedFrontmatter = {
					...parsed.frontmatter,
					provenance,
				};
				writeFileSync(
					join(proposedDir, "SKILL.md"),
					serializeSkillFile(stagedFrontmatter, draft.newBody),
					"utf-8",
				);
				proposedNames.push(skillName);
				logger.info(
					{
						src: "plugin:advanced-capabilities:evaluator:skill_refinement",
						agentId: runtime.agentId,
						skillName,
					},
					"Staged refinement for human review (auto-budget exhausted)",
				);
			}
		}

		if (refinedNames.length === 0 && proposedNames.length === 0) {
			return undefined;
		}

		return {
			success: true,
			text: `Refined ${refinedNames.length} skills, staged ${proposedNames.length} for review`,
			values: {
				skillRefinementApplied: refinedNames.length,
				skillRefinementStaged: proposedNames.length,
			},
			data: {
				refinedSkills: refinedNames,
				proposedSkills: proposedNames,
				trajectoryId: trajectory.trajectoryId,
			},
		};
	},
};

interface GradientRefinementInput {
	runtime: IAgentRuntime;
	trajectoryService: SkillTrajectoryService;
	skillName: string;
	skillBody: string;
}

interface GradientRefinementResult {
	optimizedBody: string;
	score: number;
	optimizer: "instruction-search" | "prompt-evolution" | "bootstrap-fewshot";
	datasetSize: number;
}

/**
 * Run the native `prompt-evolution` optimizer over the trajectories that
 * referenced this skill. Returns null when the optimizer module is not
 * installed, when there are too few trajectories to optimize against, or
 * when the optimization did not improve over the baseline.
 *
 * Uses dynamic import so @elizaos/core does not gain a hard dependency on
 * @elizaos/app-training.
 */
async function tryGradientRefinement(
	input: GradientRefinementInput,
): Promise<GradientRefinementResult | null> {
	const optimizers = await loadOptimizerModule();
	if (!optimizers) return null;

	const trajectories = await collectSkillTrajectories(
		input.trajectoryService,
		input.skillName,
	);
	if (trajectories.length < 3) return null;

	const dataset = trajectories.flatMap((trajectory) =>
		extractOptimizationExamples(trajectory),
	);
	if (dataset.length === 0) return null;

	const adapter = optimizers.createRuntimeAdapter(
		(args: { prompt: string; temperature?: number; maxTokens?: number }) =>
			input.runtime.useModel(ModelType.TEXT_LARGE, args) as Promise<
				string | object | undefined
			>,
	);
	const scorer = optimizers.createPromptScorer(adapter);
	const result = await optimizers.runPromptEvolution({
		baselinePrompt: input.skillBody,
		dataset,
		scorer,
		llm: adapter,
		options: { population: 4, generations: 2, mutationRate: 0.5 },
	});
	if (result.score <= result.baseline) return null;
	return {
		optimizedBody: result.optimizedPrompt,
		score: result.score,
		optimizer: "prompt-evolution",
		datasetSize: dataset.length,
	};
}

interface OptimizerModule {
	createRuntimeAdapter: (
		useModel: (input: {
			prompt: string;
			temperature?: number;
			maxTokens?: number;
		}) => Promise<string | object | undefined>,
	) => unknown;
	createPromptScorer: (adapter: unknown) => unknown;
	runPromptEvolution: (input: {
		baselinePrompt: string;
		dataset: Array<{
			input: { user: string; system?: string };
			expectedOutput: string;
		}>;
		scorer: unknown;
		llm: unknown;
		options?: {
			population?: number;
			generations?: number;
			mutationRate?: number;
		};
	}) => Promise<{
		optimizedPrompt: string;
		score: number;
		baseline: number;
	}>;
}

async function loadOptimizerModule(): Promise<OptimizerModule | null> {
	const dynamicImport = new Function("name", "return import(name);") as (
		name: string,
	) => Promise<unknown>;
	const mod = (await dynamicImport("@elizaos/app-training/optimizers").catch(
		() => null,
	)) as OptimizerModule | null;
	if (
		mod &&
		typeof mod.createRuntimeAdapter === "function" &&
		typeof mod.createPromptScorer === "function" &&
		typeof mod.runPromptEvolution === "function"
	) {
		return mod;
	}
	return null;
}

async function collectSkillTrajectories(
	service: SkillTrajectoryService,
	skillName: string,
): Promise<Trajectory[]> {
	if (!service.listTrajectories || !service.getTrajectoryDetail) return [];
	const list = await service.listTrajectories({ limit: 50 });
	const collected: Trajectory[] = [];
	for (const item of list.trajectories ?? []) {
		const detail = await service.getTrajectoryDetail(item.id);
		if (!detail) continue;
		const used = trajectoryUsedSkills(detail);
		if (used.includes(skillName)) collected.push(detail);
	}
	return collected;
}

function extractOptimizationExamples(
	trajectory: Trajectory,
): Array<{ input: { user: string; system?: string }; expectedOutput: string }> {
	const out: Array<{
		input: { user: string; system?: string };
		expectedOutput: string;
	}> = [];
	for (const step of trajectory.steps ?? []) {
		for (const call of step.llmCalls ?? []) {
			if (!call.userPrompt || !call.response) continue;
			out.push({
				input: { user: call.userPrompt, system: call.systemPrompt },
				expectedOutput: call.response,
			});
		}
	}
	return out;
}
