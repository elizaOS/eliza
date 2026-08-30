/**
 * Live chat proof that an explicitly stored owner memory survives a full child-process
 * restart and remains recallable from a fresh conversation through the HTTP API.
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, it } from "vitest";
import { describeIf } from "../../../packages/app-core/test/helpers/conditional-tests.ts";
import { createConversation } from "../../../packages/app-core/test/helpers/http";
import {
  assertNoProviderIssue,
  LIVE_TESTS_ENABLED,
  postLiveConversationMessageWithRecovery,
  type StartedLifeOpsLiveRuntime,
  selectLifeOpsLiveProvider,
  startLifeOpsLiveRuntime,
} from "./helpers/lifeops-live-harness";

const selectedProvider = await selectLifeOpsLiveProvider();
const suiteEnabled = LIVE_TESTS_ENABLED && selectedProvider !== null;
let runtimeRoot: string | undefined;
let runtime: StartedLifeOpsLiveRuntime | undefined;

describeIf(suiteEnabled)("Live: chat memory across process restart", () => {
  afterAll(async () => {
    await runtime?.close();
    if (runtimeRoot) {
      await rm(runtimeRoot, { recursive: true, force: true });
    }
  });

  it("recalls an explicit memory after stopping and rebuilding the runtime", async () => {
    runtimeRoot = await mkdtemp(
      path.join(os.tmpdir(), "eliza-memory-chat-restart-"),
    );
    runtime = await startLifeOpsLiveRuntime({
      selectedProvider,
      runtimeRoot,
    });
    const before = await createConversation(runtime.port, {
      title: "Memory before restart",
    });
    const storePrompt =
      "Remember this exact durable phrase for after a restart: violet comet 4826.";
    const stored = await postLiveConversationMessageWithRecovery(
      runtime,
      before.conversationId,
      storePrompt,
      "store durable restart phrase",
    );
    assertNoProviderIssue("store durable restart phrase", stored, runtime);
    await runtime.close();
    runtime = undefined;

    runtime = await startLifeOpsLiveRuntime({
      selectedProvider,
      runtimeRoot,
    });
    const after = await createConversation(runtime.port, {
      title: "Memory after restart",
    });
    const recalled = await postLiveConversationMessageWithRecovery(
      runtime,
      after.conversationId,
      "What exact durable phrase did I ask you to remember before the restart? Search stored memory.",
      "recall durable restart phrase",
    );
    assertNoProviderIssue("recall durable restart phrase", recalled, runtime);
    expect(recalled.toLowerCase()).toContain("violet comet 4826");
  }, 600_000);
});
