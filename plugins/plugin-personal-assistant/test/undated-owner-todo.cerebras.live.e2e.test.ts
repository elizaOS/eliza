/**
 * Live Cerebras proof for the owner-todo cadence boundary. The test boots the
 * real LifeOps runtime and inspects its actual PGlite definition, occurrence,
 * and trajectory ledgers so a model-only reply cannot masquerade as proof.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { describeIf } from "../../../packages/app-core/test/helpers/conditional-tests.ts";
import {
  createConversation,
  req,
} from "../../../packages/app-core/test/helpers/http.ts";
import {
  type CapturedWireCall,
  type CerebrasWireCapture,
  startCerebrasWireCapture,
  writeCerebrasEvidenceArtifacts,
} from "../../plugin-openai/__tests__/helpers/cerebras-wire-capture.ts";
import {
  assertNoProviderIssue,
  LIVE_CHAT_TEST_TIMEOUT_MS,
  LIVE_RUNTIME_BOOT_TIMEOUT_MS,
  LIVE_TESTS_ENABLED,
  postLiveConversationMessage,
  type StartedLifeOpsLiveRuntime,
  selectLifeOpsLiveProvider,
  startLifeOpsLiveRuntime,
  waitForDefinitionByTitle,
} from "./helpers/lifeops-live-harness.ts";

const selectedProvider = await selectLifeOpsLiveProvider();
const suiteEnabled =
  LIVE_TESTS_ENABLED && selectedProvider?.name === "cerebras";

const DEFINITION_LEDGER = {
  schema: "app_lifeops",
  table: "life_task_definitions",
  orderBy: ["created_at", "id"],
} as const;

const OCCURRENCE_LEDGER = {
  schema: "app_lifeops",
  table: "life_task_occurrences",
  orderBy: ["definition_id", "occurrence_key", "id"],
} as const;

const TRAJECTORY_LEDGER = {
  schema: "public",
  table: "trajectories",
  orderBy: ["created_at", "id"],
} as const;

type SqlRow = Record<string, unknown>;
type CapturedTrajectory = {
  turnName: string;
  input: string;
  response: string;
  trajectoryId: string;
  row: SqlRow;
  wireCalls: CapturedWireCall[];
};

function normalizeEvidenceText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function containsText(value: unknown, expected: string): boolean {
  if (typeof value === "string") {
    return normalizeEvidenceText(value).includes(
      normalizeEvidenceText(expected),
    );
  }
  if (Array.isArray(value)) {
    return value.some((entry) => containsText(entry, expected));
  }
  if (value && typeof value === "object") {
    return Object.values(value).some((entry) => containsText(entry, expected));
  }
  return false;
}

function parseTrajectorySteps(row: SqlRow): unknown[] {
  const raw = row.steps_json;
  const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!Array.isArray(parsed)) {
    throw new Error(`Trajectory ${String(row.id)} has invalid steps_json`);
  }
  return parsed;
}

function parsedWireRequest(call: CapturedWireCall): Record<string, unknown> {
  const parsed = call.request?.parsedBody;
  if (
    parsed?.kind !== "json" ||
    !parsed.value ||
    typeof parsed.value !== "object" ||
    Array.isArray(parsed.value)
  ) {
    throw new Error(`Wire call ${call.id} has no JSON request body`);
  }
  return parsed.value as Record<string, unknown>;
}

function isModelWireCall(call: CapturedWireCall): boolean {
  const parsed = call.request?.parsedBody;
  return (
    parsed?.kind === "json" &&
    !!parsed.value &&
    typeof parsed.value === "object" &&
    !Array.isArray(parsed.value) &&
    typeof (parsed.value as { model?: unknown }).model === "string" &&
    (parsed.value as { model: string }).model.trim().length > 0
  );
}

async function readOnlyRows(
  runtime: StartedLifeOpsLiveRuntime,
  ledger: {
    schema: string;
    table: string;
    orderBy: readonly string[];
  },
): Promise<SqlRow[]> {
  const apiToken = process.env.ELIZA_API_TOKEN?.trim();
  const query = new URLSearchParams({
    schema: ledger.schema,
    limit: "500",
  });
  const response = await req(
    runtime.port,
    "GET",
    `/api/database/tables/${encodeURIComponent(ledger.table)}/rows?${query.toString()}`,
    undefined,
    apiToken ? { Authorization: `Bearer ${apiToken}` } : undefined,
    { timeoutMs: 30_000 },
  );
  if (response.status !== 200) {
    throw new Error(
      `Read-only evidence query failed (${response.status}): ${JSON.stringify(response.data)}`,
    );
  }
  if (
    !Array.isArray(response.data.columns) ||
    !Array.isArray(response.data.rows)
  ) {
    throw new Error(
      "Read-only evidence query returned an invalid result shape",
    );
  }
  const rows = response.data.rows.filter(
    (row): row is SqlRow =>
      !!row && typeof row === "object" && !Array.isArray(row),
  );
  expect(response.data.total).toBe(rows.length);
  return rows.toSorted((left, right) => {
    for (const column of ledger.orderBy) {
      const comparison = String(left[column] ?? "").localeCompare(
        String(right[column] ?? ""),
      );
      if (comparison !== 0) return comparison;
    }
    return 0;
  });
}

async function waitForTurnTrajectory(
  runtime: StartedLifeOpsLiveRuntime,
  priorIds: ReadonlySet<string>,
  input: string,
  wireCapture: CerebrasWireCapture,
  wireStartIndex: number,
): Promise<Omit<CapturedTrajectory, "turnName" | "input" | "response">> {
  const deadline = Date.now() + 120_000;
  let latestCandidateSummary: Array<Record<string, unknown>> = [];
  while (Date.now() < deadline) {
    const rows = await readOnlyRows(runtime, TRAJECTORY_LEDGER);
    latestCandidateSummary = rows
      .filter((row) => {
        const trajectoryId = String(row.id ?? "");
        return trajectoryId.length > 0 && !priorIds.has(trajectoryId);
      })
      .map((row) => {
        const steps = parseTrajectorySteps(row);
        return {
          id: row.id,
          status: row.status,
          source: row.source,
          llmCallCount: row.llm_call_count,
          stepCount: row.step_count,
          parsedStepCount: steps.length,
          containsExpectedInput: containsText(steps, input),
          rowKeys: Object.keys(row).sort(),
        };
      });
    for (const row of rows) {
      const trajectoryId = String(row.id ?? "");
      if (
        !trajectoryId ||
        priorIds.has(trajectoryId) ||
        row.status !== "completed"
      ) {
        continue;
      }
      const wireCalls = wireCapture.calls.slice(wireStartIndex);
      if (
        wireCalls.length === 0 ||
        wireCalls.some((call) => call.completedAt === undefined)
      ) {
        continue;
      }
      const modelWireCalls = wireCalls.filter(isModelWireCall);
      expect(modelWireCalls.length).toBeGreaterThan(0);
      expect(
        modelWireCalls.some((call) =>
          containsText(parsedWireRequest(call), input),
        ),
      ).toBe(true);
      for (const call of wireCalls) {
        expect(call.response?.body?.byteLength ?? 0).toBeGreaterThan(0);
        expect(call.transport.outcome).toBe("complete");
        expect(call.durationMs).toBeGreaterThanOrEqual(0);
      }
      for (const call of modelWireCalls) {
        expect(call.request?.method).toBe("POST");
        expect(call.response?.status).toBe(200);
      }
      return { trajectoryId, row, wireCalls };
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(
    `Timed out waiting for trajectory for: ${input}\nCandidates: ${JSON.stringify(latestCandidateSummary, null, 2)}\n${runtime.getLogTail()}`,
  );
}

async function writeLiveEvidence(args: {
  trajectories: CapturedTrajectory[];
  domain: Record<string, unknown>;
  logTails: Array<{ turnName: string; logTail: string }>;
}): Promise<void> {
  const artifactDir = process.env.ELIZA_LIVE_TEST_ARTIFACT_DIR?.trim();
  if (!artifactDir) return;
  await mkdir(artifactDir, { recursive: true });
  const llmCallsPath =
    process.env.ELIZA_LIVE_TEST_LLM_CALLS_JSONL?.trim() ??
    path.join(artifactDir, "llm-calls.jsonl");
  const modelCalls = args.trajectories.flatMap((trajectory) =>
    trajectory.wireCalls.filter(isModelWireCall).map((wireCall) => ({
      turnName: trajectory.turnName,
      input: trajectory.input,
      response: trajectory.response,
      trajectoryId: trajectory.trajectoryId,
      wireCallId: wireCall.id,
      durationMs: wireCall.durationMs,
      request: parsedWireRequest(wireCall),
      providerResponse:
        wireCall.response?.parsedBody ?? wireCall.response?.body?.utf8,
    })),
  );
  const trajectorySummary = args.trajectories.map(
    ({ wireCalls, ...trajectory }) => ({
      ...trajectory,
      wireCalls: wireCalls.map((wireCall) => ({
        id: wireCall.id,
        startedAt: wireCall.startedAt,
        completedAt: wireCall.completedAt,
        durationMs: wireCall.durationMs,
        requestSha256: wireCall.request?.body.sha256,
        responseSha256: wireCall.response?.body?.sha256,
        responseStatus: wireCall.response?.status,
        transportOutcome: wireCall.transport.outcome,
      })),
    }),
  );
  const cerebrasKey = process.env.CEREBRAS_API_KEY?.trim();
  if (!cerebrasKey) {
    throw new Error("Cerebras key disappeared before evidence sanitization");
  }
  await Promise.all([
    writeCerebrasEvidenceArtifacts({
      artifactDirectory: artifactDir,
      trajectoryPath: llmCallsPath,
      calls: args.trajectories.flatMap((trajectory) => trajectory.wireCalls),
      trajectories: modelCalls,
      receipts: [
        {
          name: "undated-owner-todo-domain-proof",
          definitionRowCount: Array.isArray(
            args.domain.definitionRowsAfterConfirm,
          )
            ? args.domain.definitionRowsAfterConfirm.length
            : null,
          occurrenceRowCount: Array.isArray(
            args.domain.occurrenceRowsAfterConfirm,
          )
            ? args.domain.occurrenceRowsAfterConfirm.length
            : null,
        },
      ],
      secrets: [cerebrasKey],
      metadata: {
        issue: 20026,
        evidenceHead: process.env.ELIZA_LIVE_EVIDENCE_HEAD ?? "local",
        provider: "cerebras",
        transport: "credential-redacted-loopback-wire-capture",
      },
    }),
    writeFile(
      path.join(artifactDir, "trajectory-proof.raw.json"),
      `${JSON.stringify(trajectorySummary, null, 2)}\n`,
    ),
    writeFile(
      path.join(artifactDir, "domain-proof.raw.json"),
      `${JSON.stringify(args.domain, null, 2)}\n`,
    ),
    writeFile(
      path.join(artifactDir, "backend-log-tails.raw.log"),
      `${args.logTails
        .map(({ turnName, logTail }) => `## ${turnName}\n${logTail}`)
        .join("\n\n")}\n`,
    ),
  ]);
}

describeIf(suiteEnabled)("Live: undated owner-todo boundary", () => {
  let runtime: StartedLifeOpsLiveRuntime;
  let wireCapture: CerebrasWireCapture;

  beforeEach(async () => {
    if (!selectedProvider)
      throw new Error("Cerebras provider was not selected");
    wireCapture = await startCerebrasWireCapture();
    try {
      runtime = await startLifeOpsLiveRuntime({
        selectedProvider: {
          ...selectedProvider,
          env: {
            ...selectedProvider.env,
            OPENAI_BASE_URL: wireCapture.baseUrl,
            CEREBRAS_BASE_URL: wireCapture.baseUrl,
          },
        },
      });
    } catch (error) {
      await wireCapture.close();
      throw error;
    }
  }, LIVE_RUNTIME_BOOT_TIMEOUT_MS + 30_000);

  afterEach(async () => {
    const results = await Promise.allSettled([
      runtime?.close(),
      wireCapture?.close(),
    ]);
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length > 0) {
      throw new AggregateError(failures, "Live evidence teardown failed");
    }
  });

  it(
    "persists one plain Todo and rejects contradictory undated writes",
    async () => {
      const { conversationId } = await createConversation(runtime.port, {
        title: "Undated owner todo proof",
      });
      const trajectories: CapturedTrajectory[] = [];
      const logTails: Array<{ turnName: string; logTail: string }> = [];
      const runTrackedTurn = async (
        input: string,
        turnName: string,
      ): Promise<string> => {
        const priorTrajectoryIds = new Set(
          (await readOnlyRows(runtime, TRAJECTORY_LEDGER)).map((row) =>
            String(row.id ?? ""),
          ),
        );
        const wireStartIndex = wireCapture.calls.length;
        const response = await postLiveConversationMessage(
          runtime,
          conversationId,
          input,
          turnName,
        );
        assertNoProviderIssue(turnName, response, runtime);
        const trajectory = await waitForTurnTrajectory(
          runtime,
          priorTrajectoryIds,
          input,
          wireCapture,
          wireStartIndex,
        );
        trajectories.push({ turnName, input, response, ...trajectory });
        logTails.push({ turnName, logTail: runtime.getLogTail() });
        return response;
      };

      const todoRequest =
        "Create a personal todo titled Buy oat milk. It has no due date or reminder. Preview it first and do not save until I confirm.";
      const todoPreview = await runTrackedTurn(
        todoRequest,
        "undated todo preview",
      );

      const beforeConfirm = await req(
        runtime.port,
        "GET",
        "/api/lifeops/definitions",
      );
      expect(beforeConfirm.status).toBe(200);
      expect(todoPreview).toMatch(/oat milk|todo/i);
      const definitionRowsAfterPreview = await readOnlyRows(
        runtime,
        DEFINITION_LEDGER,
      );
      const prematurelySavedTodos = definitionRowsAfterPreview.filter(
        (row) => row.title === "Buy oat milk",
      );
      if (prematurelySavedTodos.length > 0) {
        await writeLiveEvidence({
          trajectories,
          logTails,
          domain: {
            failure: "preview_persisted_before_owner_confirmation",
            todoPreview,
            prematurelySavedTodos,
            definitionRowsAfterPreview,
          },
        });
        throw new Error(
          `Todo preview persisted before owner confirmation: ${todoPreview}\n${runtime.getLogTail()}`,
        );
      }

      const confirmRequest =
        "Yes, save the Buy oat milk todo exactly as previewed.";
      const todoConfirmation = await runTrackedTurn(
        confirmRequest,
        "undated todo confirm",
      );
      if (!/oat milk|saved|todo/i.test(todoConfirmation)) {
        throw new Error(
          `Todo confirmation returned an unexpected reply: ${todoConfirmation}\n${runtime.getLogTail()}`,
        );
      }
      const confirmationTrajectory = trajectories.at(-1);
      expect(confirmationTrajectory?.wireCalls.length).toBeGreaterThan(0);
      const immediateDefinitionRows = await readOnlyRows(
        runtime,
        DEFINITION_LEDGER,
      );
      if (
        !immediateDefinitionRows.some((row) => row.title === "Buy oat milk")
      ) {
        await writeLiveEvidence({
          trajectories,
          logTails,
          domain: {
            failure: "confirmation_claimed_saved_without_row",
            definitionRowsAfterPreview,
            immediateDefinitionRows,
          },
        });
        throw new Error(
          `Todo confirmation returned without a durable row: ${todoConfirmation}\nmodels=${JSON.stringify(
            confirmationTrajectory?.wireCalls
              .filter(isModelWireCall)
              .map((call) => parsedWireRequest(call).model),
          )}\n${runtime.getLogTail()}`,
        );
      }

      const savedTodo = await waitForDefinitionByTitle(
        runtime.port,
        "Buy oat milk",
        (entry) =>
          (entry.definition?.cadence as { kind?: string } | undefined)?.kind ===
            "unscheduled" && entry.reminderPlan === null,
      );
      const savedTodoId = String(savedTodo.definition?.id ?? "");
      expect(savedTodoId.length).toBeGreaterThan(0);
      const exactTodo = await req(
        runtime.port,
        "GET",
        `/api/lifeops/definitions/${encodeURIComponent(savedTodoId)}`,
      );
      expect(exactTodo.status).toBe(200);
      expect(exactTodo.data).toMatchObject({
        definition: {
          id: savedTodoId,
          kind: "task",
          title: "Buy oat milk",
          status: "active",
          cadence: { kind: "unscheduled" },
          reminderPlanId: null,
          source: "chat",
        },
        reminderPlan: null,
      });
      expect(exactTodo.data.performance).toEqual({
        lastCompletedAt: null,
        lastSkippedAt: null,
        lastActivityAt: null,
        totalScheduledCount: 0,
        totalCompletedCount: 0,
        totalSkippedCount: 0,
        totalPendingCount: 0,
        currentOccurrenceStreak: 0,
        bestOccurrenceStreak: 0,
        currentPerfectDayStreak: 0,
        bestPerfectDayStreak: 0,
        last7Days: {
          scheduledCount: 0,
          completedCount: 0,
          skippedCount: 0,
          pendingCount: 0,
          completionRate: 0,
          perfectDayCount: 0,
        },
        last30Days: {
          scheduledCount: 0,
          completedCount: 0,
          skippedCount: 0,
          pendingCount: 0,
          completionRate: 0,
          perfectDayCount: 0,
        },
      });
      const todoOverview = await req(
        runtime.port,
        "GET",
        "/api/lifeops/overview",
      );
      expect(todoOverview.status).toBe(200);
      const definitionRowsAfterConfirm = await readOnlyRows(
        runtime,
        DEFINITION_LEDGER,
      );
      const exactPersistedRows = definitionRowsAfterConfirm.filter(
        (row) => row.id === savedTodoId,
      );
      expect(exactPersistedRows).toHaveLength(1);
      expect(exactPersistedRows[0]).toMatchObject({
        id: savedTodoId,
        kind: "task",
        title: "Buy oat milk",
        status: "active",
        reminder_plan_id: null,
        source: "chat",
      });
      expect(JSON.parse(String(exactPersistedRows[0]?.cadence_json))).toEqual({
        kind: "unscheduled",
      });
      const occurrenceRowsAfterConfirm = await readOnlyRows(
        runtime,
        OCCURRENCE_LEDGER,
      );
      expect(
        occurrenceRowsAfterConfirm.filter(
          (row) => row.definition_id === savedTodoId,
        ),
      ).toEqual([]);
      const savedTodoOccurrenceIds = Array.isArray(
        todoOverview.data.occurrences,
      )
        ? todoOverview.data.occurrences
            .filter(
              (occurrence: { definitionId?: string }) =>
                occurrence.definitionId === savedTodoId,
            )
            .map((occurrence: { id?: string }) => String(occurrence.id ?? ""))
        : [];
      expect(savedTodoOccurrenceIds).toEqual([]);

      const editedTitle = "Book dentist visit";
      const editPreviewRequest = `Create a personal todo titled ${editedTitle}. It has no due date. Preview it first and do not save until I confirm.`;
      const editPreview = await runTrackedTurn(
        editPreviewRequest,
        "contradictory edit preview",
      );
      const beforeEdit = await req(
        runtime.port,
        "GET",
        "/api/lifeops/definitions",
      );
      expect(beforeEdit.status).toBe(200);

      const contradictoryEditRequest = "Keep it with no due date, but Friday.";
      const contradictoryEdit = await runTrackedTurn(
        contradictoryEditRequest,
        "contradictory undated edit",
      );
      const afterEdit = await req(
        runtime.port,
        "GET",
        "/api/lifeops/definitions",
      );
      expect(afterEdit.status).toBe(200);
      const beforeEditIds = Array.isArray(beforeEdit.data.definitions)
        ? beforeEdit.data.definitions
            .map(
              (entry: { definition?: { id?: string } }) => entry.definition?.id,
            )
            .toSorted()
        : [];
      const afterEditIds = Array.isArray(afterEdit.data.definitions)
        ? afterEdit.data.definitions
            .map(
              (entry: { definition?: { id?: string } }) => entry.definition?.id,
            )
            .toSorted()
        : [];
      if (JSON.stringify(afterEditIds) !== JSON.stringify(beforeEditIds)) {
        const definitionRowsAfterContradictoryEdit = await readOnlyRows(
          runtime,
          DEFINITION_LEDGER,
        );
        await writeLiveEvidence({
          trajectories,
          logTails,
          domain: {
            failure: "contradictory_edit_persisted_before_confirmation",
            editPreview,
            contradictoryEdit,
            beforeEditIds,
            afterEditIds,
            definitionRowsAfterContradictoryEdit,
          },
        });
        throw new Error(
          `Contradictory Todo edit changed durable rows before confirmation: ${contradictoryEdit}\n${runtime.getLogTail()}`,
        );
      }
      expect(
        Array.isArray(afterEdit.data.definitions) &&
          afterEdit.data.definitions.some(
            (entry: {
              definition?: { title?: string; cadence?: { kind?: string } };
            }) =>
              entry.definition?.title === editedTitle &&
              entry.definition.cadence?.kind === "unscheduled",
          ),
      ).toBe(false);

      const contradictoryConfirmRequest =
        "Yes, confirm and save the edited Book dentist visit task now.";
      const contradictoryConfirmation = await runTrackedTurn(
        contradictoryConfirmRequest,
        "contradictory edit confirm",
      );
      const contradictoryConfirmTrajectory = trajectories.at(-1);
      expect(contradictoryConfirmTrajectory?.wireCalls.length).toBeGreaterThan(
        0,
      );
      const definitionRowsAfterContradictoryConfirm = await readOnlyRows(
        runtime,
        DEFINITION_LEDGER,
      );
      expect(
        definitionRowsAfterContradictoryConfirm.filter(
          (row) => row.title === editedTitle,
        ),
      ).toEqual([]);
      const afterContradictoryConfirmation = await req(
        runtime.port,
        "GET",
        "/api/lifeops/definitions",
      );
      expect(afterContradictoryConfirmation.status).toBe(200);
      expect(
        Array.isArray(afterContradictoryConfirmation.data.definitions) &&
          afterContradictoryConfirmation.data.definitions.some(
            (entry: {
              definition?: { title?: string; cadence?: { kind?: string } };
            }) =>
              entry.definition?.title === editedTitle &&
              entry.definition.cadence?.kind === "unscheduled",
          ),
      ).toBe(false);

      const reminderRequest =
        "Remind me to call Mom, but I have not said when.";
      const reminderResponse = await runTrackedTurn(
        reminderRequest,
        "unscheduled reminder",
      );
      const afterReminder = await req(
        runtime.port,
        "GET",
        "/api/lifeops/definitions",
      );
      expect(afterReminder.status).toBe(200);
      const definitionRowsAfterReminder = await readOnlyRows(
        runtime,
        DEFINITION_LEDGER,
      );
      const reminderAskedForTiming = /when|what time|date|day|schedule/i.test(
        reminderResponse,
      );
      const reminderPreservedRows =
        JSON.stringify(definitionRowsAfterReminder) ===
        JSON.stringify(definitionRowsAfterContradictoryConfirm);
      if (!reminderAskedForTiming || !reminderPreservedRows) {
        await writeLiveEvidence({
          trajectories,
          logTails,
          domain: {
            failure: "unscheduled_reminder_invented_timing",
            reminderRequest,
            reminderResponse,
            definitionRowsBeforeReminder:
              definitionRowsAfterContradictoryConfirm,
            definitionRowsAfterReminder,
          },
        });
        throw new Error(
          `unscheduled reminder did not ask for timing: ${reminderResponse}\n${runtime.getLogTail()}`,
        );
      }
      const definitions = Array.isArray(afterReminder.data.definitions)
        ? afterReminder.data.definitions
        : [];
      expect(definitions).toEqual(
        afterContradictoryConfirmation.data.definitions,
      );
      expect(definitionRowsAfterReminder).toEqual(
        definitionRowsAfterContradictoryConfirm,
      );

      await writeLiveEvidence({
        trajectories,
        logTails,
        domain: {
          exactTodo: exactTodo.data,
          todoOverview: todoOverview.data,
          definitionRowsAfterPreview,
          definitionRowsAfterConfirm,
          occurrenceRowsAfterConfirm,
          definitionRowsAfterContradictoryConfirm,
          definitionRowsAfterReminder,
        },
      });

      console.log(
        JSON.stringify(
          {
            provider: runtime.providerName,
            input: [
              todoRequest,
              confirmRequest,
              editPreviewRequest,
              contradictoryEditRequest,
              contradictoryConfirmRequest,
              reminderRequest,
            ],
            output: {
              todoPreview,
              todoConfirmation,
              exactTodo: exactTodo.data,
              todoOverview: todoOverview.data,
              savedTodoOccurrenceIds,
              persistedTodoCount: exactPersistedRows.length,
              persistedOccurrenceCount: occurrenceRowsAfterConfirm.filter(
                (row) => row.definition_id === savedTodoId,
              ).length,
              trajectoryCount: trajectories.length,
              llmCallCount: trajectories.reduce(
                (total, trajectory) => total + trajectory.wireCalls.length,
                0,
              ),
              editPreview,
              contradictoryEdit,
              contradictoryConfirmation,
              reminderResponse,
              definitionsBeforeConfirm: beforeConfirm.data.definitions,
              definitionsAfter: definitions,
              runtimeLogTail: runtime.getLogTail(),
            },
          },
          null,
          2,
        ),
      );
    },
    // Six separately tracked turns must leave room for evidence serialization
    // when the live provider applies sustained backpressure.
    LIVE_CHAT_TEST_TIMEOUT_MS * 3,
  );
});
