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
	"packages/core/src/utils/slice-to-fit-budget.ts",
	"packages/core/src/utils/slice-to-fit-budget.test.ts",
	"packages/agent/src/actions/compact-conversation.ts",
	"packages/agent/src/runtime/compaction-handoff.ts",
	"packages/agent/src/runtime/conversation-compactor.ts",
	"packages/agent/src/runtime/prompt-compaction.ts",
	"packages/core/src/runtime/conversation-compaction-hook.ts",
	"packages/core/src/features/advanced-memory/providers/context-summary.ts",
	"packages/cloud/shared/src/lib/eliza/shared/providers/recent-messages.ts",
	"packages/training/scripts/transform_drop_oversized.py",
];

const removedPromptCapCloneTests = [
	"packages/agent/src/runtime/trajectory-internals.surrogate.test.ts",
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
	"packages/cloud/shared/src/lib/eliza/plugin-cloud-bootstrap/providers/character.surrogate.test.ts",
	"packages/cloud/shared/src/lib/eliza/plugin-cloud-bootstrap/providers/action-state.surrogate.test.ts",
	"plugins/plugin-personal-assistant/src/lifeops/cross-channel-search.surrogate.test.ts",
];

const computerUseTrajectoryBoundaryCalls: Record<string, readonly RegExp[]> = {
	"plugins/plugin-computeruse/src/mobile/android-trajectory.ts": [
		/assertComputerUseTrajectoryText\("errorMessage",\s*payload\.errorMessage\)/,
		/buildComputerUseAgentStepTrajectoryPayload\(event\)/,
	],
	"plugins/plugin-computeruse/src/actions/use-computer-agent.ts": [
		/assertComputerUseTrajectoryText\("goal",\s*goal\)/,
		/assertComputerUseTrajectoryText\([\s\S]{0,80}"rationale"/,
		/buildComputerUseAgentStepTrajectoryPayload\(\{/,
	],
};

const outputCompletenessBoundaryCalls: Record<string, readonly RegExp[]> = {
	"packages/cloud/api/agents/[id]/a2a/route.ts": [
		/assertModelOutputComplete\([\s\S]{0,160}result\.finishReason/,
	],
	"packages/cloud/api/agents/[id]/mcp/route.ts": [
		/assertModelOutputComplete\([\s\S]{0,160}result\.finishReason/,
	],
	"packages/cloud/api/v1/chat/route.ts": [
		/onFinish:\s*async\s*\(\{\s*text,\s*usage,\s*finishReason\s*\}\)/,
		/assertModelOutputComplete\(\{[\s\S]{0,100}finishReason/,
	],
	"packages/cloud/api/v1/generate-prompts/route.ts": [
		/onFinish:\s*\(\{\s*finishReason\s*\}\)/,
		/assertModelOutputComplete\(\{[\s\S]{0,100}finishReason/,
	],
	"packages/cloud/shared/src/lib/api/a2a/skills.ts": [
		/assertModelOutputComplete\([\s\S]{0,160}result\.finishReason/,
	],
	"packages/cloud/shared/src/lib/services/discord-automation/app-automation.ts":
		[/assertModelOutputComplete\([\s\S]{0,120}result\.finishReason/],
	"packages/cloud/shared/src/lib/services/telegram-automation/app-automation.ts":
		[/assertModelOutputComplete\([\s\S]{0,120}result\.finishReason/],
	"packages/cloud/shared/src/lib/services/app-promotion-assets.ts": [
		/assertModelOutputComplete\([\s\S]{0,120}result\.finishReason/,
	],
	"packages/cloud/shared/src/lib/services/app-promotion.ts": [
		/assertModelOutputComplete\([\s\S]{0,120}result\.finishReason/,
	],
	"packages/cloud/shared/src/lib/services/memory.ts": [
		/assertModelOutputComplete\([\s\S]{0,120}await result\.finishReason/,
	],
	"packages/cloud/shared/src/lib/services/provisioning-agent-chat.ts": [
		/assertModelOutputComplete\([\s\S]{0,120}result\.finishReason/,
	],
	"packages/cloud/shared/src/lib/services/seo.ts": [
		/assertModelOutputComplete\([\s\S]{0,120}result\.finishReason/,
	],
	"packages/cloud/shared/src/lib/services/twitter-automation/app-automation.ts":
		[/assertModelOutputComplete\([\s\S]{0,120}result\.finishReason/],
	"packages/cloud/shared/src/lib/services/shared-runtime/shared-eliza-runtime.ts":
		[/assertModelOutputComplete\([\s\S]{0,120}result\.finishReason/],
	"packages/cloud/shared/src/lib/services/eliza-app/describe-inbound-media.ts":
		[/isModelOutputLimitFinishReason\(completion\.finishReason\)/],
	"plugins/plugin-anthropic/models/image.ts": [
		/assertModelOutputComplete\([\s\S]{0,120}response\.finishReason/,
	],
};

const directModelDispatchPatterns = [
	/from\s+["']ai["']|import\(["']ai["']\)/,
	/from\s+["'][^"']*providers\/language-model["']|import\(["'][^"']*providers\/language-model["']\)/,
	/\bgenerateText\s*\(/,
	/\bstreamText\s*\(/,
] as const;

const nonDirectModelDispatchBoundaries: Record<
	string,
	{
		readonly requiredPatterns: readonly RegExp[];
	}
> = {
	"packages/cloud/shared/src/lib/services/eliza-app/connection-enforcement.ts":
		{
			requiredPatterns: [/code:\s*"CONNECTION_ENFORCEMENT_LLM_DISABLED"/],
		},
	"packages/cloud/shared/src/lib/services/room-title.ts": {
		requiredPatterns: [/const title = generateFallbackTitle\(text\)/],
	},
	"packages/cloud/shared/src/lib/services/shared-runtime/shared-runtime-chat.ts":
		{
			requiredPatterns: [
				/await runSharedAgentTurn\(\{/,
				/runSharedAgentTurnStream\(\{/,
			],
		},
};

const guardedSources: Record<string, readonly RegExp[]> = {
	"plugins/plugin-agent-skills/src/security/skill-scanner.ts": [
		/matchEvidence\s*=\s*source\.slice\(/,
	],
	"plugins/plugin-cloud-apps/src/client.ts": [
		/appReferenceLogView[\s\S]{0,500}\.slice\(/,
		/appReferenceLogView[\s\S]{0,500}truncateWellFormed/,
	],
	"plugins/plugin-personal-assistant/src/lifeops/service-helpers-reminder.ts": [
		/normalizeSemanticReason[\s\S]{0,500}\.slice\(/,
		/normalizeSemanticReason[\s\S]{0,500}truncateWellFormed/,
	],
	"packages/scenario-runner/src/final-checks/index.ts": [
		/actionCallSummary[\s\S]{0,900}\.slice\(/,
		/blob\.slice\(/,
	],
	"packages/scenario-runner/src/judge.ts": [/raw\.slice\(/, /const preview/],
	"packages/scenario-runner/src/reporter.ts": [
		/truncateText/,
		/toolInputPreview/,
		/toolOutputPreview/,
		/responsePreview/,
		/toolSearchTopResults/,
		/toolSearch\.results\.slice\(/,
		/\.slice\(0,\s*140\)/,
	],
	"packages/scenario-runner/src/runtime-factory.ts": [
		/ownerMessage\.slice\(/,
		/const clamped/,
	],
	"packages/scenario-runner/src/scenario-assertions/calendar-assertions.ts": [
		/blob\.slice\(/,
	],
	"packages/scenario-runner/src/scenario-assertions/effect-assertions.ts": [
		/JSON\.stringify\(a\.result\?\.data[^\n]*\.slice\(/,
	],
	"packages/agent/src/services/agent-export.ts": [
		/limit:\s*Number\.MAX_SAFE_INTEGER/,
		/getMemoriesByWorldId\(/,
	],
	"packages/core/src/features/working-memory/taskClipboardService.ts": [
		/TASK_CLIPBOARD_MAX_ITEMS/,
		/maxItems/,
	],
	"plugins/plugin-inbox/src/actions/inbox.ts": [/:\s*50;/],
	"plugins/plugin-inbox/src/inbox/repository.ts": [/opts\?\.limit\s*\?\?\s*50/],
	"plugins/plugin-inbox/src/inbox/aggregate.ts": [
		/DEFAULT_INBOX_LIMIT/,
		/Math\.min\(Math\.floor\(request\.limit\),\s*500\)/,
		/INBOX_CACHE_(?:WARM|READ|FULL)_LIMIT/,
	],
	"plugins/plugin-inbox/src/inbox/message-fetcher.ts": [
		/opts\.limit\s*\?\?\s*50/,
		/for\s*\(const msg of triageFeed\.messages\.slice/,
	],
	"plugins/plugin-inbox/src/inbox/unsubscribe-service.ts": [
		/DEFAULT_SCAN_MAX_MESSAGES/,
		/MAX_SENDERS_RETURNED/,
		/Math\.min\(\s*1000/,
	],
	"plugins/plugin-finances/src/services/subscriptions-service.ts": [
		/MAX_AUDIT_MESSAGES/,
	],
	"packages/cloud/api/v1/generate-prompts/route.ts": [/maxOutputTokens\s*:/],
	"packages/training/scripts/rl/tokenization_utils.py": [
		/masks\s*=\s*masks\[:/,
		/assume extra tokens are completion/,
		/Falling back to simple masking/,
		/Could not fix masks, returning original/,
	],
	"packages/agent/src/actions/context-signal-lexicon.ts": [
		/contextLimit/,
		/CONTEXT_LIMIT/,
	],
	"packages/agent/src/actions/context-signal.ts": [
		/contextLimit/,
		/_contextLimit/,
	],
	"packages/agent/src/actions/database.ts": [
		/params\.limit\s*\?\?/,
		/VECTOR_SEARCH_(?:DEFAULT|MAX)_LIMIT/,
		/Math\.min\([^\n]*params\.limit/,
	],
	"packages/agent/src/actions/logs.ts": [
		/params\.limit\s*\?\?/,
		/Math\.min\([^\n]*params\.limit/,
	],
	"packages/agent/src/api/chat-routes.ts": [
		/sanitizeActionResultValue\([^\n]*depth/,
		/Object\.entries\([^\n]+\.slice\(/,
		/actionResults[\s\S]{0,200}\.slice\(-\d+\)/,
		/truncateWellFormed\(wellFormed/,
		/\.slice\(-50\)/,
		/maxTokens:\s*260/,
	],
	"packages/agent/src/api/diagnostics-routes.ts": [/entries\.slice\(-\d+\)/],
	"packages/agent/src/api/remote-capability-routes.ts": [
		/appendTrustAuditRecord[\s\S]{0,700}\.slice\(-\d+\)/,
	],
	"packages/agent/src/api/server.ts": [
		/pushWithBatchEvict\(\s*state\.logBuffer/,
		/state\.logBuffer\.splice\(/,
	],
	"packages/agent/src/api/server-helpers-auth.ts": [/rawAuth\.slice\(/],
	"packages/agent/scripts/live-sandbox-smoke.ts": [
		/this\.stderr[^\n]*\.slice\(/,
	],
	"packages/agent/src/api/wallet-dex-prices.ts": [
		/addresses\.slice\(0,\s*\d+\)/,
	],
	"packages/agent/src/api/wallet-evm-balance.ts": [
		/nonZero\.slice\(0,\s*\d+\)/,
		/knownTokenAddresses[\s\S]{0,100}\.slice\(0,\s*\d+\)/,
		/truncateWellFormed\(/,
	],
	"packages/agent/src/services/sandbox-manager.ts": [
		/eventLog\s*=\s*this\.eventLog\.slice/,
		/eventLog\.splice\(/,
		/options\.command\.substring\(/,
		/options\.command\.slice\(/,
	],
	"packages/app-core/platforms/electrobun/src/voice/voice-service.ts": [
		/this\.recent\.splice\(/,
		/recentTurns:\s*this\.recent\.slice\(/,
		/params\.limit\s*\?\?\s*\d+/,
		/clampLimit\(params\.limit/,
	],
	"packages/app-core/platforms/electrobun/src/native/browser-workspace.ts": [
		/DEFAULT_EVENT_LOG_LIMIT/,
		/MAX_EVENT_QUERY_LIMIT/,
		/MAX_EVENT_PAYLOAD_DEPTH/,
		/MAX_EVENT_STRING_LENGTH/,
		/this\.events\.splice\(/,
		/value\.slice\(0,\s*50\)/,
	],
	"packages/app-core/platforms/electrobun/src/native/browser-bridge-broker-server.ts":
		[/stderr[^\n]*\.slice\(/],
	"packages/app-core/platforms/electrobun/src/native/permissions.ts": [
		/stderr\.trim\(\)\.slice\(/,
	],
	"packages/app-core/deploy/cloud-agent-shared.ts": [
		/MAX_DATABASE_DIAGNOSTIC_CHARS/,
	],
	"packages/app-core/platforms/electrobun/src/shell-sync-relay.ts": [
		/truncateWellFormed\(/,
	],
	"packages/app-core/platforms/electrobun/src/ssh-runtime-rpc.ts": [
		/MAX_DIAGNOSTIC_STDERR_CHARS/,
		/diagnosticStderrTail[^\n]*\.slice\(/,
	],
	"packages/app-core/platforms/electrobun/src/trace/trace-store.ts": [
		/DEFAULT_MAX_SESSIONS/,
		/DEFAULT_MAX_EVENTS_PER_SESSION/,
		/DEFAULT_MAX_EVENT_PAYLOAD_BYTES/,
		/tracePayloadTruncated/,
		/sessionEvents\.shift\(/,
		/pruneSessions\(/,
	],
	"plugins/plugin-personal-assistant/src/activity-profile/service.ts": [
		/MAX_ROOMS/,
		/MESSAGES_LIMIT/,
		/ACTIVITY_SIGNALS_WINDOW_LIMIT/,
		/CURRENT_ACTIVITY_SIGNAL_LIMIT/,
		/roomIds\.slice\(/,
	],
	"plugins/plugin-google-workspace/src/gmail.ts": [
		/params\.limit\s*\?\?\s*10/,
		/normalizedLimit\(params\.maxResults,\s*20/,
		/normalizedLimit\(params\.maxMessages,\s*200/,
		/MAX_GMAIL_RESULTS/,
	],
	"plugins/plugin-google-workspace/src/lifeops-message-adapter.ts": [
		/maxResults:\s*opts\.limit\s*\?\?\s*50/,
		/maxResults:\s*filters\.limit\s*\?\?\s*25/,
		/listMessages\(runtime,\s*\{\s*limit:\s*100\s*\}\)/,
		/truncateWellFormed/,
		/clip\(draft\.body/,
		/GMAIL_READ_(?:DEFAULT|MAX)_(?:BYTES|UNITS)/,
		/GMAIL_READ_UNIT_TOO_LARGE/,
	],
	"plugins/plugin-google-workspace/src/people.ts": [
		/normalizedPageSize\(params\.maxResults,\s*MAX_SEARCH_PAGE_SIZE\)/,
		/return\s+results\.slice\(0,\s*pageSize\)/,
	],
	"plugins/plugin-personal-assistant/src/lifeops/domains/gmail-service.ts": [
		/DEFAULT_GMAIL_(?:TRIAGE_MAX_RESULTS|SEARCH_LIMIT)/,
		/Math\.min\(\s*100/,
		/maxResults\(request\.maxResults/,
	],
	"plugins/plugin-personal-assistant/src/lifeops/repository.ts": [
		/options\?\.maxResults[\s\S]{0,160}:\s*100/,
		/DEFAULT_LIMIT\s*=\s*100/,
	],
	"plugins/plugin-personal-assistant/src/actions/connector.ts": [
		/params\.recentLimit\s*\?\?\s*10/,
	],
	"plugins/plugin-personal-assistant/src/lifeops/domains/imessage-service.ts": [
		/opts\.limit\s*\?\?\s*100/,
	],
	"plugins/plugin-personal-assistant/src/lifeops/domains/telegram-service.ts": [
		/request\.recentLimit\s*\?\?\s*10/,
	],
	"plugins/plugin-personal-assistant/src/lifeops/domains/whatsapp-service.ts": [
		/pullWhatsAppRecent\(limit\s*=\s*25/,
		/Math\.min\(Math\.max\(1,\s*Math\.floor\(limit\)\),\s*500\)/,
	],
	"plugins/plugin-personal-assistant/src/lifeops/domains/reminders-service.ts":
		[
			/getMemoriesByRoomIds\(\{[\s\S]{0,160}limit:\s*50/,
			/collectNearbyReminderTitles\(\{[\s\S]{0,240}limit:\s*3/,
			/titles\.length\s*>=\s*args\.limit/,
		],
	"plugins/plugin-personal-assistant/src/lifeops/service.ts": [
		/pullWhatsAppRecent\(limit\s*=\s*25/,
	],
	"plugins/plugin-personal-assistant/src/lifeops/cross-channel-search.ts": [
		/DEFAULT_PER_CHANNEL_LIMIT/,
		/query\.limit\s*\?\?/,
		/hits\.slice\(0/,
		/finalLimit/,
		/pullWhatsAppRecent\([^)]*\+\s*25/,
	],
	"packages/core/src/database/inMemoryAdapter.ts": [
		/params\.count\s*\?\?\s*params\.limit\s*\?\?\s*10/,
		/const limit = params\.limit \?\? 100;[\s\S]{0,200}connectorAccountsById/,
	],
	"packages/core/src/connectors/account-manager.ts": [
		/listConnectorAccounts\(\{[\s\S]{0,120}limit:\s*500/,
	],
	"plugins/plugin-sql/src/stores/connectorAccount.store.ts": [
		/const limit = params\.limit \?\? 100/,
	],
	"plugins/plugin-inmemorydb/adapter.ts": [
		/params\.count\s*\?\?\s*params\.limit\s*\?\?\s*10/,
	],
	"plugins/plugin-sql/src/base.ts": [
		/const count = params\.count\s*\?\?\s*10/,
		/\.limit\(params\.limit\s*\?\?\s*Number\.MAX_SAFE_INTEGER\)/,
	],
	"plugins/plugin-sql/src/stores/memory.store.ts": [
		/\.limit\(params\.count\s*\?\?\s*10\)/,
	],
	"plugins/plugin-web-search/src/services/webSearchService.ts": [
		/maxResults:\s*options\?\.limit\s*\?\?\s*3/,
	],
	"packages/app-core/platforms/android/app/src/main/java/ai/elizaos/app/ElizaVoicePlugin.java":
		[
			/getInt\("maxTokens",\s*48\)/,
			/maxTokens\s*!=\s*null\s*\?\s*maxTokens\s*:\s*48/,
		],
	"packages/cloud/shared/src/lib/utils/ai-json-parse.ts": [
		/truncateWellFormed/,
		/toWellFormedUnicode\(extracted\),\s*200/,
	],
	"plugins/plugin-personal-assistant/src/lifeops/domains/x-read-service.ts": [
		/opts\.limit\s*\?\?\s*20/,
	],
	"plugins/plugin-personal-assistant/src/lifeops/domains/x-service.ts": [
		/opts\.limit\s*\?\?\s*25/,
	],
	"plugins/plugin-imessage/src/service.ts": [
		/normalizeConnectorLimit\([^)]*fallback/,
		/Math\.min\(Math\.floor\(limit\),\s*200\)/,
		/Math\.max\(limit,\s*100\)/,
		/getMessages\(\{\s*chatId,\s*limit:\s*10\s*\}\)/,
	],
	"plugins/plugin-imessage/src/chatdb-reader.ts": [
		/options\.limit[\s\S]{0,160}:\s*50/,
	],
	"plugins/plugin-whatsapp/src/runtime-service.ts": [
		/Math\.min\(Number\(params\.limit\),\s*100\)/,
		/:\s*25;/,
		/Math\.max\(params\.limit\s*\?\?\s*100,\s*100\)/,
		/\.slice\(0,\s*params\.limit\s*\?\?\s*25\)/,
	],
	"plugins/plugin-telegram/src/service.ts": [
		/normalizeConnectorLimit\([^)]*fallback/,
		/Math\.min\(Math\.floor\(limit\),\s*200\)/,
		/Math\.max\(limit,\s*100\)/,
		/count:\s*10/,
	],
	"plugins/plugin-google-workspace/src/chat/service.ts": [
		/normalizeConnectorLimit\([^)]*fallback/,
		/Math\.min\(Math\.floor\(limit\),\s*200\)/,
		/Math\.max\(limit,\s*100\)/,
	],
	"plugins/plugin-instagram/src/service.ts": [
		/normalizeConnectorLimit\([^)]*fallback/,
		/Math\.min\(Math\.floor\(limit\),\s*200\)/,
		/Math\.max\(limit,\s*100\)/,
	],
	"plugins/plugin-matrix/src/service.ts": [
		/normalizeConnectorLimit\([^)]*fallback/,
		/Math\.min\(Math\.floor\(limit\),\s*200\)/,
		/Math\.max\(limit,\s*100\)/,
	],
	"plugins/plugin-wechat/src/index.ts": [
		/normalizeConnectorLimit\([^)]*fallback/,
		/Math\.min\(Math\.floor\(limit\),\s*200\)/,
		/Math\.max\(limit,\s*100\)/,
	],
	"plugins/plugin-discord/service.ts": [
		/Math\.max\(params\.limit\s*\?\?\s*100,\s*100\)/,
		/\.slice\(0,\s*params\.limit\s*\?\?\s*25\)/,
		/Math\.min\(Number\(params\.limit\),\s*100\)/,
	],
	"plugins/plugin-discord/triage-adapter.ts": [
		/DEFAULT_LIST_LIMIT/,
		/MAX_CHANNELS_PER_SWEEP/,
		/PER_CHANNEL_FETCH_CAP/,
		/truncateWellFormed/,
		/SNIPPET_LENGTH/,
		/clip\((?:text|draft\.body)/,
	],
	"plugins/plugin-slack/src/service.ts": [
		/normalizeConnectorLimit\(params\.limit,\s*25\)/,
		/Math\.max\(requestedLimit,\s*100\)/,
		/readHistory\(channelId,\s*\{\s*limit:\s*10\s*\}/,
		/conversations\.replies\(\{[\s\S]{0,120}limit:\s*10/,
	],
	"plugins/plugin-x/src/services/x.service.ts": [
		/clampLimit\(params\.limit,\s*20,\s*100\)/,
		/clampLimit\(params\.limit,\s*25,\s*50\)/,
		/listRecentDirectMessages\(accountId,\s*25\)/,
	],
	"plugins/plugin-x/src/services/PostService.ts": [
		/options\.limit\s*\|\|\s*20/,
		/options\?\.limit\s*\|\|\s*20/,
	],
	"plugins/plugin-x/src/client/client.ts": [
		/maxTweets\s*=\s*200/,
		/maxQuotes:\s*number\s*=\s*(?:40|100)/,
		/if\s*\(tweets\.length\s*>=\s*(?:count|maxTweets)\)\s*break/,
	],
	"plugins/plugin-x/src/client/tweets.ts": [
		/while\s*\(totalFetched\s*<\s*maxTweets\)/,
	],
	"plugins/plugin-x/src/utils.ts": [
		/Falling back to truncated Tweet/,
		/truncateToCompleteSentence/,
	],
	"packages/logger/src/logger.ts": [
		/MAX_PROMPT_LOG_CHARS/,
		/\[TRUNCATED[^\]]*more chars\]/,
	],
	"packages/core/src/action-docs.ts": [
		/import\s*\{\s*compressPromptDescription/,
		/source\.descriptionCompressed\s*\?\?/,
	],
	"packages/core/src/actions/resolve-action-args.ts": [
		/RECENT_CONTEXT_LIMIT/,
		/spec\.descriptionCompressed/,
	],
	"packages/core/src/actions/to-tool.ts": [
		/action\.descriptionCompressed\s*\?\?/,
		/action\.compressedDescription/,
	],
	"packages/core/src/runtime/sub-planner.ts": [
		/action\.descriptionCompressed\s*\?\?/,
		/action\.compressedDescription/,
	],
	"packages/core/src/features/advanced-memory/evaluators/memory-items.ts": [
		/summaryEvaluator/,
		/Extract up to \d+/,
		/rolling summar/i,
	],
	"packages/core/src/features/advanced-memory/types.ts": [
		/SessionSummary/,
		/shortTermSummarization/,
		/summaryMaxTokens/,
	],
	"packages/core/src/types/memory-storage.ts": [/SessionSummary/],
	"packages/core/src/features/advanced-memory/services/memory-service.ts": [
		/shouldSummarize/,
		/SessionSummary/,
		/MEMORY_SUMMARIZATION/,
		/MEMORY_RETAIN_RECENT/,
	],
	"packages/core/src/features/advanced-memory/index.ts": [
		/contextSummaryProvider/,
		/summaryEvaluator/,
	],
	"packages/prompts/src/index.ts": [
		/INITIAL_SUMMARIZATION_TEMPLATE/,
		/UPDATE_SUMMARIZATION_TEMPLATE/,
		/Keep (?:the )?answer under \d+ words/i,
		/max \d+ chars/i,
		/<=\d+ (?:action|parent|visible)/i,
	],
	"packages/core/src/entities.ts": [/getMemories\([\s\S]{0,240}limit:\s*20/],
	"packages/core/src/utils/json-llm.ts": [/text\.slice\(0,\s*100_000\)/],
	"packages/core/src/utils/message-text.ts": [/MAX_MESSAGE_TEXT_LENGTH/],
	"packages/cloud/shared/src/db/schemas/conversations.ts": [
		/maxTokens:\s*2000/,
	],
	"packages/cloud/shared/src/lib/services/provisioning-agent-chat.ts": [
		/capped at 20/,
		/\.slice\([^)]*20/,
	],
	"packages/cloud/shared/src/lib/services/eliza-app/connection-enforcement.ts":
		[/NUDGE_MAX_OUTPUT_TOKENS/, /maxOutputTokens:/],
	"packages/cloud/shared/src/lib/services/discord-automation/app-automation.ts":
		[/maxOutputTokens:\s*\d+/],
	"packages/cloud/shared/src/lib/services/telegram-automation/app-automation.ts":
		[/maxOutputTokens:\s*\d+/],
	"packages/cloud/shared/src/lib/services/doordash-browser-run.ts": [
		/\.slice\(0,\s*20\)/,
		/\.slice\(0,\s*100\)/,
		/Math\.min\(20,\s*Number\(args\.limit/,
		/text\.slice\([^)]*,\s*240\)/,
	],
	"packages/cloud/shared/src/lib/services/agent-backup-verifier.ts": [
		/mismatches\.slice\(/,
		/summary\.failures\.slice\(/,
	],
	"packages/cloud/shared/src/lib/services/docker-sandbox-provider.ts": [
		/diagnostics\.slice\(/,
		/args[^\n]*join\([^\n]*\.slice\(/,
	],
	"packages/cloud/shared/src/lib/storage/object-store.ts": [
		/clampInlineDiagnosticText/,
		/oversizeInline/,
		/truncateToBytes/,
	],
	"packages/cloud/shared/src/lib/services/job-error-text.ts": [
		/JOB_ERROR_MAX_CHARS/,
		/TRUNCATION_SUFFIX/,
		/MAX_CAUSE_DEPTH/,
	],
	"packages/cloud/shared/src/lib/eliza/runtime/initializer.ts": [
		/msg\.substring\(/,
	],
	"packages/cloud/shared/src/lib/services/local-docker-sandbox-provider.ts": [
		/stdout\.slice\(/,
	],
	"packages/cloud/shared/src/lib/services/payment-request-settlement.ts": [
		/result\.error\.slice\(/,
	],
	"packages/cloud/shared/src/lib/services/tailnet-path-monitor.ts": [
		/timedOutContainers[^\n]*\.slice\(/,
	],
	"packages/cloud/shared/src/lib/steward-sync.ts": [
		/error\.stack[^\n]*\.slice\(/,
	],
	"packages/cloud/shared/src/db/repositories/agent-backup-restore-operations.ts":
		[/params\.error\.slice\(/],
	"packages/cloud/shared/src/lib/services/room-title.ts": [
		/result\.text[\s\S]{0,240}\.slice\(/,
		/result\.text[\s\S]{0,240}\.split\("\\n"\)/,
	],
	"packages/cloud/shared/src/lib/services/twitter-automation/app-automation.ts":
		[/text\.trim\(\)\.slice\(0,\s*280\)/],
	"packages/cloud/shared/src/lib/services/shared-runtime/shared-runtime-chat.ts":
		[/maxOutputTokens:\s*512/],
	"packages/cloud/shared/src/lib/services/shared-runtime/shared-turn-trace-recorder.ts":
		[/MAX_ACTION_STAGES/, /actionResults[^\n]*\.slice\(/],
	"packages/cloud/shared/src/lib/services/shared-runtime/shared-facts.ts": [
		/SHARED_FACTS_MAX_PER_TURN/,
	],
	"packages/cloud/shared/src/lib/services/shared-runtime/shared-runtime-timing.ts":
		[
			/MAX_SHARED_PROVIDER_TIMING_RECORDED_CALLS/,
			/MAX_SHARED_PROVIDER_TIMING_CALL_COUNT/,
			/modelCalls\.length\s*</,
			/contextIds[\s\S]{0,240}\.slice\(/,
		],
	"packages/core/src/runtime/evaluator.ts": [
		/MAX_EVALUATOR_INPUT_CHARS/,
		/chars truncated/,
		/DEFAULT_EVALUATOR_MAX_TOKENS/,
		/maxTokens\s*:/,
		/retryMaxTokens/,
		/contentProjection/,
	],
	"packages/core/src/runtime.ts": [
		/if\s*\(finalBudget\.shouldReject\)/,
		/code:\s*"MODEL_INPUT_OVER_BUDGET"/,
	],
	"packages/core/src/runtime/model-input-budget.ts": [
		/shouldReject:\s*estimatedInputTokens\s*[><=]/,
	],
	"packages/core/src/integrations/managed-provider/pagination.ts": [
		/DEFAULT_MAX_ITEMS/,
		/options\.maxItems\s*\?\?/,
	],
	"packages/core/src/runtime/message-handler.ts": [
		/normalizeStringHints/,
		/candidateActionNames[\s\S]{0,100}\b12\b/,
		/intents[\s\S]{0,100}\b8\b/,
	],
	"packages/core/src/security/pii-context-pack.ts": [
		/DEFAULT_MAX_FRAGMENTS/,
		/fragments\.slice\(/,
		/resolved\.slice\(/,
		/toWellFormedUnicode\(contextPack\)/,
		/options\.limit\s*\?\?/,
		/count:\s*options\.limit/,
	],
	"packages/core/src/features/documents/service.ts": [
		/limit:\s*(?:20|40|1_000)[,\n]/,
		/options\.limit[\s\S]{0,160}:\s*25/,
		/Math\.min\(Math\.floor\(options\.limit\),\s*DOCUMENT_LIST_MAX_LIMIT\)/,
	],
	"packages/core/src/features/documents/actions.ts": [
		/DOCUMENT_READ_DEFAULT_LIMIT/,
		/value\s*>\s*100/,
		/Document read limit exceeds 100/,
	],
	"packages/core/src/features/documents/llm.ts": [
		/MAX_OUTPUT_TOKENS/,
		/maxOutputTokens\s*:/,
	],
	"packages/core/src/features/documents/types.ts": [/MAX_OUTPUT_TOKENS/],
	"packages/core/src/features/documents/config.ts": [/MAX_OUTPUT_TOKENS/],
	"packages/core/src/features/documents/provider.ts": [
		/PINNED_DOCUMENT_(?:TOKEN_BUDGET|TRUNCATION_MARKER)/,
		/truncateWellFormed/,
		/composeProviderDocuments\([^)]*limit:/,
	],
	"packages/cloud/shared/src/lib/eliza/plugin-web-search/src/services/keyless-search.ts":
		[/MCP_MAX_ANSWER_CHARS/, /(?:parallel|exa)\.slice\(/],
	"packages/cloud/shared/src/lib/eliza/plugin-mcp/actions/dynamic-tool-actions.surrogate.test.ts":
		[/MCP_TOOL_OUTPUT_MAX_CHARS/, /truncateMcpToolOutput/],
	"packages/core/src/runtime/planner-loop.ts": [
		/maybeCompactPlannerTrajectory/,
		/CONTEXT_COMPACTION/,
		/projectStepForFinalSynthesis/,
		/DEFAULT_(?:CODING_)?PLANNER_MAX_TOKENS/,
		/maxTokens:\s*\d+/,
		/ELIZA_PROMPT_COMPRESS/,
		/contentProjection/,
		/maxToolResultChars/,
	],
	"packages/core/src/runtime/action-retrieval.ts": [
		/ELIZA_PROMPT_COMPRESS/,
		/COMPRESS_MODE_TOP_K_CAP/,
		/results\.slice\(0,\s*limit\)/,
	],
	"packages/core/src/runtime/planner-rendering.ts": [
		/truncateToolResultText/,
		/maxToolResultChars/,
		/contentProjection/,
		/projectToolDiagnosticValue/,
		/projectToolDiagnosticArgs/,
	],
	"packages/core/src/runtime/content-projection-policy.ts": [
		/parseBooleanValue/,
		/enabled:\s*args\.enabled/,
		/pagesOmitted:\s*args\.stats\.pagesOmitted/,
	],
	"packages/core/src/services/optimized-prompt-resolver.ts": [
		/ELIZA_PROMPT_COMPRESS/,
	],
	"packages/core/src/services/message/bot-noise-triage.ts": [
		/MAX_HISTORY_MESSAGES/,
		/count:\s*\d+/,
	],
	"packages/core/src/services/message/direct-action-heuristics.ts": [
		/CONTINUATION_LOOKBACK_ENTRIES/,
		/value\.slice\(0,\s*10_000\)/,
	],
	"packages/core/src/services/message.ts": [
		/slice\(0,\s*400\)[\s\S]{0,120}task_complete/,
		/CODING_DIRECT_ACTIONS/,
		/ELIZA_DISABLE_ACTION_RESULT_PROJECTION/,
	],
	"packages/core/src/services/evaluator.ts": [
		/ELIZA_DISABLE_ACTION_RESULT_PROJECTION/,
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
		/formatCandidates[\s\S]{0,300}\.slice\(0,/,
		/MEMORY_READ_(?:DEFAULT|MAX)_BYTES/,
	],
	"packages/core/src/features/working-memory/readAttachmentAction.ts": [
		/ATTACHMENT_READ_(?:TOTAL_PAGE|MAX_ITEM)_BYTES/,
		/fairLimit/,
		/maximum page size/,
	],
	"packages/cloud/shared/src/lib/eliza/plugin-oauth/actions/oauth.ts": [
		/active\.slice\(0,/,
	],
	"packages/core/src/features/advanced-capabilities/actions/post.ts": [
		/truncateWellFormed/,
		/text\s*=\s*text\.slice\(/,
	],
	"packages/core/src/features/autonomy/action.ts": [
		/targetRoomId\.slice\(0,\s*8\)/,
		/targetRoomId\.(?:slice|substring)\(/,
	],
	"packages/prompts/specs/actions/core.json": [/"c0a8012e"/],
	"packages/core/src/generated/action-docs.ts": [/"c0a8012e"/],
	"packages/core/src/runtime/trajectory-recorder.ts": [
		/resolveTrajectoryFieldCapBytes/,
		/applyTrajectoryFieldCap/,
		/capBytes\?:/,
	],
	"packages/agent/src/providers/media-provider.ts": [
		/max_tokens:\s*options\.maxTokens\s*\?\?\s*1024/,
		/this\.maxTokens\s*=\s*config\.maxTokens\s*\?\?\s*1024/,
		/num_predict:\s*this\.maxTokens/,
	],
	"packages/core/src/runtime/action-tiering.ts": [
		/tierAParents\.splice\(/,
		/tierBParents\.splice\(/,
		/children[^\n]*\.slice\(0,/,
	],
	"plugins/plugin-coding-tools/src/actions/summaries.ts": [
		/compactSummaryText/,
		/truncateWellFormed/,
	],
	"plugins/plugin-coding-tools/src/shell/services/shellService.ts": [
		/maxHistoryPerConversation/,
		/history\.shift\(\)/,
	],
	"plugins/plugin-computeruse/src/mobile/android-trajectory.ts": [
		/MAX_ERROR_MSG/,
		/errorMessage\s*=\s*[^;]*\.slice\(/,
	],
	"plugins/plugin-computeruse/src/trajectory-text.ts": [
		/\.slice\(/,
		/\.substring\(/,
		/toWellFormedUnicode/,
		/truncateWellFormed/,
		/max(?:Chars|Tokens|Items)/i,
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
	"plugins/plugin-app-control/src/actions/app-create.ts": [
		/tokenize\(intent\)\.slice\(/,
		/displayLine\.replace\([^\n]+\.slice\(/,
	],
	"plugins/plugin-app-control/src/actions/views-create.ts": [
		/tokenize\(intent\)\.slice\(/,
		/displayLine\.replace\([^\n]+\.slice\(/,
	],
	"plugins/plugin-workflow/src/services/smithers-runtime.ts": [
		/MAX_STDERR_CHARS/,
		/\$\{stderr\}\$\{chunk\}`\.slice/,
		/\$\{stdoutNoise\}\$\{line\}\\n`\.slice/,
	],
	"packages/training/scripts/eval/eliza1_eval_suite.py": [/toks\s*=\s*toks\[:/],
	"plugins/plugin-agent-skills/src/actions/parse-helpers.ts": [
		/truncateWellFormed/,
	],
	"plugins/plugin-agent-skills/src/providers/skills.ts": [
		/scoredSkills\.slice\(1,\s*\d+\)/,
	],
	"plugins/plugin-calendar/src/actions/calendar-handler.ts": [
		/collectRecentConversationTexts\(\{[\s\S]{0,240}limit:/,
	],
	"plugins/plugin-health/src/actions/health.ts": [
		/recentConversationTexts\(\{[\s\S]{0,240}limit:/,
	],
	"plugins/plugin-health/src/actions/screen-time.ts": [
		/apps[\s\S]{0,80}\.slice\(0,/,
		/topN:\s*10/,
	],
	"plugins/plugin-personal-assistant/src/actions/app-block.ts": [
		/collectRecentConversationTexts\(\{[\s\S]{0,240}limit:/,
	],
	"plugins/plugin-personal-assistant/src/actions/book-travel.ts": [
		/collectRecentConversationTexts\(\{[\s\S]{0,240}limit:/,
	],
	"plugins/plugin-personal-assistant/src/actions/entity.ts": [
		/collectRecentConversationTexts\(\{[\s\S]{0,240}limit:/,
		/listRelationships\(\{\s*limit:/,
	],
	"plugins/plugin-personal-assistant/src/actions/lib/scheduling-handler.ts": [
		/collectRecentConversationTexts\(\{[\s\S]{0,240}limit:/,
		/listActiveNegotiations\(\{\s*limit:/,
	],
	"plugins/plugin-personal-assistant/src/actions/schedule.ts": [
		/sleepEpisodes\.slice\(/,
	],
	"plugins/plugin-personal-assistant/src/actions/subscriptions.ts": [
		/recentConversationTexts\(\{[\s\S]{0,240}limit:/,
	],
	"plugins/plugin-personal-assistant/src/actions/voice-call.ts": [
		/listRelationships\(\{\s*limit:/,
	],
	"plugins/plugin-contacts/src/providers/contacts.ts": [
		/CONTACTS_PROVIDER_LIMIT/,
		/listContacts\(\{\s*limit:/,
	],
	"plugins/plugin-phone/src/providers/call-log.ts": [
		/CALL_LOG_LIMIT/,
		/listRecentCalls\(\{\s*limit:/,
	],
	"plugins/plugin-native-contacts/android/src/main/java/ai/eliza/plugins/contacts/ContactsPlugin.kt":
		[/getInt\("limit"\)\s*\?:\s*\d+/, /limit\s*>\s*\d+/],
	"plugins/plugin-native-phone/android/src/main/java/ai/eliza/plugins/phone/PhonePlugin.kt":
		[/getInt\("limit"\)\s*\?:\s*\d+/, /limit\s*>\s*\d+/],
	"plugins/plugin-relationships/src/providers/entity-graph.ts": [
		/MAX_ENTITIES/,
		/MAX_EDGES/,
		/list\(\{[^}]*limit:/,
	],
	"plugins/plugin-blocker/src/providers/app-blocker.ts": [
		/blockedPackageNames\.slice\(/,
	],
	"plugins/plugin-personal-assistant/src/providers/recent-task-states.ts": [
		/TASK_LOG_MAX_ENTRIES/,
		/existing\.slice\(/,
	],
	"plugins/plugin-wallet/src/chains/solana/providers/wallet.ts": [
		/MAX_PORTFOLIO_ITEMS/,
		/nonZeroItems\.slice\(/,
		/displayedItems/,
	],
	"plugins/plugin-wallet/src/lp/actions/liquidity.ts": [
		/pools\.slice\(/,
		/Showing \d+ of/,
	],
	"plugins/plugin-wallet/src/analytics/news/services/newsDataService.ts": [
		/options\?\.limit\s*\|\|\s*\d+/,
	],
	"plugins/plugin-wallet/src/analytics/news/providers/defiNewsProvider.ts": [
		/getLatestNews\(\{\s*limit:/,
	],
	"plugins/plugin-agent-orchestrator/src/actions/tasks.ts": [
		/truncateWellFormed/,
		/seed\.slice\(/,
		/userReferenceLogView/,
		/excludedByFilters[\s\S]{0,300}\.slice\(/,
	],
	"plugins/plugin-cloud-apps/src/actions/check-app-domain.ts": [
		/MAX_DOMAINS_PER_CHECK/,
		/domains\.slice\(/,
		/I checked the first/,
	],
	"plugins/plugin-calendar/src/actions/calendar-sources.ts": [
		/normalized \|\| fallback\)\.slice\(/,
		/replaceControlCharacters\(value\)\.slice\(/,
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
	"plugins/plugin-agent-orchestrator/src/services/skill-recommender.ts": [
		/recommendations\.slice\(/,
		/\.slice\(0,\s*max\)/,
		/description\.replace\(\/\\s\+\/g/,
	],
	"plugins/plugin-agent-orchestrator/src/services/trajectory-feedback.ts": [
		/ordered\.slice\(/,
		/\.catch\(\(\)\s*=>\s*null\)/,
		/insights\.push\(match\[1\]\.trim\(\)\)/,
		/\{20,200\}/,
	],
	"plugins/plugin-agent-orchestrator/src/services/acp-service.ts": [
		/wellFormed\.length\s*>\s*500/,
		/truncateWellFormed\(wellFormed,\s*200\)/,
		/STDERR_CAP_BYTES/,
		/capStderr\(/,
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
	"plugins/plugin-discord/slash-commands.ts": [
		/cleanedAnswer\.slice\(/,
		/text\.slice\(0,\s*120\)/,
	],
	"plugins/plugin-x/src/lifeops-message-adapter.ts": [
		/draft\.body\.(?:slice|substring)\(/,
	],
	"plugins/plugin-x/src/discovery.ts": [
		/\bmaxTokens\s*:/,
		/(?:replyText|quoteText|response)\.(?:slice|substring)\(/,
	],
	"plugins/plugin-anthropic/models/image.ts": [
		/firstLine\.slice\(/,
		/maxOutputTokens:\s*\d/,
	],
	"plugins/plugin-local-inference/src/services/voice/voice-emotion-classifier.ts":
		[/WAV2SMALL_MAX_SAMPLES/, /truncated to the trailing window/],
	"plugins/plugin-local-inference/src/services/ffi-streaming-backend.ts": [
		/maxTokens:\s*args\.maxTokens\s*\?\?\s*2048/,
	],
	"plugins/plugin-native-inference/src/aosp-local-inference-bootstrap.ts": [
		/maxTokens:\s*args\.maxTokens\s*\?\?\s*512/,
	],
	"plugins/plugin-native-llama/src/capacitor-llama-adapter.ts": [
		/Math\.min\(Math\.floor\(requested\),\s*MOBILE_MAX_TOKENS_CAP\)/,
	],
	"plugins/plugin-sql/src/services/advanced-memory-storage.ts": [
		/entityId\.slice\(0,\s*8\)/,
		/session_summary/,
		/opts\?\.limit\s*\?\?\s*20/,
	],
	"plugins/plugin-elizacloud/src/cloud/managed-payment-clients.ts": [
		/text\.slice\(/,
	],
	"plugins/plugin-elizacloud/src/cloud/bridge-client.ts": [
		/(?:text|errorText)\.slice\(/,
	],
	"plugins/plugin-elizacloud/src/models/text.ts": [
		/max_tokens\s*=\s*params\.maxTokens\s*\?\?/,
		/max_output_tokens\s*=\s*params\.maxTokens\s*\?\?/,
		/(?:max_tokens|max_output_tokens)\s*[:=]\s*8192/,
	],
	"plugins/plugin-elizacloud/src/models/image.ts": [
		/IMAGE_DESCRIPTION_MAX_TOKENS[^\n]*["']8192["']/,
		/max_tokens\s*:\s*maxTokens/,
	],
	"packages/core/src/runtime/limits.ts": [
		/compactionEnabled/,
		/compactionKeepSteps/,
	],
	"packages/core/src/features/advanced-capabilities/providers/facts.ts": [
		/EVIDENCE_TEXT_CHAR_CAP/,
	],
	"packages/agent/src/api/fallback-action-helpers.ts": [/maxTokens:\s*260/],
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
		/requestedOutputTokens\s*\?\?\s*metadata\.maxTokens/,
		/Math\.min\([\s\S]{0,120}configuredOutputTokens/,
	],
	"packages/agent/src/runtime/trajectory-internals.ts": [
		/maxTokens:\s*512/,
		/truncateField/,
		/truncateRecord/,
		/\[\^\\n\]\{1,1024\}/,
		/\[\^"\]\{1,1024\}/,
		/\[\^"\]\{20,200\}/,
		/insights\.push\([^)]*\.trim\(\)\)/,
		/(?:return|const\s+safeResponse\s*=)[^;\n]*toWellFormedUnicode\((?:response|script|value)\)/,
	],
	"packages/scenario-runner/src/executor.ts": [
		/serialized\.slice\(/,
		/stringifyForJudge\([^,\n]+,\s*\d/,
		/plannerBlob\.slice\(/,
		/plannerPreview/,
	],
	"packages/app-core/src/services/account-pool-broker.ts": [
		/trimmed\.slice\(0,\s*128\)/,
	],
	"packages/app-core/test/helpers/trajectory-harness.ts": [
		/truncateText/,
		/safeStringify/,
		/formatMarkdownPayload/,
		/v\.text\.slice\(/,
		/state\.text\.slice\(/,
	],
	"plugins/plugin-computeruse/src/platform/browser.ts": [
		/html\.slice\(0,\s*5000\)/,
		/result\.length\s*>=\s*50/,
		/textContent\.trim\(\)\.slice\(/,
	],
	"plugins/plugin-computeruse/src/actor/brain.ts": [
		/BRAIN_MAX_ROIS/,
		/Cap ROIs to/,
		/roi\s*=\s*[^;]*\.slice\(0,/,
	],
	"plugins/plugin-computeruse/src/actor/cascade.ts": [
		/BRAIN_MAX_ROIS/,
		/brainOut\.roi\.slice\(0,/,
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
	"plugins/plugin-browser/src/workspace/browser-workspace-web.ts": [
		/buildBrowserWorkspaceDocumentSnapshotText\([^)]*\)\.slice\(/,
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
	"plugins/plugin-documents/src/components/documents/documents-detail.tsx": [
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

	it("does not silently overwrite source-audit rules with duplicate keys", () => {
		const source = readFileSync(fileURLToPath(import.meta.url), "utf8");
		const declarationStart = source.indexOf("const guardedSources");
		const declarationEnd = source.indexOf("\n};", declarationStart);
		const declaration = source.slice(declarationStart, declarationEnd);
		const paths = [...declaration.matchAll(/^\s*"([^"]+)":\s*\[/gmu)].map(
			(match) => match[1],
		);
		const seen = new Set<string>();
		const duplicates = paths.filter((path) => {
			if (seen.has(path)) return true;
			seen.add(path);
			return false;
		});
		expect(duplicates).toEqual([]);
	});

	it("keeps both computer-use emitters behind the shared rejection boundary", () => {
		for (const [relativePath, requiredPatterns] of Object.entries(
			computerUseTrajectoryBoundaryCalls,
		)) {
			const source = readFileSync(
				resolve(repositoryRoot, relativePath),
				"utf8",
			);
			for (const pattern of requiredPatterns) {
				expect(source, `${relativePath} must match ${pattern}`).toMatch(
					pattern,
				);
			}
		}
	});

	it("keeps direct AI SDK outputs behind completeness checks", () => {
		for (const [relativePath, requiredPatterns] of Object.entries(
			outputCompletenessBoundaryCalls,
		)) {
			const source = readFileSync(
				resolve(repositoryRoot, relativePath),
				"utf8",
			);
			for (const pattern of requiredPatterns) {
				expect(source, `${relativePath} must match ${pattern}`).toMatch(
					pattern,
				);
			}
		}
	});

	it("keeps disabled, deterministic, and delegated paths free of direct model dispatches", () => {
		for (const [relativePath, policy] of Object.entries(
			nonDirectModelDispatchBoundaries,
		)) {
			const source = readFileSync(
				resolve(repositoryRoot, relativePath),
				"utf8",
			);
			for (const pattern of policy.requiredPatterns) {
				expect(source, `${relativePath} must match ${pattern}`).toMatch(
					pattern,
				);
			}
			for (const pattern of directModelDispatchPatterns) {
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

	it("keeps X discovery drafts on the provider-maximum output contract", () => {
		const source = readFileSync(
			resolve(repositoryRoot, "plugins/plugin-x/src/discovery.ts"),
			"utf8",
		);
		expect(source.match(/omitMaxTokens:\s*true/g)).toHaveLength(2);
		expect(source).toMatch(/X_DISCOVERY_DRAFT_PROVIDER_TRUNCATED/);
	});
});
