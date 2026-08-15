/**
 * Live Cerebras proof for the owner-todo cadence boundary. The test boots the
 * real LifeOps runtime, drives both requests through chat, records their model
 * trajectories, and verifies neither preview mutates definition state. The
 * deterministic handler suite owns preview-confirm persistence coverage.
 */

import { afterAll, beforeAll, expect, it } from "vitest";
import { describeIf } from "../../../packages/app-core/test/helpers/conditional-tests.ts";
import {
  createConversation,
  req,
} from "../../../packages/app-core/test/helpers/http.ts";
import {
  assertNoProviderIssue,
  LIVE_CHAT_TEST_TIMEOUT_MS,
  LIVE_RUNTIME_BOOT_TIMEOUT_MS,
  LIVE_TESTS_ENABLED,
  postLiveConversationMessage,
  type StartedLifeOpsLiveRuntime,
  selectLifeOpsLiveProvider,
  startLifeOpsLiveRuntime,
} from "./helpers/lifeops-live-harness.ts";

const selectedProvider = await selectLifeOpsLiveProvider();
const suiteEnabled =
  LIVE_TESTS_ENABLED && selectedProvider?.name === "cerebras";

describeIf(suiteEnabled)("Live: undated owner-todo boundary", () => {
  let runtime: StartedLifeOpsLiveRuntime;

  beforeAll(async () => {
    if (!selectedProvider)
      throw new Error("Cerebras provider was not selected");
    runtime = await startLifeOpsLiveRuntime({ selectedProvider });
  }, LIVE_RUNTIME_BOOT_TIMEOUT_MS + 30_000);

  afterAll(async () => {
    await runtime?.close();
  });

  it(
    "previews an undated todo but refuses an undated reminder",
    async () => {
      const { conversationId } = await createConversation(runtime.port, {
        title: "Undated owner todo proof",
      });
      const todoRequest =
        "Create a personal todo titled Buy oat milk. It has no due date or reminder. Preview it first and do not save until I confirm.";
      const todoPreview = await postLiveConversationMessage(
        runtime,
        conversationId,
        todoRequest,
        "undated todo preview",
      );
      assertNoProviderIssue("undated todo preview", todoPreview, runtime);

      const beforeConfirm = await req(
        runtime.port,
        "GET",
        "/api/lifeops/definitions",
      );
      expect(beforeConfirm.status).toBe(200);
      expect(todoPreview).toMatch(/oat milk|todo/i);

      const reminderRequest =
        "Remind me to call Mom, but I have not said when.";
      const reminderResponse = await postLiveConversationMessage(
        runtime,
        conversationId,
        reminderRequest,
        "unscheduled reminder",
      );
      assertNoProviderIssue("unscheduled reminder", reminderResponse, runtime);
      if (!/when|what time|date|day|schedule/i.test(reminderResponse)) {
        throw new Error(
          `unscheduled reminder did not ask for timing: ${reminderResponse}\n${runtime.getLogTail()}`,
        );
      }

      const afterReminder = await req(
        runtime.port,
        "GET",
        "/api/lifeops/definitions",
      );
      expect(afterReminder.status).toBe(200);
      const definitions = Array.isArray(afterReminder.data.definitions)
        ? afterReminder.data.definitions
        : [];
      expect(definitions).toEqual(beforeConfirm.data.definitions);

      console.log(
        JSON.stringify(
          {
            model: "gpt-oss-120b",
            provider: runtime.providerName,
            input: [todoRequest, reminderRequest],
            output: {
              todoPreview,
              reminderResponse,
              definitionsBefore: beforeConfirm.data.definitions,
              definitionsAfter: definitions,
            },
          },
          null,
          2,
        ),
      );
    },
    LIVE_CHAT_TEST_TIMEOUT_MS,
  );
});
