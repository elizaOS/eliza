/**
 * Consolidated skill-learning action.
 *
 * Single `ALWAYS_AFTER` hook that watches the latest trajectory and either:
 *   - drafts a new SKILL.md proposal when a successful run did not use any
 *     curated skill (extraction branch), or
 *   - refines an existing curated skill that participated in a failing or
 *     retried trajectory (refinement branch).
 *
 * Extraction trigger:
 *   - latest trajectory `status === "completed"`
 *   - `stepCount >= 5`
 *   - trajectory did NOT use any curated skill
 *
 * Refinement trigger:
 *   - latest trajectory failed OR has retry signals
 *   - trajectory DID use one or more curated skills
 *
 * If neither holds, validate returns false and handler returns undefined.
 *
 * Drafted skills land under `~/.eliza/skills/curated/proposed/<name>/SKILL.md`
 * with provenance set to `agent-generated`. Proposed skills are NEVER
 * auto-loaded into the runtime — the user reviews them via Settings → Learned
 * Skills and either promotes, edits, or discards.
 *
 * Refinement budget: the first three auto-refinements are applied directly to
 * the active skill (provenance.refinedCount increments). After that, the
 * native `prompt-evolution` optimizer is dispatched via dynamic import of
 * `@elizaos/app-training/optimizers`; if that fails, the refinement is staged
 * under `~/.eliza/skills/curated/proposed/<name>/SKILL.md` for human review.
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { logger } from "../../../logger.ts";
import type {
	Action,
	ActionResult,
	IAgentRuntime,
	Memory,
} from "../../../types/index.ts";
import { ActionMode, ModelType } from "../../../types/index.ts";
import { MemoryType } from "../../../types/memory.ts";
import { resolveStateDir } from "../../../utils/state-dir.ts";
import {
	formatTrajectoryForPrompt,
	getTrajectoryService,
	parseJsonObject,
	type SkillTrajectoryService,
	type SkillTrajectory as Trajectory,
	type SkillTrajectoryListItem as TrajectoryListItem,
} from "./trajectory-evaluator-utils.ts";

const EVAL_NAME = "SKILL_LEARNING";
const EVAL_DESCRIPTION =
	"Learns from completed trajectories: drafts new SKILL.md proposals from successful runs that didn't use a curated skill, and refines existing curated skills when they participated in failing or retried trajectories.";

const MIN_STEPS_FOR_EXTRACTION = 5;
const MAX_AUTO_REFINEMENTS = 3;
const PROPOSED_SUBDIR = ["skills", "curated", "proposed"] as const;

const LOG_SRC = "plugin:advanced-capabilities:action:skill_learning";

const EXTRACTION_SYSTEM_PROMPT = `You are a senior engineer triaging successful agent runs to find reusable
procedures. You will look at one completed trajectory (a sequence of steps,
each with a system prompt, user prompt, and model response) and decide whether
there is a generalizable, repeatable procedure worth saving as a SKILL.md.

Return a JSON object matching the provided schema. Do not include prose or fences.

If there is NO generalizable skill, set:
- extract: false
- reason: short reason

If there IS a generalizable skill, set:
- extract: true
- name: lowercase-hyphen-name
- description: one-sentence description, <=200 chars
- body: markdown body for the skill

Rules:
- name MUST be lowercase a-z, 0-9, hyphens only, no leading/trailing/double hyphens.
- name MUST NOT exceed 64 characters.
- description MUST be a single sentence and MUST NOT exceed 200 characters.
- body MUST be markdown without a frontmatter block.
- Skip if the trajectory is too narrow, contains private data, or is one-off.`;

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

const EXTRACTION_RESPONSE_SCHEMA = {
	type: "object",
	properties: {
		extract: { type: "boolean" },
		reason: { type: "string" },
		name: { type: "string" },
		description: { type: "string" },
		body: { type: "string" },
	},
	required: ["extract"],
};

const REFINEMENT_RESPONSE_SCHEMA = {
	type: "object",
	properties: {
		refine: { type: "boolean" },
		reason: { type: "string" },
		newBody: { type: "string" },
	},
	required: ["refine"],
};

interface ExtractionDraft {
	extract: boolean;
	reason?: string;
	name?: string;
	description?: string;
	body?: string;
}

interface RefinementDraft {
	refine: boolean;
	reason?: string;
	newBody?: string;
}

interface ParsedSkillFile {
	frontmatter: Record<string, unknown>;
	body: string;
}

type TriggerKind = "extract" | "refine" | null;

interface DetectedTrigger {
	kind: TriggerKind;
	service: SkillTrajectoryService | null;
	trajectory: Trajectory | null;
}

function getProposedSkillsDir(): string {
	return join(resolveStateDir(), ...PROPOSED_SUBDIR);
}

function getActiveSkillsDir(): string {
	return join(resolveStateDir(), "skills", "curated", "active");
}

function trajectoryUsedCuratedSkill(trajectory: Trajectory): boolean {
	const steps = trajectory.steps ?? [];
	for (const step of steps) {
		const used = step.usedSkills;
		if (Array.isArray(used) && used.length > 0) {
			return true;
		}
	}
	const metaUsed = trajectory.metadata?.usedSkills;
	if (Array.isArray(metaUsed) && metaUsed.length > 0) {
		return true;
	}
	return false;
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

function pickRecentLatestCompleted(
	items: TrajectoryListItem[],
): TrajectoryListItem | undefined {
	const completed = items.filter((t) => t.status === "completed");
	if (completed.length === 0) return undefined;
	completed.sort((a, b) => (b.endTime ?? 0) - (a.endTime ?? 0));
	return completed[0];
}

function pickMostRecent(
	items: TrajectoryListItem[],
): TrajectoryListItem | undefined {
	if (items.length === 0) return undefined;
	const sorted = [...items].sort((a, b) => (b.endTime ?? 0) - (a.endTime ?? 0));
	return sorted[0];
}

/**
 * Detect which branch (if any) should run for this turn. Reads the latest
 * trajectory once and decides between extraction (successful + no curated
 * skill used) and refinement (failed/retried + curated skill used).
 */
async function detectTrigger(runtime: IAgentRuntime): Promise<DetectedTrigger> {
	const service = getTrajectoryService(runtime);
	if (!service?.listTrajectories || !service.getTrajectoryDetail) {
		return { kind: null, service: null, trajectory: null };
	}

	const list = await service.listTrajectories({ limit: 5 });
	const latest = pickMostRecent(list.trajectories ?? []);
	if (!latest) {
		return { kind: null, service, trajectory: null };
	}
	const detail = await service.getTrajectoryDetail(latest.id);
	if (!detail) {
		return { kind: null, service, trajectory: null };
	}

	if (
		trajectoryFailedOrRetried(detail) &&
		trajectoryUsedSkills(detail).length > 0
	) {
		return { kind: "refine", service, trajectory: detail };
	}

	if (
		latest.status === "completed" &&
		(latest.stepCount ?? 0) >= MIN_STEPS_FOR_EXTRACTION &&
		!trajectoryUsedCuratedSkill(detail)
	) {
		return { kind: "extract", service, trajectory: detail };
	}

	return { kind: null, service, trajectory: null };
}

// ---------------------------------------------------------------------------
// Extraction branch
// ---------------------------------------------------------------------------

function parseExtractionResponse(raw: unknown): ExtractionDraft | null {
	const obj =
		raw && typeof raw === "object" && !Array.isArray(raw)
			? (raw as Record<string, unknown>)
			: typeof raw === "string"
				? parseJsonObject(raw)
				: null;
	if (!obj) return null;
	const extract = obj.extract === true;
	const draft: ExtractionDraft = { extract };
	if (typeof obj.reason === "string") draft.reason = obj.reason;
	if (typeof obj.name === "string") draft.name = obj.name;
	if (typeof obj.description === "string") draft.description = obj.description;
	if (typeof obj.body === "string") draft.body = obj.body;
	return draft;
}

function isValidSkillName(name: string): boolean {
	if (!name || name.length > 64) return false;
	if (!/^[a-z0-9-]+$/.test(name)) return false;
	if (name.startsWith("-") || name.endsWith("-")) return false;
	if (name.includes("--")) return false;
	return true;
}

/**
 * Render a SKILL.md file with provenance frontmatter. Kept inline (rather
 * than depending on `@elizaos/skills`) to avoid a new package edge from this
 * action file.
 */
function renderSkillFile(params: {
	name: string;
	description: string;
	body: string;
	trajectoryId: string;
}): string {
	const escapeYaml = (value: string): string => {
		if (/[:#"'\n]/.test(value)) {
			return JSON.stringify(value);
		}
		return value;
	};
	const createdAt = new Date().toISOString();
	const lines = [
		"---",
		`name: ${params.name}`,
		`description: ${escapeYaml(params.description)}`,
		"provenance:",
		"  source: agent-generated",
		`  derivedFromTrajectory: ${params.trajectoryId}`,
		`  createdAt: ${createdAt}`,
		"  refinedCount: 0",
		"---",
		"",
		params.body.trimEnd(),
		"",
	];
	return lines.join("\n");
}

async function emitSkillNotice(
	runtime: IAgentRuntime,
	message: Memory,
	skillName: string,
): Promise<void> {
	if (!message.roomId) return;
	try {
		const noticeMemory: Memory = {
			entityId: runtime.agentId,
			agentId: runtime.agentId,
			roomId: message.roomId,
			content: {
				text: `I noticed I might be able to learn skill \`${skillName}\` — view in Settings → Learned Skills.`,
			},
			metadata: {
				type: MemoryType.CUSTOM,
				source: "skill_proposal_notice",
			},
			createdAt: Date.now(),
		};
		await runtime.createMemory(noticeMemory, "messages");
	} catch (err) {
		logger.warn(
			{
				src: LOG_SRC,
				agentId: runtime.agentId,
				err: err instanceof Error ? err.message : String(err),
			},
			"Failed to emit skill proposal notice",
		);
	}
}

async function runExtraction(
	runtime: IAgentRuntime,
	message: Memory,
	trajectory: Trajectory,
): Promise<ActionResult | undefined> {
	const trajectoryDigest = formatTrajectoryForPrompt(trajectory, {
		includeStepCount: true,
		blankLineAfterHeader: true,
	});
	const response = await runtime.useModel(ModelType.OBJECT_LARGE, {
		prompt: `${EXTRACTION_SYSTEM_PROMPT}\n\n${trajectoryDigest}`,
		schema: EXTRACTION_RESPONSE_SCHEMA,
	});
	if (!response) {
		logger.debug(
			{ src: LOG_SRC, agentId: runtime.agentId },
			"Skill extraction returned no response",
		);
		return undefined;
	}

	const draft = parseExtractionResponse(response);
	if (!draft?.extract) {
		logger.debug(
			{ src: LOG_SRC, agentId: runtime.agentId, reason: draft?.reason },
			"No skill extracted from trajectory",
		);
		return undefined;
	}

	const name = draft.name?.trim();
	const description = draft.description?.trim();
	const body = draft.body?.trim();
	if (!name || !description || !body) {
		logger.warn(
			{ src: LOG_SRC, agentId: runtime.agentId },
			"Skill draft missing required fields",
		);
		return undefined;
	}
	if (!isValidSkillName(name)) {
		logger.warn(
			{ src: LOG_SRC, agentId: runtime.agentId, name },
			"Skill draft has invalid name",
		);
		return undefined;
	}
	if (description.length > 200) {
		logger.warn(
			{
				src: LOG_SRC,
				agentId: runtime.agentId,
				descriptionLength: description.length,
			},
			"Skill draft description exceeds 200 chars",
		);
		return undefined;
	}

	const proposedDir = getProposedSkillsDir();
	const skillDir = join(proposedDir, name);
	const activeDir = join(getActiveSkillsDir(), name);
	if (existsSync(activeDir)) {
		logger.debug(
			{ src: LOG_SRC, agentId: runtime.agentId, name },
			"Skill already active — skipping proposal",
		);
		return undefined;
	}
	if (existsSync(skillDir)) {
		logger.debug(
			{ src: LOG_SRC, agentId: runtime.agentId, name },
			"Skill proposal already pending",
		);
		return undefined;
	}

	mkdirSync(skillDir, { recursive: true });
	const fileText = renderSkillFile({
		name,
		description,
		body,
		trajectoryId: trajectory.trajectoryId,
	});
	writeFileSync(join(skillDir, "SKILL.md"), fileText, "utf-8");

	await emitSkillNotice(runtime, message, name);

	logger.info(
		{
			src: LOG_SRC,
			agentId: runtime.agentId,
			name,
			trajectoryId: trajectory.trajectoryId,
		},
		"Drafted curated skill proposal",
	);

	return {
		success: true,
		text: `Drafted skill proposal: ${name}`,
		values: {
			skillProposalName: name,
			skillProposalTrajectoryId: trajectory.trajectoryId,
		},
		data: {
			skillName: name,
			trajectoryId: trajectory.trajectoryId,
			path: skillDir,
		},
	};
}

// ---------------------------------------------------------------------------
// Refinement branch
// ---------------------------------------------------------------------------

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

function locateActiveSkill(name: string): string | null {
	const skillPath = join(getActiveSkillsDir(), name, "SKILL.md");
	if (existsSync(skillPath)) return skillPath;
	return null;
}

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

async function runRefinement(
	runtime: IAgentRuntime,
	service: SkillTrajectoryService,
	trajectory: Trajectory,
): Promise<ActionResult | undefined> {
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
				{ src: LOG_SRC, agentId: runtime.agentId, skillName },
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
				{ src: LOG_SRC, agentId: runtime.agentId, skillName },
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
					src: LOG_SRC,
					agentId: runtime.agentId,
					skillName,
					refinedCount: provenance.refinedCount,
				},
				"Auto-applied skill refinement",
			);
			continue;
		}

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
					src: LOG_SRC,
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
				{ src: LOG_SRC, agentId: runtime.agentId, skillName },
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
			{ src: LOG_SRC, agentId: runtime.agentId, skillName },
			"Staged refinement for human review (auto-budget exhausted)",
		);
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
}

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

export const skillEvaluator: Action = {
	name: EVAL_NAME,
	description: EVAL_DESCRIPTION,
	similes: ["SKILL_EXTRACTION", "SKILL_REFINEMENT", "SKILL_LEARNING"],
	mode: ActionMode.ALWAYS_AFTER,
	modePriority: 200,
	examples: [],

	validate: async (runtime: IAgentRuntime): Promise<boolean> => {
		const trigger = await detectTrigger(runtime);
		return trigger.kind !== null;
	},

	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
	): Promise<ActionResult | undefined> => {
		const trigger = await detectTrigger(runtime);
		if (!trigger.kind || !trigger.service || !trigger.trajectory) {
			return undefined;
		}
		if (trigger.kind === "extract") {
			return runExtraction(runtime, message, trigger.trajectory);
		}
		return runRefinement(runtime, trigger.service, trigger.trajectory);
	},
};

/**
 * Internal helper exposed for tests — counts proposed skill directories.
 */
export function _countProposedSkills(): number {
	const dir = getProposedSkillsDir();
	if (!existsSync(dir)) return 0;
	return readdirSync(dir, { withFileTypes: true }).filter((entry) =>
		entry.isDirectory(),
	).length;
}
