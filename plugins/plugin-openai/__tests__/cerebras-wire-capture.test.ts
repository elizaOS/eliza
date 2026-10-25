/** Verifies that live-wire evidence preserves transport bytes while credentials stay out of artifacts. */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  captureReplayAttempt,
  type ReplayAttempt,
  validateReplayStream,
} from "../../../packages/benchmarks/scripts/eliza-benchmark-scripts/agent/cerebras-cache-wire-replay.ts";

import {
  measuredProviderFetch,
  type ProviderWireEvidence,
} from "../../../packages/benchmarks/scripts/eliza-benchmark-scripts/agent/cerebras-chat-flow-experiment.ts";
import {
  startCerebrasWireCapture,
  writeCerebrasEvidenceArtifacts,
} from "./helpers/cerebras-wire-capture";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(
    cleanups
      .splice(0)
      .reverse()
      .map((cleanup) => cleanup())
  );
});

function startFixtureServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = createServer(handler);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("fixture server did not bind a TCP port"));
        return;
      }
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () =>
          new Promise<void>((closeResolve, closeReject) => {
            server.close((error) => {
              if (error) closeReject(error);
              else closeResolve();
            });
          }),
      });
    });
  });
}

describe("Cerebras wire evidence", () => {
  it("forwards authorization but records only a redacted header and exact body bytes", async () => {
    const secret = "csk-unit-secret";
    let upstreamAuthorization: string | undefined;
    const fixture = await startFixtureServer(async (request, response) => {
      upstreamAuthorization = request.headers.authorization;
      for await (const _chunk of request) {
        // Drain the real request before responding so the fixture exercises forwarding.
      }
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({ id: "completion-1", choices: [{ message: { content: "ok" } }] })
      );
    });
    cleanups.push(fixture.close);
    const capture = await startCerebrasWireCapture(fixture.baseUrl);
    cleanups.push(capture.close);

    const requestBody = JSON.stringify({
      model: "gpt-oss-120b",
      messages: [{ role: "user", content: "hi" }],
    });
    const response = await fetch(`${capture.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${secret}`,
        "content-type": "application/json",
      },
      body: requestBody,
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ id: "completion-1" });

    expect(upstreamAuthorization).toBe(`Bearer ${secret}`);
    expect(capture.calls).toHaveLength(1);
    const [call] = capture.calls;
    expect(call.request?.body.utf8).toBe(requestBody);
    expect(call.request?.headers).toContainEqual({ name: "authorization", value: "[REDACTED]" });
    expect(call.response?.body?.utf8).toContain('"completion-1"');
    expect(call.transport.outcome).toBe("complete");
  });

  it("writes redacted wire JSON and append-only trajectory JSONL", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cerebras-evidence-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const secret = "csk-artifact-secret";

    const paths = await writeCerebrasEvidenceArtifacts({
      artifactDirectory: directory,
      calls: [],
      trajectories: [
        {
          provider: "cerebras",
          model: "gpt-oss-120b",
          response: `safe response accidentally followed by ${secret}`,
        },
      ],
      receipts: [{ authorization: `Bearer ${secret}` }],
      secrets: [secret],
      metadata: { headSha: "unit-head" },
    });

    const [wire, trajectory] = await Promise.all([
      readFile(paths.wirePath, "utf8"),
      readFile(paths.trajectoryPath, "utf8"),
    ]);
    expect(wire).not.toContain(secret);
    expect(trajectory).not.toContain(secret);
    expect(wire).toContain("[REDACTED]");
    expect(trajectory).toContain("[REDACTED]");
    expect(JSON.parse(trajectory.trim())).toMatchObject({
      provider: "cerebras",
      model: "gpt-oss-120b",
    });
  });

  it("captures upstream SSE chunks without coalescing their evidence records", async () => {
    const fixture = await startFixtureServer((_request, response) => {
      response.setHeader("content-type", "text/event-stream");
      response.write('data: {"choices":[{"delta":{"content":"A"}}]}\n\n');
      setTimeout(() => {
        response.end("data: [DONE]\n\n");
      }, 10);
    });
    cleanups.push(fixture.close);
    const capture = await startCerebrasWireCapture(fixture.baseUrl);
    cleanups.push(capture.close);

    const response = await fetch(`${capture.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stream: true }),
    });
    const body = await response.text();

    expect(body).toContain('"content":"A"');
    expect(body).toContain("[DONE]");
    expect(capture.calls[0].response?.chunks.length).toBeGreaterThanOrEqual(2);
    expect(capture.calls[0].response?.body?.utf8).toBe(body);
  });

  it("applies a disconnect fault across the requested number of attempts", async () => {
    const fixture = await startFixtureServer((_request, response) => {
      response.setHeader("content-type", "text/event-stream");
      response.write('data: {"choices":[{"delta":{"content":"A"}}]}\n\n');
      response.end("data: [DONE]\n\n");
    });
    cleanups.push(fixture.close);
    const capture = await startCerebrasWireCapture(fixture.baseUrl);
    cleanups.push(capture.close);
    capture.armFault({ kind: "disconnect-after-first-response-chunk", attempts: 2 });

    const consume = async () => {
      const response = await fetch(`${capture.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ stream: true }),
      });
      return response.text();
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      const [outcome] = await Promise.allSettled([consume()]);
      if (outcome.status === "fulfilled") expect(outcome.value).not.toContain("[DONE]");
      else expect(outcome.reason).toBeInstanceOf(Error);
    }
    await expect(consume()).resolves.toContain("[DONE]");

    expect(capture.calls.slice(0, 2)).toHaveLength(2);
    for (const call of capture.calls.slice(0, 2)) {
      expect(call.fault).toEqual({
        kind: "disconnect-after-first-response-chunk",
        triggered: true,
      });
      expect(call.transport.outcome).toBe("injected-disconnect");
      expect(call.response?.chunks).toHaveLength(1);
    }
    expect(capture.calls[2].transport.outcome).toBe("complete");
  });
});

describe("runtime benchmark wire analytics", () => {
  it("hashes complete SDK segments and exact UTF-8 prefixes without consuming the response", async () => {
    const fixture = await startFixtureServer(async (request, response) => {
      for await (const _chunk of request) {
        /* drain real HTTP input */
      }
      response.setHeader("content-type", "application/json");
      response.end('{"ok":true}');
    });
    cleanups.push(fixture.close);
    const evidence: ProviderWireEvidence[] = [];
    let stage = "RESPONSE_HANDLER";
    const measured = measuredProviderFetch(
      fetch,
      { text: fixture.baseUrl, embedding: fixture.baseUrl },
      () => ({ phase: "sample", proof: "prefix", stage }),
      (wire) => evidence.push(wire)
    );
    const bodies = ["first", "second"].map((text) =>
      JSON.stringify({
        model: "fixture",
        messages: [
          { role: "system", content: "Complete 🦊 instructions" },
          { role: "user", content: text },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "READ",
              parameters: { type: "object", properties: { path: { type: "string" } } },
            },
          },
        ],
      })
    );
    for (const body of bodies) {
      const response = await measured(`${fixture.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: "Bearer synthetic-wire-secret",
          "content-type": "application/json",
        },
        body,
      });
      expect(await response.json()).toEqual({ ok: true });
      stage = "PLANNER";
    }
    expect(evidence.map((wire) => wire.requestBodyText)).toEqual(bodies);
    expect(evidence[0].requestShape?.system).toEqual(evidence[1].requestShape?.system);
    expect(evidence[0].requestShape?.tools).toEqual(evidence[1].requestShape?.tools);
    expect(evidence[0].requestShape?.messages.sha256).not.toBe(
      evidence[1].requestShape?.messages.sha256
    );
    const bytes = bodies.map((body) => Buffer.from(body));
    let shared = 0;
    while (bytes[0][shared] === bytes[1][shared]) shared++;
    expect(evidence[1].requestShape?.previousRequest?.commonPrefixBytes).toBe(shared);
    expect(evidence[1].sameStageRequestShape?.previousRequest).toBeNull();
    expect(JSON.stringify(evidence)).not.toContain("synthetic-wire-secret");
  });

  it("records provider TTFT, fresh/cache/reasoning usage and complete SSE on the existing replay path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cerebras-replay-analytics-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const file = join(directory, "wire.json");
    const usage = {
      prompt_tokens: 100,
      completion_tokens: 9,
      prompt_tokens_details: { cached_tokens: 20 },
      completion_tokens_details: { reasoning_tokens: 3 },
    };
    let wireUsage: unknown = usage;
    const fixture = await startFixtureServer(async (request, response) => {
      for await (const _chunk of request) {
        /* drain real HTTP input */
      }
      response.setHeader("content-type", "text/event-stream");
      response.write('data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n');
      setTimeout(() => {
        response.write('data: {"choices":[{"delta":{"reasoning_content":"check"}}]}\n\n');
        setTimeout(
          () =>
            response.end(
              `data: {"choices":[{"delta":{"content":"42"},"finish_reason":"stop"}],"usage":${JSON.stringify(wireUsage)}}\n\ndata: [DONE]\n\n`
            ),
          10
        );
      }, 10);
    });
    cleanups.push(fixture.close);
    const rows: ReplayAttempt[] = [];
    const response = await captureReplayAttempt({
      endpoint: `${fixture.baseUrl}/chat/completions`,
      apiKey: "synthetic-replay-secret",
      row: {
        index: 0,
        order: 0,
        mode: "automatic",
        attempt: 1,
        originalContext: { stage: "PLANNER" },
        request: {
          model: "fixture",
          messages: [{ role: "user", content: "Keep complete 🦊" }],
          stream: true,
        },
      },
      rows,
      persist: () => writeFile(file, JSON.stringify(rows)),
    });
    expect(validateReplayStream(response.rawResponse).usage).toEqual(usage);
    expect(rows[0].streamTelemetry?.usage).toEqual({
      inputTokens: 100,
      cachedInputTokens: 20,
      freshInputTokens: 80,
      outputTokens: 9,
      reasoningTokens: 3,
    });
    expect(rows[0].streamTelemetry?.firstTokenMs).toBe(rows[0].streamTelemetry?.firstReasoningMs);
    expect(rows[0].streamTelemetry?.firstVisibleTextMs).toBeGreaterThan(
      rows[0].streamTelemetry?.firstTokenMs ?? 0
    );
    expect(rows[0].streamTelemetry?.parseErrors).toBe(0);
    const stored = await readFile(file, "utf8");
    expect(JSON.parse(stored)[0].rawResponse).toBe(response.rawResponse);
    expect(stored).not.toContain("synthetic-replay-secret");
    wireUsage = { prompt_tokens: 100, completion_tokens: 9 };
    await captureReplayAttempt({
      endpoint: `${fixture.baseUrl}/chat/completions`,
      apiKey: "synthetic-replay-secret",
      row: {
        index: 1,
        order: 0,
        mode: "automatic",
        attempt: 1,
        originalContext: { stage: "PLANNER" },
        request: { model: "fixture", stream: true },
      },
      rows,
      persist: () => writeFile(file, JSON.stringify(rows)),
    });
    expect(rows[1].streamTelemetry?.usage).toEqual({
      inputTokens: 100,
      cachedInputTokens: null,
      freshInputTokens: null,
      outputTokens: 9,
      reasoningTokens: null,
    });
  });
});
