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

const removedPromptCapCloneTests = [
	"packages/core/src/features/advanced-capabilities/actions/role.surrogate.test.ts",
	"packages/core/src/features/advanced-capabilities/evaluators/trajectory-evaluator-utils.surrogate.test.ts",
	"packages/core/src/features/advanced-capabilities/experience/evaluators/experience-items.surrogate.test.ts",
	"packages/core/src/features/advanced-capabilities/providers/settings.surrogate.test.ts",
	"packages/core/src/features/advanced-memory/providers/context-summary.surrogate.test.ts",
	"packages/core/src/features/basic-capabilities/index.surrogate.test.ts",
	"packages/core/src/features/trust/providers/securityStatus.surrogate.test.ts",
	"packages/core/src/features/trust/should-respond-risk-gate.surrogate.test.ts",
	"packages/core/src/runtime-trajectory.surrogate.test.ts",
	"packages/core/src/runtime.retry.surrogate.test.ts",
	"packages/core/src/runtime/evaluator.surrogate.test.ts",
	"packages/core/src/runtime/planner-loop.surrogate.test.ts",
	"packages/core/src/services/trajectory-json.surrogate.test.ts",
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
	"packages/core/src/utils/reference-echo.ts": [
		/completeUserReferenceView[^{]*\{[^}]*truncateWellFormed/,
		/completeUserReferenceView[^{]*\{[^}]*\.slice\(/,
	],
	"packages/core/src/features/documents/naming.ts": [
		/truncateWellFormed/,
		/wellFormed\.length\s*[><=]/,
	],
	"packages/core/src/features/advanced-capabilities/actions/room.ts": [
		/(?:world|targetRoom|room)\.id\.(?:slice|substring)\(/,
		/String\((?:world\.id|targetRoom\.id|roomId)\)\.substring\(/,
	],
	"packages/core/src/features/advanced-capabilities/actions/message.ts": [
		/sorted\s*\.slice\(0,\s*8\)/,
		/room\.id\.slice\(0,\s*8\)/,
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
	"plugins/plugin-github/src/actions/issue-op.ts": [/body\.slice\(/],
	"plugins/plugin-github/src/actions/pr-op.ts": [/body\.slice\(/],
	"plugins/plugin-app-control/src/params.ts": [
		/collapsed\.slice\(/,
		/userReferenceLogView/,
	],
	"plugins/plugin-agent-skills/src/actions/parse-helpers.ts": [
		/truncateWellFormed/,
	],
	"plugins/plugin-agent-orchestrator/src/actions/tasks.ts": [
		/truncateWellFormed/,
		/seed\.slice\(/,
		/userReferenceLogView/,
	],
	"plugins/plugin-agent-orchestrator/src/actions/task-label.ts": [
		/truncateWellFormed/,
		/\.slice\(/,
	],
	"plugins/plugin-agent-orchestrator/src/actions/common.ts": [
		/id\.slice\(0,\s*8\)/,
		/shortId/,
	],
	"plugins/plugin-agent-orchestrator/src/services/model-gateway-lease.ts": [
		/truncateWellFormed/,
	],
	"plugins/plugin-agent-orchestrator/src/services/acp-service.ts": [
		/wellFormed\.length\s*>\s*500/,
		/truncateWellFormed\(wellFormed,\s*200\)/,
	],
	"packages/skills/src/formatter.ts": [/raw\.slice\(0,\s*1024\)/],
	"plugins/plugin-personal-assistant/src/actions/autofill.ts": [
		/truncateWellFormed/,
	],
	"plugins/plugin-personal-assistant/src/actions/lib/owner-policy-writes.ts": [
		/truncateWellFormed/,
	],
	"plugins/plugin-personal-assistant/src/activity-profile/proactive-planner.ts":
		[/truncateWellFormed/, /(?:channelCounts|highlights)\s*\.slice\(0,/],
	"plugins/plugin-personal-assistant/src/lifeops/background-planner.ts": [
		/truncateWellFormed/,
	],
	"plugins/plugin-personal-assistant/src/lifeops/checkin/checkin-service.ts": [
		/truncateWellFormed/,
	],
	"plugins/plugin-personal-assistant/src/lifeops/messaging/owner-send-policy.ts":
		[/truncateWellFormed/],
	"plugins/plugin-personal-assistant/src/lifeops/service-helpers-misc.ts": [
		/truncateWellFormed/,
	],
	"plugins/plugin-personal-assistant/src/lifeops/work-threads/store.ts": [
		/truncateWellFormed/,
		/compactText/,
	],
	"plugins/plugin-personal-assistant/src/lifeops/scheduled-task/dispatch-context.ts":
		[/truncateWellFormed/, /RECENT_CONVERSATION_LINE_LIMIT/],
	"plugins/plugin-personal-assistant/src/actions/creative-draft.ts": [
		/MAX_OWNER_(?:VOICE_SOURCES|SOURCE_CHARS)/,
		/text:\s*truncateWellFormed/,
		/\[\.\.\.byId\.values\(\)\]\.slice\(/,
	],
	"plugins/plugin-personal-assistant/src/actions/life.ts": [
		/(?:attendeeNames|events|atRisk|needsAttention|onTrack|occurrences|goals|selected)\s*\.slice\(0,/,
	],
	"plugins/plugin-personal-assistant/src/actions/brief.ts": [
		/limit:\s*25/,
		/\.slice\(0,\s*25\)/,
		/MAX_BRIEF_COMMITMENT_ITEMS/,
	],
	"plugins/plugin-personal-assistant/src/lifeops/creative-draft/index.ts": [
		/\.slice\(0,\s*6\)/,
	],
	"plugins/plugin-personal-assistant/src/actions/calendar.ts": [
		/matches\.slice\(0,\s*8\)/,
		/approvalSafeLabel[\s\S]{0,400}truncateWellFormed/,
	],
	"plugins/plugin-personal-assistant/src/actions/calendar-preview.ts": [
		/matches\.slice\(/,
	],
	"plugins/plugin-google-workspace/src/meet.ts": [
		/sentences\.slice\(/,
		/\.slice\(0,\s*6\)/,
		/rawSummary\.length\s*>/,
	],
	"plugins/plugin-google-workspace/src/gmail-message-connector.ts": [
		/SUBJECT_MAX_LENGTH/,
	],
	"plugins/plugin-google-workspace/src/lifeops-message-adapter.ts": [
		/truncateWellFormed/,
		/clip\(draft\.body/,
	],
	"plugins/plugin-discord/triage-adapter.ts": [
		/truncateWellFormed/,
		/SNIPPET_LENGTH/,
		/clip\((?:text|draft\.body)/,
	],
	"plugins/plugin-discord/slash-commands.ts": [
		/cleanedAnswer\.slice\(/,
		/text\.slice\(0,\s*120\)/,
	],
	"plugins/plugin-x/src/lifeops-message-adapter.ts": [
		/draft\.body\.(?:slice|substring)\(/,
	],
	"plugins/plugin-anthropic/models/image.ts": [/firstLine\.slice\(/],
	"plugins/plugin-local-inference/src/services/voice/voice-emotion-classifier.ts":
		[/WAV2SMALL_MAX_SAMPLES/, /truncated to the trailing window/],
	"plugins/plugin-sql/src/services/advanced-memory-storage.ts": [
		/entityId\.slice\(0,\s*8\)/,
	],
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
	"packages/agent/src/api/interactions-routes.ts": [
		/truncateWellFormed/,
		/MAX_CONTEXT_CHARS/,
	],
	"packages/agent/src/api/character-routes.ts": [
		/key:\s*["']system["'][\s\S]{0,220}maxLength/,
	],
	"packages/agent/src/api/server-helpers-swarm.ts": [
		/originalTask[^\n]*\.slice\(/,
		/firstLine\.slice\(/,
	],
	"packages/agent/src/services/sandbox-manager.ts": [
		/options\.command\.substring\(/,
		/options\.command\.slice\(/,
	],
	"packages/agent/src/shared/conversation-format.ts": [
		/room\.id\.slice\(/,
		/room\.id\.substring\(/,
	],
	"packages/agent/src/runtime/roles/src/provider.ts": [
		/id\.slice\(/,
		/id\.substring\(/,
	],
	"packages/agent/src/runtime/prompt-optimization.ts": [
		/actionCompactionEnabled/,
	],
	"packages/scenario-runner/src/executor.ts": [
		/serialized\.slice\(/,
		/stringifyForJudge\([^,\n]+,\s*\d/,
	],
	"packages/app-core/src/services/account-pool-broker.ts": [
		/trimmed\.slice\(0,\s*128\)/,
	],
	"plugins/plugin-computeruse/src/platform/browser.ts": [
		/html\.slice\(0,\s*5000\)/,
		/result\.length\s*>=\s*50/,
		/textContent\.trim\(\)\.slice\(/,
	],
	"packages/browser-bridge-extension/src/page-extract.ts": [
		/normalizeText\([^\n]+,\s*\d/,
		/currentLength\s*>=/,
		/\.slice\(0,\s*(?:10|12|20|40)\)/,
		/collectVisibleText\(\d/,
	],
	"plugins/plugin-personal-assistant/src/providers/activity-profile.ts": [
		/tasks\s*\.slice\(/,
		/limit:\s*25/,
		/apps\s*\.slice\(/,
	],
	"plugins/plugin-personal-assistant/src/providers/first-run.ts": [
		/ONE_LINE_MAX/,
		/\.slice\(\s*0,\s*ONE_LINE_MAX/,
	],
	"plugins/plugin-personal-assistant/src/lifeops/owner-profile.ts": [
		/trimmed\.slice\(/,
		/OWNER_NAME_MAX_LENGTH/,
	],
	"packages/shared/src/utils/owner-name.ts": [
		/truncateWellFormed/,
		/OWNER_NAME_MAX_LENGTH/,
	],
	"plugins/plugin-browser/src/providers/workspace.ts": [/MAX_TABS_IN_SUMMARY/],
	"plugins/plugin-browser/src/workspace/browser-workspace-desktop.ts": [
		/bodyText:\s*normalize\([^\n]+\)\.slice\(/,
	],
	"plugins/plugin-browser/src/actions/browser-autofill-login.ts": [
		/MAX_BROWSER_TAB_SCAN/,
		/tabs\s*\.slice\(0,/,
	],
	"plugins/plugin-browser/src/actions/manage-browser-bridge.ts": [
		/MAX_BROWSER_BRIDGE_TEXT_LENGTH/,
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
	"packages/agent/src/api/chat-augmentation.ts": [/CHAT_DOCUMENTS_LIMIT/],
	"packages/agent/src/api/chat-text-helpers.ts": [
		/input\.slice\(0,\s*100_000\)/,
	],
	"packages/ui/src/components/chat/message-parser-helpers.ts": [
		/MAX_DISPLAY_LEN/,
	],
	"packages/shared/src/utils/assistant-text.ts": [
		/input\.length\s*>\s*200_000/,
		/input\.slice\(0,\s*200_000\)/,
	],
	"packages/ui/src/voice/voice-chat-playback.ts": [/MAX_SPOKEN_CHARS/],
	"packages/ui/src/chat/model-choices.ts": [/MAX_MODEL_CHOICES/],
	"packages/ui/src/components/pages/documents-detail.tsx": [
		/previewText\.slice\(/,
	],
	"packages/ui/src/components/composites/chat/permission-card.helpers.ts": [
		/text\.slice\(0,\s*100_000\)/,
		/\{0,50000\}/,
	],
	"packages/ui/src/components/custom-actions/custom-action-form.ts": [
		/value\.slice\(0,\s*256\)/,
	],
	"plugins/plugin-cloud-apps/src/providers/cloud-apps.ts": [
		/MAX_APPS_RENDERED/,
	],
	"plugins/plugin-elizacloud/src/cloud-providers/model-registry.ts": [
		/MAX_MODEL_PROVIDERS/,
		/MAX_MODELS_PER_PROVIDER/,
	],
	"plugins/plugin-wifi/src/components/WifiAppView.tsx": [
		/VISIBLE_NETWORK_LIMIT/,
	],
	"plugins/plugin-wifi/src/providers/networks.ts": [/WIFI_NETWORKS_LIMIT/],
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

	it("does not restore test-only clones of deleted prompt caps", () => {
		for (const relativePath of removedPromptCapCloneTests) {
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
