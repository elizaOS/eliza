import { afterEach, beforeEach, expect, it } from "vitest";
import { describeIf } from "../../../test/helpers/conditional-tests.ts";
import { createConversation, req } from "../../../test/helpers/http";
import {
  assertNoProviderIssue,
  getLifeOpsLiveSetupWarnings,
  LIVE_CHAT_TEST_TIMEOUT_MS,
  LIVE_RUNTIME_BOOT_TIMEOUT_MS,
  LIVE_TESTS_ENABLED,
  type LifeOpsGoalEntry,
  postLiveConversationMessage,
  type StartedLifeOpsLiveRuntime,
  selectLifeOpsLiveProvider,
  startLifeOpsLiveRuntime,
  waitForDefinitionByTitle,
  waitForJsonPredicate,
  waitForTrajectoryCall,
} from "./helpers/lifeops-live-harness.ts";
import { judgeTextWithLlm } from "./helpers/lifeops-live-judge.ts";

const selectedLiveProvider = await selectLifeOpsLiveProvider();
const SUPPORTED_PROVIDER_NAMES = new Set([
  "openai",
  "openrouter",
  "google",
  "anthropic",
]);
const LIVE_CHAT_SUITE_ENABLED =
  LIVE_TESTS_ENABLED &&
  selectedLiveProvider !== null &&
  SUPPORTED_PROVIDER_NAMES.has(selectedLiveProvider.name);

const liveSetupWarnings = [
  ...getLifeOpsLiveSetupWarnings(selectedLiveProvider),
  selectedLiveProvider &&
  !SUPPORTED_PROVIDER_NAMES.has(selectedLiveProvider.name)
    ? `selected provider "${selectedLiveProvider.name}" does not support this suite; use OpenAI, OpenRouter, Google, or Anthropic`
    : null,
].filter((entry): entry is string => Boolean(entry));

if (liveSetupWarnings.length > 0) {
  console.info(
    `[lifeops-live] chat suite skipped until setup is complete: ${liveSetupWarnings.join(" | ")}`,
  );
}

type StartedRuntime = StartedLifeOpsLiveRuntime;

async function waitForNewGoal(
  port: number,
  existingGoalIds: Set<string>,
): Promise<LifeOpsGoalEntry> {
  const response = await waitForJsonPredicate<{
    goals?: LifeOpsGoalEntry[];
  }>(
    `http://127.0.0.1:${port}/api/lifeops/goals`,
    (value) =>
      Array.isArray(value.goals) &&
      value.goals.some((entry) => {
        const goalId = entry.goal?.id;
        return typeof goalId === "string" && !existingGoalIds.has(goalId);
      }),
  );

  const match = response.goals?.find((entry) => {
    const goalId = entry.goal?.id;
    return typeof goalId === "string" && !existingGoalIds.has(goalId);
  });
  if (!match) {
    throw new Error("Timed out waiting for a new goal");
  }
  return match;
}

async function expectJudgePasses(args: {
  label: string;
  minimumScore?: number;
  rubric: string;
  runtime: StartedRuntime;
  text: string;
  transcript?: string;
}): Promise<void> {
  if (!selectedLiveProvider) {
    throw new Error("No live provider configured for response judging");
  }

  const result = await judgeTextWithLlm({
    provider: selectedLiveProvider,
    rubric: args.rubric,
    text: args.text,
    minimumScore: args.minimumScore,
    label: args.label,
    transcript: args.transcript,
  });

  expect(
    result.passed,
    `${args.label} failed judge\nscore=${result.score}\nreason=${result.reasoning}\nresponse=${args.text}\n${args.runtime.getLogTail()}`,
  ).toBe(true);
}

function normalizePlannerResponseText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function expectPlannerResponseToContainAll(
  plannerResponse: string,
  fragments: string[],
): void {
  const normalized = normalizePlannerResponseText(plannerResponse);
  for (const fragment of fragments) {
    expect(normalized).toContain(fragment.toLowerCase());
  }
}

function expectPlannerResponseToContainAny(
  plannerResponse: string,
  fragments: string[],
): void {
  const normalized = normalizePlannerResponseText(plannerResponse);
  expect(
    fragments.some((fragment) => normalized.includes(fragment.toLowerCase())),
  ).toBe(true);
}

function requireStartedRuntime(
  runtime: StartedRuntime | undefined,
): StartedRuntime {
  if (!runtime) {
    throw new Error("Live runtime was not started.");
  }
  return runtime;
}

describeIf(LIVE_CHAT_SUITE_ENABLED)(
  "Live: LifeOps seeded brush-teeth chat roundtrip (strict single-attempt)",
  () => {
    let runtime: StartedRuntime | undefined;

    // Each test mutates live LifeOps state. Boot a fresh runtime per test so
    // definitions/goals from earlier cases cannot create false failures.
    beforeEach(async () => {
      runtime = await startLifeOpsLiveRuntime({
        selectedProvider: selectedLiveProvider,
      });
    }, LIVE_RUNTIME_BOOT_TIMEOUT_MS + 30_000);

    afterEach(async () => {
      if (runtime) {
        await runtime.close();
        runtime = undefined;
      }
    });

    it(
      "creates the seeded brush-teeth routine through chat and records a real trajectory",
      async () => {
        const liveRuntime = requireStartedRuntime(runtime);
        const { conversationId } = await createConversation(liveRuntime.port, {
          title: "Live LifeOps",
        });

        const requestText =
          "Help me brush my teeth in the morning and at night.";
        const previewText = await postLiveConversationMessage(
          liveRuntime,
          conversationId,
          requestText,
          "brush-teeth preview",
        );
        assertNoProviderIssue("brush-teeth preview", previewText, liveRuntime);
        expect(previewText.trim().length).toBeGreaterThan(0);

        const definitionsBeforeConfirm = await req(
          liveRuntime.port,
          "GET",
          "/api/lifeops/definitions",
        );
        expect(definitionsBeforeConfirm.status).toBe(200);
        expect(
          Array.isArray(definitionsBeforeConfirm.data.definitions) &&
            definitionsBeforeConfirm.data.definitions.some(
              (entry: { definition?: { title?: string } }) =>
                entry.definition?.title === "Brush teeth",
            ),
        ).toBe(false);

        const confirmText = "Yes, save that brushing routine.";
        const savedText = await postLiveConversationMessage(
          liveRuntime,
          conversationId,
          confirmText,
          "brush-teeth confirm",
        );
        assertNoProviderIssue("brush-teeth confirm", savedText, liveRuntime);
        expect(savedText).toMatch(/brush teeth/i);

        const previewTrajectory = await waitForTrajectoryCall(
          liveRuntime.port,
          requestText,
        );
        expect(previewTrajectory.trajectoryId.length).toBeGreaterThan(0);
        expect(
          String(previewTrajectory.llmCall.response ?? "").length,
        ).toBeGreaterThan(0);
        const confirmTrajectory = await waitForTrajectoryCall(
          liveRuntime.port,
          confirmText,
        );
        expect(confirmTrajectory.trajectoryId.length).toBeGreaterThan(0);
        expect(
          String(confirmTrajectory.llmCall.response ?? "").length,
        ).toBeGreaterThan(0);

        const brushTeeth = await waitForDefinitionByTitle(
          liveRuntime.port,
          "Brush teeth",
          (entry) =>
            (entry.definition?.cadence as { kind?: string } | undefined)
              ?.kind === "times_per_day",
        );
        expect(brushTeeth).toBeDefined();
        expect(brushTeeth.definition?.cadence).toMatchObject({
          kind: "times_per_day",
          slots: expect.arrayContaining([
            expect.objectContaining({ minuteOfDay: 8 * 60, label: "Morning" }),
            expect.objectContaining({ minuteOfDay: 21 * 60, label: "Night" }),
          ]),
        });
        expect(brushTeeth.reminderPlan?.id ?? null).not.toBeNull();
      },
      LIVE_CHAT_TEST_TIMEOUT_MS,
    );

    it(
      "starts with smalltalk and eases into a real brush-teeth setup over multiple turns",
      async () => {
        const liveRuntime = requireStartedRuntime(runtime);
        const { conversationId } = await createConversation(liveRuntime.port, {
          title: "Live LifeOps Multi-Turn Brush Teeth",
        });

        const smalltalkResponse = await postLiveConversationMessage(
          liveRuntime,
          conversationId,
          "hey, mornings have been a little chaotic lately.",
          "smalltalk warmup",
        );
        assertNoProviderIssue(
          "smalltalk warmup",
          smalltalkResponse,
          liveRuntime,
        );
        expect(smalltalkResponse.trim().length).toBeGreaterThan(0);

        const contextResponse = await postLiveConversationMessage(
          liveRuntime,
          conversationId,
          "the main thing i keep forgetting is brushing my teeth before i start working.",
          "smalltalk context",
        );
        assertNoProviderIssue(
          "smalltalk context",
          contextResponse,
          liveRuntime,
        );
        expect(contextResponse.trim().length).toBeGreaterThan(0);

        const createPrompt =
          "Please make that into a routine named Brush teeth with reminders around 8am and 9pm. Just preview the plan for now and do not save it yet.";
        const createResponse = await postLiveConversationMessage(
          liveRuntime,
          conversationId,
          createPrompt,
          "multi-turn brush-teeth creation",
        );
        assertNoProviderIssue(
          "multi-turn brush-teeth creation",
          createResponse,
          liveRuntime,
        );
        expect(createResponse.trim().length).toBeGreaterThan(0);

        const definitionsBeforeConfirm = await req(
          liveRuntime.port,
          "GET",
          "/api/lifeops/definitions",
        );
        expect(definitionsBeforeConfirm.status).toBe(200);
        expect(
          Array.isArray(definitionsBeforeConfirm.data.definitions) &&
            definitionsBeforeConfirm.data.definitions.some(
              (entry: { definition?: { title?: string } }) =>
                entry.definition?.title === "Brush teeth",
            ),
        ).toBe(false);

        const confirmText = "That looks right. Save the Brush teeth routine.";
        const savedText = await postLiveConversationMessage(
          liveRuntime,
          conversationId,
          confirmText,
          "multi-turn brush-teeth confirm",
        );
        assertNoProviderIssue(
          "multi-turn brush-teeth confirm",
          savedText,
          liveRuntime,
        );
        expect(savedText).toMatch(/brush teeth/i);

        const brushTeeth = await waitForDefinitionByTitle(
          liveRuntime.port,
          "Brush teeth",
          (entry) =>
            (entry.definition?.cadence as { kind?: string } | undefined)
              ?.kind === "times_per_day",
        );
        expect(brushTeeth.definition?.cadence).toMatchObject({
          kind: "times_per_day",
          slots: expect.arrayContaining([
            expect.objectContaining({ minuteOfDay: 8 * 60, label: "Morning" }),
            expect.objectContaining({ minuteOfDay: 21 * 60, label: "Night" }),
          ]),
        });
        expect(brushTeeth.reminderPlan?.id ?? null).not.toBeNull();

        const preferencePrompt =
          "Now turn the Brush teeth reminder intensity down to minimal.";
        const preferenceResponse = await postLiveConversationMessage(
          liveRuntime,
          conversationId,
          preferencePrompt,
          "multi-turn reminder preference",
        );
        assertNoProviderIssue(
          "multi-turn reminder preference",
          preferenceResponse,
          liveRuntime,
        );

        const refreshedBrushTeeth = await waitForDefinitionByTitle(
          liveRuntime.port,
          "Brush teeth",
        );
        const definitionId = String(refreshedBrushTeeth.definition?.id ?? "");
        expect(definitionId.length).toBeGreaterThan(0);

        const preference = await req(
          liveRuntime.port,
          "GET",
          `/api/lifeops/reminder-preferences?definitionId=${encodeURIComponent(definitionId)}`,
        );
        expect(preference.status).toBe(200);
        expect(
          (preference.data.effective as Record<string, unknown>).intensity,
        ).toBe("minimal");
      },
      LIVE_CHAT_TEST_TIMEOUT_MS,
    );

    it(
      "creates a blocker-aware workout habit through chat and stores earned-access policy",
      async () => {
        const liveRuntime = requireStartedRuntime(runtime);
        const { conversationId } = await createConversation(liveRuntime.port, {
          title: "Live LifeOps Workout",
        });

        const requestText =
          "Set up a workout habit every afternoon. Block X, Instagram, and Hacker News until I finish it, then unlock them for 60 minutes.";
        const previewText = await postLiveConversationMessage(
          liveRuntime,
          conversationId,
          requestText,
          "workout preview",
        );
        assertNoProviderIssue("workout preview", previewText, liveRuntime);
        expect(previewText.trim().length).toBeGreaterThan(0);

        const workoutDefinitionsBeforeConfirm = await req(
          liveRuntime.port,
          "GET",
          "/api/lifeops/definitions",
        );
        expect(workoutDefinitionsBeforeConfirm.status).toBe(200);
        expect(
          Array.isArray(workoutDefinitionsBeforeConfirm.data.definitions) &&
            workoutDefinitionsBeforeConfirm.data.definitions.some(
              (entry: { definition?: { title?: string } }) =>
                entry.definition?.title === "Workout",
            ),
        ).toBe(false);

        const confirmText = "Yes, save the workout habit.";
        const savedText = await postLiveConversationMessage(
          liveRuntime,
          conversationId,
          confirmText,
          "workout confirm",
        );
        assertNoProviderIssue("workout confirm", savedText, liveRuntime);
        expect(savedText).toMatch(/workout/i);

        const previewTrajectory = await waitForTrajectoryCall(
          liveRuntime.port,
          requestText,
        );
        expect(previewTrajectory.trajectoryId.length).toBeGreaterThan(0);
        expect(
          String(previewTrajectory.llmCall.response ?? "").length,
        ).toBeGreaterThan(0);
        const confirmTrajectory = await waitForTrajectoryCall(
          liveRuntime.port,
          confirmText,
        );
        expect(confirmTrajectory.trajectoryId.length).toBeGreaterThan(0);
        expect(
          String(confirmTrajectory.llmCall.response ?? "").length,
        ).toBeGreaterThan(0);

        const workout = await waitForDefinitionByTitle(
          liveRuntime.port,
          "Workout",
          (entry) =>
            (
              entry.definition?.websiteAccess as
                | { unlockMode?: string }
                | undefined
            )?.unlockMode === "fixed_duration",
        );
        expect(workout.definition?.cadence).toMatchObject({
          kind: "daily",
          windows: expect.arrayContaining(["afternoon"]),
        });
        expect(workout.definition?.websiteAccess).toMatchObject({
          unlockMode: "fixed_duration",
          unlockDurationMinutes: 60,
          websites: expect.arrayContaining([
            "x.com",
            "twitter.com",
            "instagram.com",
            "news.ycombinator.com",
          ]),
        });
        expect(workout.reminderPlan?.id ?? null).not.toBeNull();
      },
      LIVE_CHAT_TEST_TIMEOUT_MS,
    );

    it(
      "creates a health-adjacent goal through chat",
      async () => {
        const liveRuntime = requireStartedRuntime(runtime);
        const { conversationId } = await createConversation(liveRuntime.port, {
          title: "Live LifeOps Sleep Goal",
        });
        const initialGoals = await req(
          liveRuntime.port,
          "GET",
          "/api/lifeops/goals",
        );
        expect(initialGoals.status).toBe(200);
        const existingGoalIds = new Set(
          Array.isArray(initialGoals.data.goals)
            ? initialGoals.data.goals
                .map((entry: { goal?: { id?: string } }) => entry.goal?.id)
                .filter((entry): entry is string => typeof entry === "string")
            : [],
        );

        const requestText = "I want a goal called Stabilize sleep schedule.";
        const clarifyText = await postLiveConversationMessage(
          liveRuntime,
          conversationId,
          requestText,
          "sleep-goal clarify",
        );
        assertNoProviderIssue("sleep-goal clarify", clarifyText, liveRuntime);
        await expectJudgePasses({
          label: "sleep-goal clarify",
          rubric:
            "The assistant should not say the goal was saved or ready to save. It should explain that the sleep goal still needs evaluation details and ask for the most important missing grounding detail, such as target sleep and wake times, an allowed consistency window, or the review period.",
          runtime: liveRuntime,
          text: clarifyText,
          transcript: `user: ${requestText}`,
        });

        const goalsAfterClarification = await req(
          liveRuntime.port,
          "GET",
          "/api/lifeops/goals",
        );
        expect(goalsAfterClarification.status).toBe(200);
        expect(
          Array.isArray(goalsAfterClarification.data.goals)
            ? goalsAfterClarification.data.goals.filter(
                (entry: { goal?: { id?: string } }) =>
                  typeof entry.goal?.id === "string" &&
                  !existingGoalIds.has(entry.goal.id),
              ).length
            : 0,
        ).toBe(0);

        const groundedRequest =
          "For the stabilize sleep schedule goal, I want to be asleep by 11:30 pm and up by 7:30 am on weekdays, within 45 minutes, for the next month.";
        const previewText = await postLiveConversationMessage(
          liveRuntime,
          conversationId,
          groundedRequest,
          "sleep-goal preview",
        );
        assertNoProviderIssue("sleep-goal preview", previewText, liveRuntime);
        await expectJudgePasses({
          label: "sleep-goal preview",
          rubric:
            "The assistant should treat the goal as grounded enough to preview, summarize the evaluation contract in plain language, and ask for confirmation before saving. It should not claim the goal is already saved.",
          runtime: liveRuntime,
          text: previewText,
          transcript: `user: ${requestText}\nassistant: ${clarifyText}\nuser: ${groundedRequest}`,
        });

        const goalsBeforeConfirm = await req(
          liveRuntime.port,
          "GET",
          "/api/lifeops/goals",
        );
        expect(goalsBeforeConfirm.status).toBe(200);
        expect(
          Array.isArray(goalsBeforeConfirm.data.goals)
            ? goalsBeforeConfirm.data.goals.filter(
                (entry: { goal?: { id?: string } }) =>
                  typeof entry.goal?.id === "string" &&
                  !existingGoalIds.has(entry.goal.id),
              ).length
            : 0,
        ).toBe(0);

        const confirmText = "Yes, save that grounded goal.";
        const savedText = await postLiveConversationMessage(
          liveRuntime,
          conversationId,
          confirmText,
          "sleep-goal confirm",
        );
        assertNoProviderIssue("sleep-goal confirm", savedText, liveRuntime);
        await expectJudgePasses({
          label: "sleep-goal confirm",
          rubric:
            "The assistant should clearly confirm that the grounded sleep goal has now been saved, without asking for more information.",
          runtime: liveRuntime,
          text: savedText,
          transcript: `user: ${requestText}\nassistant: ${clarifyText}\nuser: ${groundedRequest}\nassistant: ${previewText}\nuser: ${confirmText}`,
        });

        const clarifyTrajectory = await waitForTrajectoryCall(
          liveRuntime.port,
          requestText,
        );
        expect(clarifyTrajectory.trajectoryId.length).toBeGreaterThan(0);
        expect(
          String(clarifyTrajectory.llmCall.response ?? "").length,
        ).toBeGreaterThan(0);
        const previewTrajectory = await waitForTrajectoryCall(
          liveRuntime.port,
          groundedRequest,
        );
        expect(previewTrajectory.trajectoryId.length).toBeGreaterThan(0);
        expect(
          String(previewTrajectory.llmCall.response ?? "").length,
        ).toBeGreaterThan(0);
        const confirmTrajectory = await waitForTrajectoryCall(
          liveRuntime.port,
          confirmText,
        );
        expect(confirmTrajectory.trajectoryId.length).toBeGreaterThan(0);
        expect(
          String(confirmTrajectory.llmCall.response ?? "").length,
        ).toBeGreaterThan(0);

        const goal = await waitForNewGoal(liveRuntime.port, existingGoalIds);
        expect(goal.goal?.status).toBe("active");
        expect(goal.goal?.reviewState).toBe("idle");
        expect(typeof goal.goal?.description).toBe("string");
        expect(
          String(goal.goal?.description ?? "").trim().length,
        ).toBeGreaterThan(0);
        expect(goal.goal?.successCriteria).toBeTruthy();
        expect(typeof goal.goal?.successCriteria).toBe("object");
        expect(goal.goal?.supportStrategy).toBeTruthy();
        expect(typeof goal.goal?.supportStrategy).toBe("object");
        const goalMetadata = (goal.goal?.metadata ?? null) as Record<
          string,
          unknown
        > | null;
        expect(goalMetadata).toBeTruthy();
        const goalGrounding = (goalMetadata?.goalGrounding ?? null) as Record<
          string,
          unknown
        > | null;
        expect(goalGrounding).toBeTruthy();
        expect(goalGrounding?.groundingState).toBe("grounded");
        expect(typeof goalGrounding?.summary).toBe("string");
        expect(
          String(goalGrounding?.summary ?? "").trim().length,
        ).toBeGreaterThan(0);
        expect(goalGrounding?.missingCriticalFields).toEqual([]);
      },
      LIVE_CHAT_TEST_TIMEOUT_MS,
    );

    it(
      "creates a meal-window vitamin routine through chat",
      async () => {
        const liveRuntime = requireStartedRuntime(runtime);
        const { conversationId } = await createConversation(liveRuntime.port, {
          title: "Live LifeOps Vitamins",
        });

        const requestText =
          "Please remind me to take vitamins with lunch every day.";
        const previewText = await postLiveConversationMessage(
          liveRuntime,
          conversationId,
          requestText,
          "vitamins preview",
        );
        assertNoProviderIssue("vitamins preview", previewText, liveRuntime);
        expect(previewText.trim().length).toBeGreaterThan(0);

        const vitaminDefinitionsBeforeConfirm = await req(
          liveRuntime.port,
          "GET",
          "/api/lifeops/definitions",
        );
        expect(vitaminDefinitionsBeforeConfirm.status).toBe(200);
        expect(
          Array.isArray(vitaminDefinitionsBeforeConfirm.data.definitions) &&
            vitaminDefinitionsBeforeConfirm.data.definitions.some(
              (entry: { definition?: { title?: string } }) =>
                entry.definition?.title === "Take vitamins",
            ),
        ).toBe(false);

        const confirmText = "Yes, save that vitamin routine.";
        const savedText = await postLiveConversationMessage(
          liveRuntime,
          conversationId,
          confirmText,
          "vitamins confirm",
        );
        assertNoProviderIssue("vitamins confirm", savedText, liveRuntime);
        expect(savedText).toMatch(/take vitamins/i);

        const previewTrajectory = await waitForTrajectoryCall(
          liveRuntime.port,
          requestText,
        );
        expect(previewTrajectory.trajectoryId.length).toBeGreaterThan(0);
        expect(
          String(previewTrajectory.llmCall.response ?? "").length,
        ).toBeGreaterThan(0);
        const confirmTrajectory = await waitForTrajectoryCall(
          liveRuntime.port,
          confirmText,
        );
        expect(confirmTrajectory.trajectoryId.length).toBeGreaterThan(0);
        expect(
          String(confirmTrajectory.llmCall.response ?? "").length,
        ).toBeGreaterThan(0);

        const vitamins = await waitForDefinitionByTitle(
          liveRuntime.port,
          "Take vitamins",
        );
        expect(vitamins.definition?.cadence).toMatchObject({
          kind: "daily",
          windows: expect.arrayContaining(["afternoon"]),
        });
        expect(vitamins.reminderPlan?.id ?? null).not.toBeNull();
      },
      LIVE_CHAT_TEST_TIMEOUT_MS,
    );

    it(
      "adjusts reminder intensity through chat and persists the preference",
      async () => {
        const liveRuntime = requireStartedRuntime(runtime);
        const { conversationId } = await createConversation(liveRuntime.port, {
          title: "Live LifeOps Reminder Preference",
        });

        const createPrompt =
          "Please remind me to drink water throughout the day.";
        const previewText = await postLiveConversationMessage(
          liveRuntime,
          conversationId,
          createPrompt,
          "water preview",
        );
        assertNoProviderIssue("water preview", previewText, liveRuntime);
        expect(previewText.trim().length).toBeGreaterThan(0);

        const waterDefinitionsBeforeConfirm = await req(
          liveRuntime.port,
          "GET",
          "/api/lifeops/definitions",
        );
        expect(waterDefinitionsBeforeConfirm.status).toBe(200);
        expect(
          Array.isArray(waterDefinitionsBeforeConfirm.data.definitions) &&
            waterDefinitionsBeforeConfirm.data.definitions.some(
              (entry: { definition?: { title?: string } }) =>
                entry.definition?.title === "Drink water",
            ),
        ).toBe(false);

        const confirmText = "Yes, save that water routine.";
        const createResponseText = await postLiveConversationMessage(
          liveRuntime,
          conversationId,
          confirmText,
          "water confirm",
        );
        assertNoProviderIssue("water confirm", createResponseText, liveRuntime);
        expect(createResponseText).toMatch(/drink water/i);

        const drinkWater = await waitForDefinitionByTitle(
          liveRuntime.port,
          "Drink water",
        );
        const definitionId = String(drinkWater.definition?.id ?? "");
        expect(definitionId.length).toBeGreaterThan(0);

        const preferencePrompt = "Remind me less about drink water.";
        const responseText = await postLiveConversationMessage(
          liveRuntime,
          conversationId,
          preferencePrompt,
          "reminder preference update",
        );
        assertNoProviderIssue(
          "reminder preference update",
          responseText,
          liveRuntime,
        );
        expect(responseText.trim().length).toBeGreaterThan(0);

        const trajectory = await waitForTrajectoryCall(
          liveRuntime.port,
          preferencePrompt,
        );
        expect(trajectory.trajectoryId.length).toBeGreaterThan(0);
        expect(
          String(trajectory.llmCall.response ?? "").length,
        ).toBeGreaterThan(0);

        const preference = await req(
          liveRuntime.port,
          "GET",
          `/api/lifeops/reminder-preferences?definitionId=${encodeURIComponent(definitionId)}`,
        );
        expect(preference.status).toBe(200);
        expect(
          (preference.data.effective as Record<string, unknown>).intensity,
        ).toBe("minimal");
      },
      LIVE_CHAT_TEST_TIMEOUT_MS,
    );

    it(
      "routes itinerary questions toward CALENDAR instead of task agents",
      async () => {
        const liveRuntime = requireStartedRuntime(runtime);
        const { conversationId } = await createConversation(liveRuntime.port, {
          title: "Live LifeOps Calendar Routing",
        });

        const prompt = "hey when do i fly back from denver";
        const responseText = await postLiveConversationMessage(
          liveRuntime,
          conversationId,
          prompt,
          "calendar routing",
        );
        assertNoProviderIssue("calendar routing", responseText, liveRuntime);
        expect(responseText).not.toMatch(/no active task agents/i);
        expect(responseText).not.toMatch(
          /create_task|spawn_agent|send_to_agent/i,
        );

        const trajectory = await waitForTrajectoryCall(
          liveRuntime.port,
          prompt,
        );
        const plannerResponse = String(trajectory.llmCall.response ?? "");
        expect(plannerResponse).toMatch(/CALENDAR/i);
        expect(plannerResponse).not.toMatch(
          /CREATE_TASK|SPAWN_AGENT|SEND_TO_AGENT|LIST_AGENTS/i,
        );
      },
      LIVE_CHAT_TEST_TIMEOUT_MS,
    );

    it(
      "routes sender-style Gmail searches toward TRIAGE_MESSAGES across name and address variants",
      async () => {
        const liveRuntime = requireStartedRuntime(runtime);
        const cases = [
          {
            userRequest: "find the email from suran",
            requiredFragments: ["triage_messages", "suran"],
          },
          {
            userRequest: "look for any email from suran@example.com",
            requiredFragments: ["triage_messages", "suran@example.com"],
          },
          {
            userRequest: "search my inbox for messages from Suran Lee",
            requiredFragments: ["triage_messages", "suran lee"],
          },
          {
            userRequest:
              "can you search my email and tell me if anyone named suran emailed me",
            requiredFragments: ["triage_messages", "suran"],
          },
          {
            userRequest:
              "look for all emails sent to me from suran in the last few weeks",
            requiredFragments: ["triage_messages", "suran"],
          },
          {
            userRequest: "show all unread emails from alex@example.com",
            requiredFragments: [
              "triage_messages",
              "alex@example.com",
              "unread",
            ],
          },
        ] as const;

        for (const testCase of cases) {
          const { conversationId } = await createConversation(
            liveRuntime.port,
            {
              title: `Live Gmail Routing ${testCase.userRequest}`,
            },
          );
          const prompt = testCase.userRequest;
          const responseText = await postLiveConversationMessage(
            liveRuntime,
            conversationId,
            prompt,
            `gmail sender routing: ${testCase.userRequest}`,
          );
          assertNoProviderIssue(
            `gmail sender routing: ${testCase.userRequest}`,
            responseText,
            liveRuntime,
          );

          const trajectory = await waitForTrajectoryCall(
            liveRuntime.port,
            prompt,
          );
          const plannerResponse = String(trajectory.llmCall.response ?? "");
          expectPlannerResponseToContainAll(
            plannerResponse,
            testCase.requiredFragments,
          );
          expect(plannerResponse).not.toMatch(
            /CREATE_TASK|SPAWN_AGENT|SEND_TO_AGENT|LIST_AGENTS/i,
          );
        }
      },
      LIVE_CHAT_TEST_TIMEOUT_MS,
    );

    it(
      "routes broad Gmail filters toward TRIAGE_MESSAGES and preserves the key search terms",
      async () => {
        const liveRuntime = requireStartedRuntime(runtime);
        const cases = [
          {
            userRequest: "find emails that contain invoice",
            requiredFragments: ["triage_messages", "invoice"],
          },
          {
            userRequest: "find all emails from alex that contain venue",
            requiredFragments: ["triage_messages", "alex", "venue"],
          },
          {
            userRequest:
              "show me all messages where the subject mentions agenda",
            requiredFragments: ["triage_messages", "agenda"],
          },
          {
            userRequest: "which emails need a reply about venue",
            requiredFragments: ["triage_messages", "venue"],
            anyFragments: ["replyneededonly", "reply needed", "needs_response"],
          },
        ] as const;

        for (const testCase of cases) {
          const { conversationId } = await createConversation(
            liveRuntime.port,
            {
              title: `Live Gmail Filters ${testCase.userRequest}`,
            },
          );
          const prompt = testCase.userRequest;
          const responseText = await postLiveConversationMessage(
            liveRuntime,
            conversationId,
            prompt,
            `gmail filter routing: ${testCase.userRequest}`,
          );
          assertNoProviderIssue(
            `gmail filter routing: ${testCase.userRequest}`,
            responseText,
            liveRuntime,
          );

          const trajectory = await waitForTrajectoryCall(
            liveRuntime.port,
            prompt,
          );
          const plannerResponse = String(trajectory.llmCall.response ?? "");
          expectPlannerResponseToContainAll(
            plannerResponse,
            testCase.requiredFragments,
          );
          if ("anyFragments" in testCase) {
            expectPlannerResponseToContainAny(plannerResponse, [
              ...testCase.anyFragments,
            ]);
          }
          expect(plannerResponse).not.toMatch(
            /CREATE_TASK|SPAWN_AGENT|SEND_TO_AGENT|LIST_AGENTS/i,
          );
        }
      },
      LIVE_CHAT_TEST_TIMEOUT_MS,
    );
  },
);
