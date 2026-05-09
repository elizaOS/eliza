import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { logger } from "../../../logger.ts";
import type {
	Evaluator,
	IAgentRuntime,
	JSONSchema,
	Memory,
} from "../../../types/index.ts";
import { MemoryType } from "../../../types/memory.ts";
import type { Plugin } from "../../../types/plugin.ts";
import { resolveStateDir } from "../../../utils/state-dir.ts";
import {
	formatTrajectoryForPrompt,
	getTrajectoryService,
	type SkillTrajectoryService,
	type SkillTrajectory as Trajectory,
	type SkillTrajectoryListItem as TrajectoryListItem,
} from "./trajectory-evaluator-utils.ts";

const MIN_STEPS_FOR_EXTRACTION = 5;
const MAX_AUTO_REFINEMENTS = 3;
const PROPOSED_SUBDIR = ["skills", "curated", "proposed"] as const;
const LOG_SRC = "plugin:advanced-capabilities:evaluator:skill_learning";

const skillProposalSchema: JSONSchema = {
	type: "object",
	properties: {
		extract: { type: "boolean" },
		reason: { type: "string" },
		name: { type: "string" },
		description: { type: "string" },
		body: { type: "string" },
	},
	required: ["extract", "reason"],
	additionalProperties: false,
};

const skillRefinementSchema: JSONSchema = {
	type: "object",
	properties: {
		refinements: {
			type: "array",
			items: {
				type: "object",
				properties: {
					skillName: { type: "string" },
					refine: { type: "boolean" },
					reason: { type: "string" },
					newBody: { type: "string" },
				},
				required: ["skillName", "refine", "reason"],
				additionalProperties: false,
			},
		},
	},
	required: ["refinements"],
	additionalProperties: false,
};

interface SkillProposalOutput {
	extract: boolean;
	reason: string;
	name?: string;
	description?: string;
	body?: string;
}

interface SkillRefinementOutput {
	refinements: Array<{
		skillName: string;
		refine: boolean;
		reason: string;
		newBody?: string;
	}>;
}

interface ProposalPrepared {
	service: SkillTrajectoryService;
	trajectory: Trajectory;
	trajectoryDigest: string;
}

interface RefinementPrepared {
	service: SkillTrajectoryService;
	trajectory: Trajectory;
	trajectoryDigest: string;
	skills: Array<{
		name: string;
		path: string;
		frontmatter: Record<string, unknown>;
		body: string;
	}>;
}

interface ParsedSkillFile {
	frontmatter: Record<string, unknown>;
	body: string;
}

function getProposedSkillsDir(): string {
	return join(resolveStateDir(), ...PROPOSED_SUBDIR);
}

function getActiveSkillsDir(): string {
	return join(resolveStateDir(), "skills", "curated", "active");
}

function isLowerAlphaNumericOrHyphen(char: string): boolean {
	if (char === "-") return true;
	const code = char.charCodeAt(0);
	const isDigit = code >= 48 && code <= 57;
	const isLower = code >= 97 && code <= 122;
	return isDigit || isLower;
}

function isValidSkillName(name: string): boolean {
	if (!name || name.length > 64) return false;
	if (name.startsWith("-") || name.endsWith("-")) return false;
	let previousHyphen = false;
	for (const char of name) {
		if (!isLowerAlphaNumericOrHyphen(char)) return false;
		if (char === "-" && previousHyphen) return false;
		previousHyphen = char === "-";
	}
	return true;
}

function normalizeNewlines(text: string): string {
	return text
		.split("\n")
		.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line))
		.join("\n");
}

function splitFrontmatter(content: string): ParsedSkillFile | null {
	const normalized = normalizeNewlines(content);
	const lines = normalized.split("\n");
	if (lines[0] !== "---") return null;
	let endIndex = -1;
	for (let index = 1; index < lines.length; index += 1) {
		if (lines[index] === "---") {
			endIndex = index;
			break;
		}
	}
	if (endIndex === -1) return null;
	const yamlText = lines.slice(1, endIndex).join("\n");
	const body = lines
		.slice(endIndex + 1)
		.join("\n")
		.replaceAll("\u0000", "");
	const parsed = parseYaml(yamlText);
	const frontmatter =
		parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	return { frontmatter, body: body.startsWith("\n") ? body.slice(1) : body };
}

function bodyContainsFrontmatterDelimiter(body: string): boolean {
	for (const line of normalizeNewlines(body).split("\n")) {
		if (line.trim() === "---") return true;
	}
	return false;
}

function serializeSkillFile(
	frontmatter: Record<string, unknown>,
	body: string,
): string {
	return `---\n${stringifyYaml(frontmatter).trimEnd()}\n---\n\n${body.trimEnd()}\n`;
}

function renderSkillFile(params: {
	name: string;
	description: string;
	body: string;
	trajectoryId: string;
}): string {
	return serializeSkillFile(
		{
			name: params.name,
			description: params.description,
			provenance: {
				source: "agent-generated",
				derivedFromTrajectory: params.trajectoryId,
				createdAt: new Date().toISOString(),
				refinedCount: 0,
			},
		},
		params.body,
	);
}

function trajectoryUsedCuratedSkill(trajectory: Trajectory): boolean {
	return trajectoryUsedSkills(trajectory).length > 0;
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
	return meta.retryDetected === true;
}

function pickMostRecent(
	items: TrajectoryListItem[],
): TrajectoryListItem | undefined {
	if (items.length === 0) return undefined;
	return [...items].sort((a, b) => (b.endTime ?? 0) - (a.endTime ?? 0))[0];
}

async function getLatestTrajectory(
	runtime: IAgentRuntime,
): Promise<{ service: SkillTrajectoryService; trajectory: Trajectory } | null> {
	const service = getTrajectoryService(runtime);
	if (!service?.listTrajectories || !service.getTrajectoryDetail) return null;
	const list = await service.listTrajectories({ limit: 5 });
	const latest = pickMostRecent(list.trajectories ?? []);
	if (!latest) return null;
	const trajectory = await service.getTrajectoryDetail(latest.id);
	return trajectory ? { service, trajectory } : null;
}

async function shouldRunProposal(runtime: IAgentRuntime): Promise<boolean> {
	const latest = await getLatestTrajectory(runtime);
	if (!latest) return false;
	const { trajectory } = latest;
	const stepCount = trajectory.steps?.length ?? 0;
	const finalStatus = trajectory.metrics?.finalStatus ?? "";
	return (
		finalStatus === "completed" &&
		stepCount >= MIN_STEPS_FOR_EXTRACTION &&
		!trajectoryUsedCuratedSkill(trajectory)
	);
}

async function shouldRunRefinement(runtime: IAgentRuntime): Promise<boolean> {
	const latest = await getLatestTrajectory(runtime);
	if (!latest) return false;
	return (
		trajectoryFailedOrRetried(latest.trajectory) &&
		trajectoryUsedSkills(latest.trajectory).length > 0
	);
}

function parseProposalOutput(output: unknown): SkillProposalOutput | null {
	if (!output || typeof output !== "object" || Array.isArray(output)) {
		return null;
	}
	const obj = output as Record<string, unknown>;
	return {
		extract: obj.extract === true,
		reason: typeof obj.reason === "string" ? obj.reason : "",
		name: typeof obj.name === "string" ? obj.name : undefined,
		description:
			typeof obj.description === "string" ? obj.description : undefined,
		body: typeof obj.body === "string" ? obj.body : undefined,
	};
}

function parseRefinementOutput(output: unknown): SkillRefinementOutput | null {
	if (!output || typeof output !== "object" || Array.isArray(output)) {
		return null;
	}
	const refinementsRaw = (output as { refinements?: unknown }).refinements;
	if (!Array.isArray(refinementsRaw)) return null;
	const refinements = refinementsRaw
		.filter((item): item is Record<string, unknown> =>
			Boolean(item && typeof item === "object" && !Array.isArray(item)),
		)
		.map((item) => ({
			skillName: typeof item.skillName === "string" ? item.skillName : "",
			refine: item.refine === true,
			reason: typeof item.reason === "string" ? item.reason : "",
			newBody: typeof item.newBody === "string" ? item.newBody : undefined,
		}))
		.filter((item) => item.skillName.length > 0);
	return { refinements };
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
				text: `I noticed I might be able to learn skill "${skillName}" - view in Settings > Learned Skills.`,
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

function locateActiveSkill(name: string): string | null {
	const skillPath = join(getActiveSkillsDir(), name, "SKILL.md");
	return existsSync(skillPath) ? skillPath : null;
}

export const skillProposalEvaluator: Evaluator<
	SkillProposalOutput,
	ProposalPrepared
> = {
	name: "skillProposal",
	description:
		"Proposes a new SKILL.md when a successful trajectory contains a reusable procedure.",
	priority: 400,
	schema: skillProposalSchema,
	async shouldRun({ runtime }) {
		return shouldRunProposal(runtime);
	},
	async prepare({ runtime }) {
		const latest = await getLatestTrajectory(runtime);
		if (!latest) throw new Error("No trajectory available");
		return {
			service: latest.service,
			trajectory: latest.trajectory,
			trajectoryDigest: formatTrajectoryForPrompt(latest.trajectory, {
				includeStepCount: true,
				blankLineAfterHeader: true,
			}),
		};
	},
	prompt({ prepared }) {
		return `Evaluate whether this completed trajectory contains a reusable repeatable procedure worth saving as a SKILL.md.

Return extract=false if the run is too narrow, one-off, private, or not procedural.
If extract=true, provide:
- name: lowercase letters, digits, and hyphens only, up to 64 characters.
- description: one sentence, up to 200 characters.
- body: markdown body for the skill, without frontmatter.

Trajectory:
${prepared.trajectoryDigest}`;
	},
	parse: parseProposalOutput,
	processors: [
		{
			name: "writeSkillProposal",
			async process({ runtime, message, prepared, output }) {
				if (!output.extract) return undefined;
				const name = output.name?.trim() ?? "";
				const description = output.description?.trim() ?? "";
				const body = output.body?.trim() ?? "";
				if (!isValidSkillName(name) || !description || !body) return undefined;
				if (description.length > 200) return undefined;
				if (bodyContainsFrontmatterDelimiter(body)) return undefined;
				const proposedDir = getProposedSkillsDir();
				const skillDir = join(proposedDir, name);
				const activeDir = join(getActiveSkillsDir(), name);
				if (existsSync(activeDir) || existsSync(skillDir)) return undefined;
				mkdirSync(skillDir, { recursive: true });
				writeFileSync(
					join(skillDir, "SKILL.md"),
					renderSkillFile({
						name,
						description,
						body,
						trajectoryId: prepared.trajectory.trajectoryId,
					}),
					"utf-8",
				);
				await emitSkillNotice(runtime, message, name);
				return {
					success: true,
					text: `Drafted skill proposal: ${name}`,
					values: {
						skillProposalName: name,
						skillProposalTrajectoryId: prepared.trajectory.trajectoryId,
					},
					data: {
						skillName: name,
						trajectoryId: prepared.trajectory.trajectoryId,
						path: skillDir,
					},
				};
			},
		},
	],
};

export const skillRefinementEvaluator: Evaluator<
	SkillRefinementOutput,
	RefinementPrepared
> = {
	name: "skillRefinement",
	description:
		"Refines active skills that participated in a failed or retried trajectory.",
	priority: 410,
	schema: skillRefinementSchema,
	async shouldRun({ runtime }) {
		return shouldRunRefinement(runtime);
	},
	async prepare({ runtime }) {
		const latest = await getLatestTrajectory(runtime);
		if (!latest) throw new Error("No trajectory available");
		const skills = trajectoryUsedSkills(latest.trajectory)
			.map((name) => {
				const path = locateActiveSkill(name);
				if (!path) return null;
				const parsed = splitFrontmatter(readFileSync(path, "utf-8"));
				if (!parsed) return null;
				return {
					name,
					path,
					frontmatter: parsed.frontmatter,
					body: parsed.body,
				};
			})
			.filter((item): item is RefinementPrepared["skills"][number] =>
				Boolean(item),
			);
		return {
			service: latest.service,
			trajectory: latest.trajectory,
			trajectoryDigest: formatTrajectoryForPrompt(latest.trajectory, {
				statusLabel: "Final status",
			}),
			skills,
		};
	},
	prompt({ prepared }) {
		const skillSections = prepared.skills
			.map(
				(skill) => `### ${skill.name}

${skill.body}`,
			)
			.join("\n\n");
		return `Evaluate whether the active skills should be refined because this trajectory failed or retried while using them.

Return one refinement object per skill. Set refine=false when no update is warranted.
When refine=true, newBody must be the complete replacement markdown body without frontmatter.
Do not invent capabilities. Tighten steps, add guardrails for the failure mode, and remove ambiguity.

Active skills:
${skillSections || "(none)"}

Trajectory:
${prepared.trajectoryDigest}`;
	},
	parse: parseRefinementOutput,
	processors: [
		{
			name: "applySkillRefinements",
			async process({ prepared, output }) {
				const skillsByName = new Map(
					prepared.skills.map((skill) => [skill.name, skill]),
				);
				const refinedNames: string[] = [];
				const proposedNames: string[] = [];
				for (const refinement of output.refinements) {
					if (!refinement.refine || !refinement.newBody) continue;
					if (bodyContainsFrontmatterDelimiter(refinement.newBody)) continue;
					const skill = skillsByName.get(refinement.skillName);
					if (!skill) continue;
					const provenanceRaw = skill.frontmatter.provenance;
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
						provenance.derivedFromTrajectory = prepared.trajectory.trajectoryId;
						provenance.createdAt = nowIso;
						provenance.refinedCount = currentRefinedCount + 1;
						writeFileSync(
							skill.path,
							serializeSkillFile(
								{ ...skill.frontmatter, provenance },
								refinement.newBody,
							),
							"utf-8",
						);
						refinedNames.push(skill.name);
						continue;
					}
					const proposedDir = join(getProposedSkillsDir(), skill.name);
					if (existsSync(proposedDir)) continue;
					mkdirSync(proposedDir, { recursive: true });
					provenance.source = "agent-refined";
					provenance.derivedFromTrajectory = prepared.trajectory.trajectoryId;
					provenance.createdAt = nowIso;
					writeFileSync(
						join(proposedDir, "SKILL.md"),
						serializeSkillFile(
							{ ...skill.frontmatter, provenance },
							refinement.newBody,
						),
						"utf-8",
					);
					proposedNames.push(skill.name);
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
						trajectoryId: prepared.trajectory.trajectoryId,
					},
				};
			},
		},
	],
};

export const skillItems: NonNullable<Plugin["evaluators"]> = [
	skillProposalEvaluator,
	skillRefinementEvaluator,
];

export function _countProposedSkills(): number {
	const dir = getProposedSkillsDir();
	if (!existsSync(dir)) return 0;
	return readdirSync(dir, { withFileTypes: true }).filter((entry) =>
		entry.isDirectory(),
	).length;
}
