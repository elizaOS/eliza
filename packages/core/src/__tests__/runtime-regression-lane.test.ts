/**
 * Composes the runtime-focused regression suites for changes to the monolithic
 * AgentRuntime module. The changed-file coverage gate runs only tests present in
 * a PR diff, so this lane keeps those changes attached to the existing behavioral
 * matrix until the runtime is fully decomposed into independently covered modules.
 */
import { describe, expect, it } from "vitest";
import "./compose-state-provider-hook.test";
import "./compose-state-refresh-providers.test";
import "./compose-state-role-gate.test";
import "./compose-state-trajectory-recording.test";
import "./dynamic-prompt-json-mode.test";
import "./message-runtime-stage1.test";
import "./outbound-sanitize-runtime-seams.test";
import "./runtime-component-precedence.test";
import "./runtime-register-provider.test";
import "./runtime-rerank-memories.test";
import "./runtime-settings.test";
import "./runtime-stop.test";
import "./streaming-runtime-hooks.test";
import "../runtime-get-all-memories.test";
import "../runtime-report-error.test";
import "../runtime/__tests__/embedding-dimension.test";
import "../runtime/__tests__/guarded-stream-use-model.test";
import "../runtime/__tests__/model-provider-failover.test";
import "../runtime/__tests__/model-registrations.test";
import "../runtime/__tests__/model-stream-chunk-hooks.test";
import "../runtime/__tests__/pii-swap-use-model.test";
import "../runtime/__tests__/secret-swap-use-model.test";
import "../runtime/__tests__/streaming-use-model.test";

describe("AgentRuntime regression lane", () => {
	it("loads the runtime behavioral matrix", () => {
		expect(true).toBe(true);
	});
});
