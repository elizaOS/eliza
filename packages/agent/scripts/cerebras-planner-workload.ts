#!/usr/bin/env bun
/** Paired real-host planner acceptance. Full room-scoped trajectories are retained;
 * HTTP timing is not provider wire TTFT or a cache-isolation experiment. */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

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

async function main() {
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
          origins,
          baselineRevision: process.env.BENCHMARK_BASELINE_REVISION ?? null,
          candidateRevision: process.env.BENCHMARK_CANDIDATE_REVISION ?? null,
          design:
            "Paired synthetic fixtures, fresh empty conversation per attempt, alternating order; no cache isolation; complete room-scoped trajectories and filesystem readbacks",
          limitations:
            "Multiline fixtures test ordinary requested text: recovery is demonstrated only when failedActions > 0 and final validation succeeds. No wire TTFT. Existing host background work may affect latency.",
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
  for (let index = offset; index < offset + count; index++) {
    const variants: Variant[] =
      index % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"];
    for (const variant of variants) {
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
        const started = performance.now();
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
        row.trajectoriesSettled = settled;
        row.trajectoryFile = join(
          output,
          `${fixture.id}-${variant}-trajectories.json`,
        );
        await writeFile(
          String(row.trajectoryFile),
          `${JSON.stringify(details, null, 2)}\n`,
          { mode: 0o600 },
        );
        const summary = summarizePlannerTrajectories(details);
        row.summary = summary;
        row.readbackCoverage = Object.keys(fixture.filesAfter).map((name) => ({
          name,
          evidenced: summary.readReceiptInputs.some((input) =>
            JSON.stringify(input).includes(name),
          ),
        }));
        row.status =
          record(row.validation).passed &&
          settled &&
          array(row.readbackCoverage).every(
            (item) => record(item).evidenced === true,
          )
            ? "passed"
            : "failed";
      } catch (error) {
        row.status = "error";
        row.error = error instanceof Error ? error.message : String(error);
        if (typeof record(row.conversation).roomId === "string") {
          try {
            row.partialTrajectories = await trajectories(
              variant,
              String(record(row.conversation).roomId),
            );
          } catch (captureError) {
            row.captureError =
              captureError instanceof Error
                ? captureError.message
                : String(captureError);
          }
        }
      }
      await persist("running");
      process.stderr.write(
        `[planner-workload] ${index + 1}/30 ${variant}: ${row.status}\n`,
      );
    }
  }
  await persist(
    rows.every((row) => row.status === "passed")
      ? "complete"
      : "completed-with-failures",
  );
  process.stdout.write(`${join(output, "report.json")}\n`);
  if (rows.some((row) => row.status !== "passed")) process.exitCode = 1;
}
if (import.meta.main)
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
