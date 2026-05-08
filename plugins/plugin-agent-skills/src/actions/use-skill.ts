/**
 * Use Skill Action — canonical entry point for invoking an installed skill.
 *
 * This is the single action surface that callers (LLM, UI, tests) should use
 * when they want to actually run a skill that's already enabled. It validates
 * eligibility, dispatches to script execution or guidance retrieval, and
 * annotates the active trajectory step with the skill that ran.
 *
 * The older fragmented actions (RUN_SKILL_SCRIPT, GET_SKILL_GUIDANCE) have
 * been removed. RUN_SKILL and INVOKE_SKILL are listed as similes so callers
 * still emitting those legacy names continue to resolve to USE_SKILL.
 */

import { spawn } from "node:child_process";
import * as path from "node:path";
import {
	type Action,
	type ActionParameter,
	type ActionResult,
	annotateActiveTrajectoryStep,
	getTrajectoryContext,
	type HandlerCallback,
	type IAgentRuntime,
	type Memory,
	type State,
} from "@elizaos/core";
import type { AgentSkillsService } from "../services/skills";

const SCRIPT_TIMEOUT_MS = 60_000;

type UseSkillMode = "guidance" | "script" | "auto";

interface UseSkillOptions {
	slug?: string;
	mode?: UseSkillMode;
	script?: string;
	args?: unknown;
}

interface ScriptResult {
	success: boolean;
	exitCode: number;
	stdout: string;
	stderr: string;
}

const USE_SKILL_PARAMETERS: ActionParameter[] = [
	{
		name: "slug",
		description:
			"Slug (canonical name) of an enabled skill to invoke. Must match a skill returned by the enabled_skills provider.",
		required: true,
		schema: { type: "string" },
	},
	{
		name: "mode",
		description:
			"How to invoke the skill: 'script' to run the bundled executable, 'guidance' to load the SKILL.md instructions, or 'auto' to pick automatically based on whether the skill ships scripts.",
		required: false,
		schema: {
			type: "string",
			enum: ["guidance", "script", "auto"],
			default: "auto",
		},
	},
	{
		name: "script",
		description:
			"Optional script filename to run (used with mode='script' or mode='auto' when the skill has multiple scripts). Defaults to the first script in the skill.",
		required: false,
		schema: { type: "string" },
	},
	{
		name: "args",
		description:
			"Optional arguments to pass to the skill's script. Either an array of strings or a JSON object whose values become positional arguments.",
		required: false,
		schema: { type: "object" },
	},
];

function pickMode(
	requested: UseSkillMode | undefined,
	hasScripts: boolean,
): "script" | "guidance" {
	if (requested === "script") return "script";
	if (requested === "guidance") return "guidance";
	return hasScripts ? "script" : "guidance";
}

function normaliseArgs(raw: unknown): string[] {
	if (raw === undefined || raw === null) return [];
	if (Array.isArray(raw)) return raw.map((v) => String(v));
	if (typeof raw === "object") {
		return Object.values(raw as Record<string, unknown>).map((v) => String(v));
	}
	return [String(raw)];
}

function executeScript(
	scriptPath: string,
	args: string[],
	env: Record<string, string>,
): Promise<ScriptResult> {
	return new Promise((resolve) => {
		const ext = path.extname(scriptPath).toLowerCase();
		let cmd: string;
		let cmdArgs: string[];

		switch (ext) {
			case ".py":
				cmd = "python3";
				cmdArgs = [scriptPath, ...args];
				break;
			case ".sh":
				cmd = "bash";
				cmdArgs = [scriptPath, ...args];
				break;
			case ".js":
				cmd = "node";
				cmdArgs = [scriptPath, ...args];
				break;
			default:
				cmd = scriptPath;
				cmdArgs = args;
		}

		const child = spawn(cmd, cmdArgs, {
			stdio: ["pipe", "pipe", "pipe"],
			timeout: SCRIPT_TIMEOUT_MS,
			env,
		});

		let stdout = "";
		let stderr = "";

		child.stdout?.on("data", (data) => {
			stdout += String(data);
		});

		child.stderr?.on("data", (data) => {
			stderr += String(data);
		});

		child.on("close", (code) => {
			resolve({
				success: code === 0,
				exitCode: code ?? 0,
				stdout: stdout.trim(),
				stderr: stderr.trim(),
			});
		});

		child.on("error", (error) => {
			resolve({
				success: false,
				exitCode: -1,
				stdout: "",
				stderr: error.message,
			});
		});
	});
}

export const useSkillAction: Action = {
	name: "USE_SKILL",
	contexts: ["automation", "knowledge", "connectors"],
	contextGate: { anyOf: ["automation", "knowledge", "connectors"] },
	roleGate: { minRole: "USER" },
	similes: [],
	description:
		"Invoke an enabled skill by slug. The skill's instructions or script run and the result returns to the conversation.",
	descriptionCompressed: "Invoke an enabled skill by slug.",
	parameters: USE_SKILL_PARAMETERS,

	validate: async (runtime: IAgentRuntime): Promise<boolean> => {
		const service = runtime.getService<AgentSkillsService>(
			"AGENT_SKILLS_SERVICE",
		);
		return Boolean(service);
	},

	handler: async (
		runtime: IAgentRuntime,
		_message: Memory,
		_state: State | undefined,
		options: unknown,
		callback?: HandlerCallback,
	): Promise<ActionResult> => {
		const service = runtime.getService<AgentSkillsService>(
			"AGENT_SKILLS_SERVICE",
		);
		if (!service) {
			const errorText = "AgentSkillsService not available.";
			if (callback) await callback({ text: errorText });
			return { success: false, error: new Error(errorText) };
		}

		const opts = (options ?? {}) as UseSkillOptions;
		const rawSlug = typeof opts.slug === "string" ? opts.slug.trim() : "";
		if (!rawSlug) {
			const errorText =
				"USE_SKILL requires a `slug` parameter naming the skill to invoke.";
			if (callback) await callback({ text: errorText });
			return { success: false, error: new Error(errorText) };
		}

		const skill = service.getLoadedSkill(rawSlug);
		if (!skill) {
			const installed = service
				.getLoadedSkills()
				.map((s) => s.slug)
				.slice(0, 10);
			const errorText =
				`Skill \`${rawSlug}\` is not installed. ` +
				`Installed skills: ${installed.join(", ") || "(none)"}. ` +
				`Use SKILL op=install to install a skill from the registry.`;
			if (callback) await callback({ text: errorText });
			return { success: false, error: new Error(errorText) };
		}

		const enabled = service.isSkillEnabled(skill.slug);
		if (!enabled) {
			const errorText = `Skill \`${skill.slug}\` is disabled. Use SKILL op=toggle enabled=true to enable it first.`;
			if (callback) await callback({ text: errorText });
			return { success: false, error: new Error(errorText) };
		}

		const eligibility = await service.checkSkillEligibility(skill);
		if (!eligibility.eligible) {
			const reasonLines = eligibility.reasons.map((r) => {
				const suggestion = r.suggestion ? ` (${r.suggestion})` : "";
				return `- ${r.message}${suggestion}`;
			});
			const errorText =
				`Skill \`${skill.slug}\` is not eligible to run. Missing dependencies:\n` +
				reasonLines.join("\n");
			if (callback) await callback({ text: errorText });
			return { success: false, error: new Error(errorText) };
		}

		const requestedMode: UseSkillMode | undefined =
			opts.mode === "script" || opts.mode === "guidance" || opts.mode === "auto"
				? opts.mode
				: undefined;
		const hasScripts = skill.scripts.length > 0;
		const effectiveMode = pickMode(requestedMode, hasScripts);

		const activeStepId = getTrajectoryContext()?.trajectoryStepId;
		if (typeof activeStepId === "string" && activeStepId.trim() !== "") {
			await annotateActiveTrajectoryStep(runtime, {
				stepId: activeStepId,
				usedSkills: [skill.slug],
			});
		}

		if (effectiveMode === "script") {
			if (!hasScripts) {
				const errorText = `Skill \`${skill.slug}\` has no executable scripts; request mode='guidance' instead.`;
				if (callback) await callback({ text: errorText });
				return { success: false, error: new Error(errorText) };
			}

			const requestedScript =
				typeof opts.script === "string" && opts.script.trim()
					? opts.script.trim()
					: skill.scripts[0];
			const scriptPath = service.getScriptPath(skill.slug, requestedScript);
			if (!scriptPath) {
				const errorText =
					`Script \`${requestedScript}\` not found in skill \`${skill.slug}\`. ` +
					`Available scripts: ${skill.scripts.join(", ") || "(none)"}.`;
				if (callback) await callback({ text: errorText });
				return { success: false, error: new Error(errorText) };
			}

			runtime.logger.info(
				`[AgentSkills] USE_SKILL invoking ${skill.slug}/${requestedScript}`,
			);

			const env = service.getSkillExecutionEnv(skill.slug);
			const args = normaliseArgs(opts.args);
			const result = await executeScript(scriptPath, args, env);

			const text = result.success
				? `**${skill.name}** ran \`${requestedScript}\`:\n\`\`\`\n${result.stdout || "(no output)"}\n\`\`\``
				: `**${skill.name}** script \`${requestedScript}\` failed (exit ${result.exitCode}):\n\`\`\`\n${result.stderr || "(no stderr)"}\n\`\`\``;

			if (callback) await callback({ text });

			return {
				success: result.success,
				text,
				values: {
					activeSkill: skill.slug,
					skillName: skill.name,
					mode: "script",
				},
				data: {
					slug: skill.slug,
					mode: "script" as const,
					script: requestedScript,
					exitCode: result.exitCode,
					stdout: result.stdout,
					stderr: result.stderr,
				},
			};
		}

		// mode === "guidance"
		const instructions = service.getSkillInstructions(skill.slug);
		if (!instructions) {
			const errorText = `No instructions available for skill \`${skill.slug}\`.`;
			if (callback) await callback({ text: errorText });
			return { success: false, error: new Error(errorText) };
		}

		const maxLen = 3500;
		const truncatedBody =
			instructions.body.length > maxLen
				? `${instructions.body.substring(0, maxLen)}\n\n...[truncated]`
				: instructions.body;

		const text = `## ${skill.name}\n\n${skill.description}\n\n### Instructions\n\n${truncatedBody}`;

		if (callback) await callback({ text, actions: ["USE_SKILL"] });

		return {
			success: true,
			text,
			values: {
				activeSkill: skill.slug,
				skillName: skill.name,
				mode: "guidance",
			},
			data: {
				slug: skill.slug,
				mode: "guidance" as const,
				instructions: instructions.body,
				estimatedTokens: instructions.estimatedTokens,
			},
		};
	},

	examples: [
		[
			{
				name: "{{userName}}",
				content: { text: "Use the weather skill" },
			},
			{
				name: "{{agentName}}",
				content: {
					text: "Invoking weather skill...",
					actions: ["USE_SKILL"],
				},
			},
		],
		[
			{
				name: "{{userName}}",
				content: { text: "Run the pdf-skill rotate script on report.pdf" },
			},
			{
				name: "{{agentName}}",
				content: {
					text: "Running pdf-skill/rotate.py with report.pdf...",
					actions: ["USE_SKILL"],
				},
			},
		],
		[
			{
				name: "{{userName}}",
				content: { text: "Show me the github skill instructions" },
			},
			{
				name: "{{agentName}}",
				content: {
					text: "Loading github skill guidance...",
					actions: ["USE_SKILL"],
				},
			},
		],
	],
};

export default useSkillAction;
