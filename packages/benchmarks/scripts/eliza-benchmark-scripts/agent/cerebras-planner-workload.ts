#!/usr/bin/env bun
/** Paired real-host planner acceptance. Full room-scoped trajectories are retained;
 * HTTP timing is not provider wire TTFT or a cache-isolation experiment. */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { testOutputPath } from "../../../../scripts/lib/test-output.ts";

type Json = Record<string, unknown>;
type Variant = "baseline" | "candidate";
export interface PlannerFixture {
  id: string;
  kind: "html-readback" | "read-compute" | "multiline-write" | "two-files";
  filesBefore: Record<string, string>;
  filesAfter: Record<string, string>;
  expectedReply: string[];
  prompt: string;
}
const record = (value: unknown): Json =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : {};
const array = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];

/** Same synthetic contents for both variants; only their isolated workspace path differs. */
export function plannerWorkloadFixture(
  index: number,
  workspace: string,
): PlannerFixture {
  if (!Number.isInteger(index) || index < 0 || index >= 30)
    throw new Error("Fixture index must be 0..29");
  const id = `planner-${String(index + 1).padStart(2, "0")}`;
  const code = `CHECK-${137 * (index + 1)}`;
  if (index < 10) {
    const html = `<html><body><h1>${code}</h1><p>Preview ${index + 1}</p></body></html>`;
    return {
      id,
      kind: "html-readback",
      filesBefore: {},
      filesAfter: { "index.html": html },
      expectedReply: [html],
      prompt: `Create ${join(workspace, "index.html")} containing exactly ${JSON.stringify(html)}. Read the saved file back and report its exact contents.`,
    };
  }
  if (index < 20) {
    const a = index + 17,
      b = index + 4;
    const input = JSON.stringify({ a, b, verificationCode: code });
    return {
      id,
      kind: "read-compute",
      filesBefore: { "input.json": input },
      filesAfter: { "input.json": input },
      expectedReply: [String(a * b), code],
      prompt: `Read ${join(workspace, "input.json")}, multiply its a and b values, and report the product and verificationCode. Preserve the input file.`,
    };
  }
  if (index < 25) {
    const note = `${code}\nSecond line: blue\nThird line: ready\n`;
    return {
      id,
      kind: "multiline-write",
      filesBefore: {},
      filesAfter: { "note.txt": note },
      expectedReply: [code],
      prompt: `Save the following text exactly, including its final newline, to ${join(workspace, "note.txt")}, then read the file and report its verification code:\n${note}`,
    };
  }
  const html = `<html><body>${code}</body></html>`,
    metadata = JSON.stringify({ verificationCode: code, ready: true });
  return {
    id,
    kind: "two-files",
    filesBefore: {},
    filesAfter: { "index.html": html, "metadata.json": metadata },
    expectedReply: [code],
    prompt: `Create two files in ${workspace}: index.html containing exactly ${JSON.stringify(html)}, and metadata.json containing exactly ${JSON.stringify(metadata)}. Read both saved files to verify their contents, then report the verification code.`,
  };
}

export async function validatePlannerFixture(
  fixture: PlannerFixture,
  workspace: string,
  response: unknown,
) {
  const files = await Promise.all(
    Object.entries(fixture.filesAfter).map(async ([name, expected]) => {
      try {
        const actual = await readFile(join(workspace, name), "utf8");
        return {
          name,
          matches: actual === expected,
          expected,
          actual,
          sha256: createHash("sha256").update(actual).digest("hex"),
        };
      } catch (error) {
        return {
          name,
          matches: false,
          expected,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );
  const text = String(record(response).text ?? "");
  const replyMatches = fixture.expectedReply.every((expected) =>
    text.includes(expected),
  );
  return {
    files,
    replyMatches,
    filesMatch: files.every((file) => file.matches),
    passed:
      files.every((file) => file.matches) &&
      replyMatches &&
      !record(response).terminalFailure &&
      !record(response).failureKind,
  };
}

export function summarizePlannerTrajectories(details: unknown[]) {
  const calls: Json[] = details
    .flatMap((detail) => array(record(detail).llmCalls).map(record))
    .map((call) => ({
      ...call,
      freshPromptTokens:
        typeof call.promptTokens === "number" &&
        typeof call.cacheReadInputTokens === "number" &&
        call.cacheReadInputTokens <= call.promptTokens
          ? call.promptTokens - call.cacheReadInputTokens
          : undefined,
    }));
  const tools = details.flatMap((detail) =>
    array(record(detail).toolEvents).map(record),
  );
  const totals = (selected: Json[], field: string) => {
    const values = selected
      .map((call) => call[field])
      .filter(
        (value): value is number =>
          typeof value === "number" && Number.isFinite(value),
      );
    return {
      totalReported: values.reduce((sum, value) => sum + value, 0),
      reportedCalls: values.length,
      missingCalls: selected.length - values.length,
    };
  };
  const metrics = (selected: Json[]) =>
    Object.fromEntries(
      [
        "promptTokens",
        "completionTokens",
        "cacheReadInputTokens",
        "cacheCreationInputTokens",
        "freshPromptTokens",
        "reasoningTokens",
        "latencyMs",
      ].map((field) => [field, totals(selected, field)]),
    );
  const stages = [
    ...new Set(
      calls.map((call) => String(call.modelType ?? call.purpose ?? "unknown")),
    ),
  ];
  const readReceipts = tools.filter((tool) => {
    if (tool.success !== true) return false;
    const args = record(tool.parameters ?? tool.args);
    return (
      /(^|_)READ($|_)/.test(String(tool.actionName)) ||
      [args.action, args.op, args.operation].includes("read") ||
      /(?:^|[\s;|])(?:cat|head|tail|Get-Content)\s|readFile(?:Sync)?\s*\(|\.read(?:_text)?\s*\(/.test(
        String(args.command ?? args.code ?? ""),
      )
    );
  });
  const semanticModels = (detail: unknown) =>
    array(record(detail).semanticStages)
      .map(record)
      .filter(
        (stage) => Object.keys(record(record(stage.payload).model)).length > 0,
      )
      .map((stage) => ({
        kind: String(stage.kind),
        model: record(record(stage.payload).model),
      }));
  const semantic = details.flatMap(semanticModels);
  const semanticKinds = [...new Set(semantic.map((stage) => stage.kind))];
  const semanticStageMetrics = Object.fromEntries(
    semanticKinds.map((kind) => {
      const stages = semantic.filter((stage) => stage.kind === kind);
      return [
        kind,
        {
          calls: stages.length,
          ...metrics(stages.map((stage) => record(stage.model.usage))),
        },
      ];
    }),
  );
  const usageReconciliation = details.map((detail) => {
    const raw = array(record(detail).llmCalls).map(record);
    const stages = semanticModels(detail).map((stage) =>
      record(stage.model.usage),
    );
    return {
      trajectoryId: record(record(detail).trajectory).id,
      rawCalls: raw.length,
      semanticCalls: stages.length,
      coverage:
        stages.length === 0
          ? "raw-only"
          : stages.length === raw.length
            ? "equal-call-count"
            : "partial-or-mismatched",
      comparisons: Object.fromEntries(
        ["promptTokens", "completionTokens", "cacheReadInputTokens"].map(
          (field) => {
            const rawUsage = totals(raw, field),
              semanticUsage = totals(stages, field);
            return [
              field,
              {
                raw: rawUsage,
                semantic: semanticUsage,
                equal:
                  stages.length === raw.length &&
                  rawUsage.missingCalls === 0 &&
                  semanticUsage.missingCalls === 0
                    ? rawUsage.totalReported === semanticUsage.totalReported
                    : null,
              },
            ];
          },
        ),
      ),
    };
  });
  return {
    semanticStageMetrics,
    usageReconciliation,
    usageAccounting:
      "Totals use raw llmCalls only. Semantic stage metrics are a separate view of overlapping calls and must not be added to raw totals.",
    modelCalls: calls.length,
    actionCalls: tools.length,
    failedActions: tools.filter((tool) => tool.success === false).length,
    discoveryCalls: tools.filter((tool) =>
      /DISCOVER_ACTIONS|DISCOVER_TOOLS|SEARCH_ACTIONS/.test(
        String(tool.actionName),
      ),
    ).length,
    successfulReadReceipts: readReceipts.length,
    readReceiptInputs: readReceipts.map((tool) => tool.parameters ?? tool.args),
    metrics: metrics(calls),
    stages: Object.fromEntries(
      stages.map((stage) => [
        stage,
        {
          calls: calls.filter(
            (call) =>
              String(call.modelType ?? call.purpose ?? "unknown") === stage,
          ).length,
          ...metrics(
            calls.filter(
              (call) =>
                String(call.modelType ?? call.purpose ?? "unknown") === stage,
            ),
          ),
        },
      ]),
    ),
    providerWireTTFT: null,
    timingEvidence:
      "HTTP wall time and recorded trajectory latency only; provider wire was not captured by this runner",
  };
}

/** Separate synchronous turn evidence from observed asynchronous extraction.
 * An absent background trajectory is unknown, never proof of zero future work. */
export function summarizePlannerObservation(details: unknown[]) {
  const foreground: unknown[] = [],
    background: unknown[] = [],
    unclassified: unknown[] = [];
  for (const detail of details) {
    const value = record(detail);
    const kinds = array(value.semanticStages).map(
      (stage) => record(stage).kind,
    );
    const calls = array(value.llmCalls).map(record);
    if (
      kinds.some((kind) =>
        ["messageHandler", "planner", "evaluation"].includes(String(kind)),
      ) ||
      calls.some((call) =>
        ["RESPONSE_HANDLER", "ACTION_PLANNER"].includes(String(call.modelType)),
      )
    ) {
      foreground.push(detail);
    } else if (
      calls.length > 0 &&
      calls.every(
        (call) =>
          call.modelType === "TEXT_SMALL" &&
          String(call.systemPrompt).includes("Evaluate the completed turn"),
      )
    ) {
      background.push(detail);
    } else unclassified.push(detail);
  }
  const summary = (items: unknown[]) =>
    items.length ? summarizePlannerTrajectories(items) : null;
  return {
    foreground: summary(foreground),
    observedBackground: summary(background),
    unclassified: summary(unclassified),
    allObserved: summarizePlannerTrajectories(details),
    foregroundCompleted:
      foreground.length > 0 &&
      foreground.every(
        (detail) => record(record(detail).trajectory).status === "completed",
      ),
    backgroundObservation:
      background.length === 0
        ? "not-observed"
        : background.every(
              (detail) =>
                record(record(detail).trajectory).status === "completed",
            )
          ? "observed-completed"
          : "observed-pending",
    futureBackgroundQuiescence: "not-established",
  };
}

export type PlannerTokenEstimate = { fresh: number; total: number };
/** Local conservative budget across both hosts; never changes provider limits. */
export function createPlannerTokenPacer(
  capacity: PlannerTokenEstimate,
  now = Date.now(),
) {
  const credit = { ...capacity };
  let updatedAt = now;
  const refill = (at: number) => {
    const elapsed = Math.max(0, at - updatedAt);
    for (const key of ["fresh", "total"] as const)
      credit[key] = Math.min(
        capacity[key],
        credit[key] + (elapsed * capacity[key]) / 60_000,
      );
    updatedAt = at;
  };
  return {
    delay(estimate: PlannerTokenEstimate, at = Date.now()) {
      refill(at);
      return Math.ceil(
        Math.max(
          0,
          ...(["fresh", "total"] as const).map(
            (key) =>
              ((Math.min(estimate[key], capacity[key]) - credit[key]) *
                60_000) /
              capacity[key],
          ),
        ),
      );
    },
    reserve(estimate: PlannerTokenEstimate, at = Date.now()) {
      refill(at);
      for (const key of ["fresh", "total"] as const)
        credit[key] -= estimate[key];
    },
    settle(
      reserved: PlannerTokenEstimate,
      actual: PlannerTokenEstimate,
      at = Date.now(),
    ) {
      refill(at);
      for (const key of ["fresh", "total"] as const)
        credit[key] = Math.min(
          capacity[key],
          credit[key] + reserved[key] - actual[key],
        );
    },
  };
}

/** Provider rejection stops the study; completed effects are never retried. */
export function plannerRateLimitEvidence(
  response: unknown,
  details: unknown[],
): boolean {
  const reply = record(response);
  if (
    reply.failureKind === "rate_limited" ||
    record(reply.terminalFailure).kind === "rate_limited" ||
    record(reply.replyFailure).kind === "rate_limited"
  )
    return true;
  return details.some((detail) =>
    array(record(detail).llmCalls).some((value) => {
      const call = record(value),
        metadata = record(call.providerMetadata);
      if (
        [
          call.status,
          call.statusCode,
          metadata.status,
          metadata.statusCode,
        ].includes(429)
      )
        return true;
      return [call.error, metadata.error].some(
        (error) =>
          typeof error === "string" &&
          /too many requests|token_quota_exceeded|tokens per minute limit|rate[ _-]?limit/i.test(
            error,
          ),
      );
    }),
  );
}

async function main() {
  // Operator stops never abort a dispatched request or replay its effects.
  let operatorStopRequested = false;
  let wakePacing: (() => void) | undefined;
  const stopAtBoundary = () => {
    operatorStopRequested = true;
    wakePacing?.();
  };
  process.on("SIGUSR1", stopAtBoundary);
  const count = Number(process.env.BENCHMARK_PAIRS ?? 30);
  const offset = Number(process.env.BENCHMARK_OFFSET ?? 0);
  if (
    !Number.isInteger(count) ||
    count < 1 ||
    !Number.isInteger(offset) ||
    offset < 0 ||
    count + offset > 30
  )
    throw new Error("Choose 1..30 fixtures within indices 0..29");
  const minimumTurnIntervalMs = Number(
    process.env.BENCHMARK_MIN_TURN_INTERVAL_MS ?? 1000,
  );
  if (!Number.isFinite(minimumTurnIntervalMs) || minimumTurnIntervalMs < 0)
    throw new Error(
      "BENCHMARK_MIN_TURN_INTERVAL_MS must be a nonnegative duration",
    );
  const tokenCapacity = {
    fresh: Number(process.env.BENCHMARK_FRESH_TOKENS_PER_MINUTE ?? 90_000),
    total: Number(process.env.BENCHMARK_TOTAL_TOKENS_PER_MINUTE ?? 400_000),
  };
  if (
    Object.values(tokenCapacity).some(
      (value) => !Number.isFinite(value) || value <= 0,
    )
  )
    throw new Error("Benchmark token pacing budgets must be positive");
  const tokenPacer = createPlannerTokenPacer(tokenCapacity);
  const estimates: Record<Variant, PlannerTokenEstimate> = {
    baseline: { fresh: 60_000, total: 150_000 },
    candidate: { fresh: 30_000, total: 70_000 },
  };
  let previousTurnStartedAt = 0;
  let rateLimited = false;
  const runId = randomUUID();
  const output = process.env.BENCHMARK_OUTPUT_DIR
    ? resolve(process.env.BENCHMARK_OUTPUT_DIR)
    : testOutputPath("planner-cache-workload", runId);
  await mkdir(output, { recursive: true });
  const origins: Record<Variant, string> = {
    baseline: process.env.BENCHMARK_BASELINE_URL ?? "http://127.0.0.1:12507",
    candidate: process.env.BENCHMARK_CANDIDATE_URL ?? "http://127.0.0.1:12707",
  };
  const tokens: Record<Variant, string | undefined> = {
    baseline: process.env.BENCHMARK_BASELINE_API_TOKEN,
    candidate: process.env.BENCHMARK_CANDIDATE_API_TOKEN,
  };
  for (const origin of Object.values(origins)) {
    const url = new URL(origin);
    if (
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error(
        "Benchmark endpoints must be credential-free loopback origins",
      );
  }
  const rows: Json[] = [];
  const persist = (status: string) =>
    writeFile(
      join(output, "report.json"),
      `${JSON.stringify(
        {
          runId,
          status,
          operatorStopRequested,
          origins,
          baselineRevision: process.env.BENCHMARK_BASELINE_REVISION ?? null,
          candidateRevision: process.env.BENCHMARK_CANDIDATE_REVISION ?? null,
          design:
            "Paired synthetic fixtures, fresh empty conversation per attempt, alternating order; no cache isolation; complete room-scoped trajectories and filesystem readbacks",
          limitations:
            "Multiline fixtures test ordinary requested text: recovery is demonstrated only when failedActions > 0 and final validation succeeds. No wire TTFT. Foreground metrics are primary. Background is an end-of-study observation, not proof of future quiescence; absent background is null. Existing host background work may affect latency.",
          pacing: {
            minimumTurnIntervalMs,
            tokenCapacityPerMinute: tokenCapacity,
            method:
              "Conservative shared continuous token bucket; reserve worst observed per variant plus 15K fresh/25K total background headroom; post-turn reconcile. One unexpectedly large turn can still exceed upstream reservation limits and must stop the run.",
            scope:
              "Shared across baseline and candidate; outside HTTP wall timer",
            rateLimitPolicy:
              "Stop on provider rejection; preserve effects and attempts; no automatic retry",
          },
          requestedPairs: count,
          offset,
          rows,
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
  const request = async (variant: Variant, route: string, body?: unknown) => {
    const response = await fetch(`${origins[variant]}${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        ...(tokens[variant]
          ? { Authorization: `Bearer ${tokens[variant]}` }
          : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      // Bun's socket idle timeout is independent of the complete-turn deadline.
      // Admission-paced turns may be silent longer; keep one explicit deadline.
      timeout: false,
      signal: AbortSignal.timeout(
        Number(process.env.BENCHMARK_TURN_TIMEOUT_MS ?? 300_000),
      ),
    });
    const text = await response.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      data = { rawResponse: text };
    }
    if (!response.ok)
      throw new Error(
        `HTTP ${response.status} for ${route}: ${JSON.stringify(data)}`,
      );
    return data;
  };
  const trajectories = async (variant: Variant, roomId: string) => {
    const listed: Json[] = [];
    for (let page = 0; ; ) {
      const result = record(
        await request(
          variant,
          `/api/trajectories?roomId=${encodeURIComponent(roomId)}&limit=500&offset=${page}`,
        ),
      );
      const items = array(result.trajectories).map(record);
      listed.push(...items);
      if (typeof result.total !== "number")
        throw new Error("Trajectory list omitted total");
      page += items.length;
      if (page >= result.total) break;
      if (!items.length)
        throw new Error("Trajectory pagination made no progress");
    }
    return Promise.all(
      listed.map((item) =>
        request(
          variant,
          `/api/trajectories/${encodeURIComponent(String(item.id))}?includePayloads=1`,
        ),
      ),
    );
  };
  await persist("running");
  study: for (let index = offset; index < offset + count; index++) {
    const variants: Variant[] =
      index % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"];
    for (const variant of variants) {
      if (operatorStopRequested) break study;
      const workspace = join(output, "fixtures", String(index), variant);
      await mkdir(workspace, { recursive: true });
      const fixture = plannerWorkloadFixture(index, workspace);
      for (const [name, content] of Object.entries(fixture.filesBefore))
        await writeFile(join(workspace, name), content);
      const row: Json = {
        index,
        variant,
        fixture,
        workspace,
        status: "running",
      };
      rows.push(row);
      let reserved: PlannerTokenEstimate | null = null;
      await persist("running");
      try {
        const conversation = record(
          record(
            await request(variant, "/api/conversations", {
              title: `Benchmark ${runId} ${fixture.id} ${variant}`,
              includeGreeting: false,
            }),
          ).conversation,
        );
        if (
          typeof conversation.id !== "string" ||
          typeof conversation.roomId !== "string"
        )
          throw new Error("Conversation missing id or roomId");
        row.conversation = conversation;
        const delayMs = Math.max(
          0,
          minimumTurnIntervalMs - (Date.now() - previousTurnStartedAt),
          tokenPacer.delay(estimates[variant]),
        );
        row.pacingDelayMs = delayMs;
        if (delayMs > 0) {
          await persist("pacing");
          await new Promise<void>((resolve) => {
            const finish = () => {
              clearTimeout(timer);
              wakePacing = undefined;
              resolve();
            };
            const timer = setTimeout(finish, delayMs);
            wakePacing = finish;
            if (operatorStopRequested) finish();
          });
        }
        if (operatorStopRequested) {
          row.status = "interrupted";
          row.dispatched = false;
          row.interruption = "Operator stopped before message dispatch";
          break study;
        }
        reserved = { ...estimates[variant] };
        row.tokenReservation = reserved;
        tokenPacer.reserve(reserved);
        previousTurnStartedAt = Date.now();
        const started = performance.now();
        row.dispatched = true;
        const response = await request(
          variant,
          `/api/conversations/${conversation.id}/messages`,
          {
            text: fixture.prompt,
            source: "client_chat",
            channelType: "DM",
            clientMessageId: `benchmark:${runId}:${index}:${variant}`,
          },
        );
        row.httpWallMs = performance.now() - started;
        row.response = response;
        row.validation = await validatePlannerFixture(
          fixture,
          workspace,
          response,
        );
        let details: unknown[] = [],
          previous = "",
          settled = false;
        const settleDeadline = performance.now() + 60_000;
        while (performance.now() < settleDeadline) {
          details = await trajectories(variant, conversation.roomId);
          const signature = JSON.stringify(details);
          if (
            details.length &&
            signature === previous &&
            details.every(
              (detail) => record(record(detail).trajectory).status !== "active",
            )
          ) {
            settled = true;
            break;
          }
          previous = signature;
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        row.initialExportCapturedAt = new Date().toISOString();
        row.initialExportStableAcrossPolls = settled;
        row.initialExportScope =
          "Initial room snapshot after a one-second unchanged interval; not proof of asynchronous background completion";
        row.trajectoryFile = join(
          output,
          `${fixture.id}-${variant}-trajectories-initial.json`,
        );
        await writeFile(
          String(row.trajectoryFile),
          `${JSON.stringify(details, null, 2)}\n`,
          { mode: 0o600 },
        );
        const observation = summarizePlannerObservation(details);
        const summary = observation.foreground;
        row.initialObservation = observation;
        row.rateLimitObserved = plannerRateLimitEvidence(response, details);
        if (row.rateLimitObserved) rateLimited = true;
        row.summaryScope = "foreground-only";
        row.summary = summary;
        row.readbackCoverage = Object.keys(fixture.filesAfter).map((name) => ({
          name,
          evidenced:
            summary?.readReceiptInputs.some((input) =>
              JSON.stringify(input).includes(name),
            ) ?? false,
        }));
        row.status =
          record(row.validation).passed &&
          observation.foregroundCompleted &&
          array(row.readbackCoverage).every(
            (item) => record(item).evidenced === true,
          )
            ? "passed"
            : "failed";
      } catch (error) {
        row.status = "error";
        if (/HTTP 429/.test(String(error))) {
          row.rateLimitObserved = true;
          rateLimited = true;
        }
        row.error = error instanceof Error ? error.message : String(error);
        if (typeof record(row.conversation).roomId === "string") {
          try {
            row.partialTrajectories = await trajectories(
              variant,
              String(record(row.conversation).roomId),
            );
            if (
              plannerRateLimitEvidence(
                row.response,
                array(row.partialTrajectories),
              )
            ) {
              row.rateLimitObserved = true;
              rateLimited = true;
            }
          } catch (captureError) {
            row.captureError =
              captureError instanceof Error
                ? captureError.message
                : String(captureError);
          }
        }
      }
      if (reserved) {
        const observed = record(
          record(record(row.initialObservation).allObserved).metrics,
        );
        const readMetric = (name: string) => {
          const value = record(observed[name]);
          return value.missingCalls === 0 &&
            typeof value.totalReported === "number"
            ? value.totalReported
            : null;
        };
        const input = readMetric("promptTokens"),
          outputTokens = readMetric("completionTokens");
        if (input !== null && outputTokens !== null) {
          const actual = {
            fresh:
              (readMetric("freshPromptTokens") ?? input) +
              outputTokens +
              15_000,
            total: input + outputTokens + 25_000,
          };
          tokenPacer.settle(reserved, actual);
          estimates[variant] = {
            fresh: Math.max(estimates[variant].fresh, actual.fresh),
            total: Math.max(estimates[variant].total, actual.total),
          };
          row.pacingChargedTokens = actual;
        }
      }
      await persist("running");
      process.stderr.write(
        `[planner-workload] ${index + 1}/30 ${variant}: ${row.status}\n`,
      );
      if (rateLimited || operatorStopRequested) break study;
    }
  }
  // Refresh every synthetic room after the study: background workers may not
  // have started during the initial quiet interval. Preserve both exports.
  await persist("observing-background");
  const backgroundDeadline = performance.now() + 30_000;
  let pending = rows.filter(
    (row) =>
      row.dispatched === true &&
      typeof record(row.conversation).roomId === "string",
  );
  while (pending.length) {
    const retry: Json[] = [];
    for (const row of pending) {
      try {
        const details = await trajectories(
          row.variant as Variant,
          String(record(row.conversation).roomId),
        );
        const observation = summarizePlannerObservation(details);
        const file = join(
          output,
          `${record(row.fixture).id}-${row.variant}-trajectories-final.json`,
        );
        await writeFile(file, `${JSON.stringify(details, null, 2)}\n`, {
          mode: 0o600,
        });
        delete row.finalObservationError;
        row.finalTrajectoryFile = file;
        row.finalObservationScope =
          "End-of-study room re-export with up to 30 seconds of additional observation for missing background work; future quiescence is not established";
        row.finalObservationCapturedAt = new Date().toISOString();
        row.finalObservation = observation;
        if (plannerRateLimitEvidence(row.response, details)) {
          row.rateLimitObserved = true;
          rateLimited = true;
        }
        row.summary = observation.foreground;
        row.observedBackgroundSummary = observation.observedBackground;
        if (observation.backgroundObservation !== "observed-completed")
          retry.push(row);
      } catch (error) {
        row.finalObservationError =
          error instanceof Error ? error.message : String(error);
        row.observedBackgroundSummary = null;
        retry.push(row);
      }
    }
    await persist("observing-background");
    if (rateLimited || !retry.length || performance.now() >= backgroundDeadline)
      break;
    pending = retry;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  await persist(
    rateLimited
      ? "interrupted-provider-rate-limit"
      : operatorStopRequested
        ? "interrupted-operator"
        : rows.every((row) => row.status === "passed")
          ? "complete"
          : "completed-with-failures",
  );
  process.stdout.write(`${join(output, "report.json")}\n`);
  process.removeListener("SIGUSR1", stopAtBoundary);
  if (
    rateLimited ||
    operatorStopRequested ||
    rows.some((row) => row.status !== "passed")
  )
    process.exitCode = 1;
}
if (import.meta.main)
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
