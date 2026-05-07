/**
 * Skill extraction evaluator.
 *
 * Watches successful trajectories and asks an LLM whether the agent just
 * executed a generalizable procedure that should be lifted into a reusable
 * SKILL.md. Drafted skills are staged under
 * `~/.eliza/skills/curated/proposed/<name>/SKILL.md` with provenance set to
 * `agent-generated`. Proposed skills are NEVER auto-loaded into the runtime —
 * the user reviews them via the Settings → Learned Skills panel and either
 * promotes, edits, or discards.
 *
 * Triggers when:
 *   - the just-completed trajectory has status "completed"
 *   - the trajectory has at least 5 steps
 *   - no curated skill was used (avoids self-reinforcing extraction loops)
 *
 * The validator is intentionally cheap; the handler bears the LLM cost.
 */

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../../../logger.ts";
import type {
	ActionResult,
	EvaluationExample,
	Evaluator,
	IAgentRuntime,
	Memory,
} from "../../../types/index.ts";
import { ModelType } from "../../../types/index.ts";
import { MemoryType } from "../../../types/memory.ts";
import { resolveStateDir } from "../../../utils/state-dir.ts";

interface TrajectoryStep {
	stepId?: string;
	timestamp: number;
	llmCalls?: Array<{
		systemPrompt?: string;
		userPrompt?: string;
		response?: string;
		actionType?: string;
		purpose?: string;
	}>;
	usedSkills?: string[];
}

interface Trajectory {
	trajectoryId: string;
	agentId: string;
	startTime: number;
	endTime?: number;
	steps?: TrajectoryStep[];
	metrics?: { finalStatus?: string };
	metadata?: Record<string, unknown>;
}

interface TrajectoryListItem {
	id: string;
	status: string;
	stepCount?: number;
	endTime: number | null;
	metadata?: Record<string, unknown>;
}

interface TrajectoryServiceShape {
	listTrajectories?: (options: {
		limit?: number;
		status?: string;
	}) => Promise<{ trajectories: TrajectoryListItem[] }>;
	getTrajectoryDetail?: (trajectoryId: string) => Promise<Trajectory | null>;
}

const MIN_STEPS_FOR_EXTRACTION = 5;
const PROPOSED_SUBDIR = ["skills", "curated", "proposed"] as const;
const EVAL_NAME = "SKILL_EXTRACTION";
const EVAL_DESCRIPTION =
	"Drafts reusable SKILL.md proposals from successful trajectories.";

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

function getProposedSkillsDir(): string {
	return join(resolveStateDir(), ...PROPOSED_SUBDIR);
}

function getActiveSkillsDir(): string {
	return join(resolveStateDir(), "skills", "curated", "active");
}

interface ExtractionDraft {
	extract: boolean;
	reason?: string;
	name?: string;
	description?: string;
	body?: string;
}

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

function parseJsonObject(raw: string): Record<string, unknown> | null {
	const fenceMatch = raw.match(/```json\s*([\s\S]*?)\s*```/i);
	const jsonText = fenceMatch ? fenceMatch[1] : raw.trim();
	if (!jsonText) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonText);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object") {
		return null;
	}
	return parsed as Record<string, unknown>;
}

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
 * evaluator file.
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

function formatTrajectoryForPrompt(trajectory: Trajectory): string {
	const steps = trajectory.steps ?? [];
	const lines: string[] = [];
	lines.push(`Trajectory: ${trajectory.trajectoryId}`);
	lines.push(`Status: ${trajectory.metrics?.finalStatus ?? "unknown"}`);
	lines.push(`Step count: ${steps.length}`);
	lines.push("");
	let i = 0;
	for (const step of steps) {
		i += 1;
		lines.push(`--- Step ${i} ---`);
		const calls = step.llmCalls ?? [];
		for (const call of calls) {
			const purpose = call.purpose ?? call.actionType ?? "step";
			lines.push(`[${purpose}]`);
			if (call.userPrompt) {
				lines.push(`USER: ${call.userPrompt.slice(0, 600)}`);
			}
			if (call.response) {
				lines.push(`AGENT: ${call.response.slice(0, 600)}`);
			}
		}
	}
	return lines.join("\n");
}

function pickRecentLatestCompleted(
	items: TrajectoryListItem[],
): TrajectoryListItem | undefined {
	const completed = items.filter((t) => t.status === "completed");
	if (completed.length === 0) return undefined;
	completed.sort((a, b) => (b.endTime ?? 0) - (a.endTime ?? 0));
	return completed[0];
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
				src: "plugin:advanced-capabilities:evaluator:skill_extraction",
				agentId: runtime.agentId,
				err: err instanceof Error ? err.message : String(err),
			},
			"Failed to emit skill proposal notice",
		);
	}
}

function getTrajectoryService(
	runtime: IAgentRuntime,
): TrajectoryServiceShape | null {
	const svc = runtime.getService("trajectories");
	if (!svc) return null;
	const shape = svc as unknown as TrajectoryServiceShape;
	if (
		typeof shape.listTrajectories !== "function" ||
		typeof shape.getTrajectoryDetail !== "function"
	) {
		return null;
	}
	return shape;
}

export const skillExtractionEvaluator: Evaluator = {
	name: EVAL_NAME,
	description: EVAL_DESCRIPTION,
	similes: [],
	alwaysRun: false,
	examples: [] as EvaluationExample[],

	validate: async (
		runtime: IAgentRuntime,
		message: Memory,
	): Promise<boolean> => {
		if (!message.roomId) return false;
		const service = getTrajectoryService(runtime);
		if (!service?.listTrajectories || !service.getTrajectoryDetail) {
			return false;
		}
		const list = await service.listTrajectories({
			limit: 5,
			status: "completed",
		});
		const latest = pickRecentLatestCompleted(list.trajectories ?? []);
		if (!latest) return false;
		if ((latest.stepCount ?? 0) < MIN_STEPS_FOR_EXTRACTION) return false;
		const detail = await service.getTrajectoryDetail(latest.id);
		if (!detail) return false;
		return !trajectoryUsedCuratedSkill(detail);
	},

	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
	): Promise<ActionResult | undefined> => {
		const service = getTrajectoryService(runtime);
		if (!service?.listTrajectories || !service.getTrajectoryDetail) {
			return undefined;
		}
		const list = await service.listTrajectories({
			limit: 5,
			status: "completed",
		});
		const latest = pickRecentLatestCompleted(list.trajectories ?? []);
		if (!latest) return undefined;
		const trajectory = await service.getTrajectoryDetail(latest.id);
		if (!trajectory) return undefined;

		const trajectoryDigest = formatTrajectoryForPrompt(trajectory);
		const response = await runtime.useModel(ModelType.OBJECT_LARGE, {
			prompt: `${EXTRACTION_SYSTEM_PROMPT}\n\n${trajectoryDigest}`,
			schema: EXTRACTION_RESPONSE_SCHEMA,
		});
		if (!response) {
			logger.debug(
				{
					src: "plugin:advanced-capabilities:evaluator:skill_extraction",
					agentId: runtime.agentId,
				},
				"Skill extraction returned no response",
			);
			return undefined;
		}

		const draft = parseExtractionResponse(response);
		if (!draft?.extract) {
			logger.debug(
				{
					src: "plugin:advanced-capabilities:evaluator:skill_extraction",
					agentId: runtime.agentId,
					reason: draft?.reason,
				},
				"No skill extracted from trajectory",
			);
			return undefined;
		}

		const name = draft.name?.trim();
		const description = draft.description?.trim();
		const body = draft.body?.trim();
		if (!name || !description || !body) {
			logger.warn(
				{
					src: "plugin:advanced-capabilities:evaluator:skill_extraction",
					agentId: runtime.agentId,
				},
				"Skill draft missing required fields",
			);
			return undefined;
		}
		if (!isValidSkillName(name)) {
			logger.warn(
				{
					src: "plugin:advanced-capabilities:evaluator:skill_extraction",
					agentId: runtime.agentId,
					name,
				},
				"Skill draft has invalid name",
			);
			return undefined;
		}
		if (description.length > 200) {
			logger.warn(
				{
					src: "plugin:advanced-capabilities:evaluator:skill_extraction",
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
				{
					src: "plugin:advanced-capabilities:evaluator:skill_extraction",
					agentId: runtime.agentId,
					name,
				},
				"Skill already active — skipping proposal",
			);
			return undefined;
		}
		if (existsSync(skillDir)) {
			// Don't clobber an existing pending proposal.
			logger.debug(
				{
					src: "plugin:advanced-capabilities:evaluator:skill_extraction",
					agentId: runtime.agentId,
					name,
				},
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
				src: "plugin:advanced-capabilities:evaluator:skill_extraction",
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
