/**
 * Repository guard for the lossless model-context policy.
 *
 * This deterministic source audit protects the highest-risk prompt assembly
 * boundaries and the deliberately removed conversation-compaction modules.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../../../..",
);

const removedCompactionModules = [
	"packages/agent/src/actions/compact-conversation.ts",
	"packages/agent/src/runtime/compaction-handoff.ts",
	"packages/agent/src/runtime/conversation-compactor.ts",
	"packages/agent/src/runtime/prompt-compaction.ts",
	"packages/core/src/runtime/conversation-compaction-hook.ts",
	"packages/training/scripts/transform_drop_oversized.py",
];

const guardedSources: Record<string, readonly RegExp[]> = {
	"packages/core/src/utils/json-llm.ts": [/text\.slice\(0,\s*100_000\)/],
	"packages/core/src/utils/message-text.ts": [/MAX_MESSAGE_TEXT_LENGTH/],
	"packages/core/src/runtime/evaluator.ts": [
		/MAX_EVALUATOR_INPUT_CHARS/,
		/chars truncated/,
	],
	"packages/core/src/runtime/planner-loop.ts": [
		/maybeCompactPlannerTrajectory/,
		/CONTEXT_COMPACTION/,
		/projectStepForFinalSynthesis/,
	],
	"packages/core/src/services/message/bot-noise-triage.ts": [
		/MAX_HISTORY_MESSAGES/,
		/count:\s*\d+/,
	],
	"packages/core/src/services/message/direct-action-heuristics.ts": [
		/CONTINUATION_LOOKBACK_ENTRIES/,
		/value\.slice\(0,\s*10_000\)/,
	],
	"packages/core/src/services/relationships.ts": [
		/MAX_INTERACTION_HISTORY/,
		/trimmedInteractions/,
	],
	"packages/core/src/features/basic-capabilities/actions/choice.ts": [
		/task\.id\.(?:slice|substring)\(/,
		/shortId/,
		/Short or full ID/,
	],
	"packages/core/src/runtime/trajectory-recorder.ts": [
		/resolveTrajectoryFieldCapBytes/,
		/applyTrajectoryFieldCap/,
		/capBytes\?:/,
	],
	"plugins/plugin-coding-tools/src/actions/summaries.ts": [
		/compactSummaryText/,
		/truncateWellFormed/,
	],
	"plugins/plugin-coding-tools/src/shell/services/shellService.ts": [
		/maxHistoryPerConversation/,
		/history\.shift\(\)/,
	],
	"plugins/plugin-cli-inference/src/prompt-flatten.ts": [
		/MAX_TOOL_PAYLOAD_(?:DEPTH|NODES|CHARS)/,
		/TOOL_PAYLOAD_.*MARKER/,
		/payload budget/i,
	],
	"plugins/plugin-dropbox/src/client.ts": [/bodyText\.slice\(/],
	"plugins/plugin-dropbox/src/connector-account-provider.ts": [/body\.slice\(/],
	"plugins/plugin-elizacloud/src/cloud/managed-payment-clients.ts": [
		/text\.slice\(/,
	],
	"plugins/plugin-elizacloud/src/cloud/bridge-client.ts": [
		/(?:text|errorText)\.slice\(/,
	],
	"packages/core/src/runtime/limits.ts": [
		/compactionEnabled/,
		/compactionKeepSteps/,
	],
	"packages/core/src/features/advanced-capabilities/providers/facts.ts": [
		/EVIDENCE_TEXT_CHAR_CAP/,
	],
	"packages/agent/src/api/chat-routes.ts": [/\.slice\(-50\)/],
	"packages/agent/src/api/server-helpers-swarm.ts": [
		/originalTask[^\n]*\.slice\(/,
		/firstLine\.slice\(/,
	],
	"packages/agent/src/services/sandbox-manager.ts": [
		/options\.command\.substring\(/,
		/options\.command\.slice\(/,
	],
	"packages/agent/src/runtime/prompt-optimization.ts": [
		/actionCompactionEnabled/,
	],
	"plugins/plugin-browser/src/providers/workspace.ts": [/MAX_TABS_IN_SUMMARY/],
	"plugins/plugin-browser/src/workspace/browser-workspace-desktop.ts": [
		/bodyText:\s*normalize\([^\n]+\)\.slice\(/,
	],
	"plugins/plugin-vision/src/provider.ts": [/tileAnalysis\.text\.substring\(/],
	"packages/cloud/shared/src/lib/services/browser-tools.ts": [
		/innerText\?\.slice\(/,
	],
	"packages/cloud/shared/src/lib/services/shared-runtime/shared-recall.ts": [
		/ROW_CONTENT_CLIP_CHARS/,
		/SHARED_RECALL_DEFAULT_MAX_CHARS/,
	],
	"packages/cloud/shared/src/lib/services/shared-runtime/shared-runtime-history-policy.ts":
		[
			/truncateUtf8/,
			/MAX_PUBLIC_WEB_GROUNDING_(?:QUERY|RESULT|ENCODED)_BYTES/,
			/MAX_HISTORY_MESSAGES/,
		],
	"plugins/plugin-agent-orchestrator/src/services/completion-residuals.ts": [
		/MAX_RESIDUAL_PATHS/,
	],
	"plugins/plugin-agent-orchestrator/src/services/wave-supervisor.ts": [
		/repos\)\]\.slice\(/,
		/pulls\.slice\(/,
	],
	"plugins/plugin-app-manager/src/services/app-manager.ts": [/MAX_RUN_EVENTS/],
	"packages/cloud/services/gateway-discord/src/gateway-manager.ts": [
		/response\.slice\(0,\s*2000\)/,
		/replyText\.slice\(0,\s*2000\)/,
	],
	"packages/training/scripts/synthesize_native_fillins.py": [
		/def compact_value/,
		/json_dump\([^\n]+max_chars/,
		/<truncated>/,
	],
	"packages/training/scripts/rl/multi_prompt_dataset.py": [
		/system_prompt\s*=\s*system_prompt\[/,
	],
	"packages/training/scripts/transform_remove_system_tropes.py": [
		/system_truncate/,
		/_SYSTEM_MAX_CHARS/,
	],
	"packages/training/scripts/lib/groq_thoughts.py": [
		/def truncate/,
		/max_input_chars/,
	],
};

function collectPythonSources(directory: string): string[] {
	const sources: string[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const absolute = resolve(directory, entry.name);
		if (entry.isDirectory()) {
			sources.push(...collectPythonSources(absolute));
		} else if (entry.isFile() && entry.name.endsWith(".py")) {
			sources.push(absolute);
		}
	}
	return sources;
}

describe("prompt integrity policy", () => {
	it("does not restore automatic conversation compaction", () => {
		for (const relativePath of removedCompactionModules) {
			expect(
				existsSync(resolve(repositoryRoot, relativePath)),
				relativePath,
			).toBe(false);
		}
	});

	it("keeps reviewed model-facing boundaries free of known silent caps", () => {
		for (const [relativePath, forbiddenPatterns] of Object.entries(
			guardedSources,
		)) {
			const source = readFileSync(
				resolve(repositoryRoot, relativePath),
				"utf8",
			);
			for (const pattern of forbiddenPatterns) {
				expect(source, `${relativePath} must not match ${pattern}`).not.toMatch(
					pattern,
				);
			}
		}
	});

	it("does not ask training tokenizers to truncate complete inputs", () => {
		const trainingScripts = resolve(
			repositoryRoot,
			"packages/training/scripts",
		);
		for (const sourcePath of collectPythonSources(trainingScripts)) {
			const source = readFileSync(sourcePath, "utf8");
			expect(source, sourcePath).not.toMatch(/truncation\s*=\s*True/);
		}
	});
});
