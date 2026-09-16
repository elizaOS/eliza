/** Exercises published benchmark receipts against real HTTP observations completed during owned shutdown. */
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import {
  measuredProviderFetch,
  type ProviderWireEvidence,
} from "../scripts/cerebras-chat-flow-experiment";
import {
  finalizeBenchmarkReport,
  finalizeBenchmarkWireEvidence,
} from "../scripts/cerebras-chat-flow-latency";

describe("final benchmark wire accounting", () => {
  it.each([
    { invalidCache: false, failedShutdown: false },
    { invalidCache: true, failedShutdown: false },
    { invalidCache: false, failedShutdown: true },
    { invalidCache: true, failedShutdown: true },
  ])(
    "publishes settled HTTP evidence with cache=$invalidCache shutdown=$failedShutdown",
    async ({ invalidCache, failedShutdown }) => {
      let received = 0;
      const server = createServer((_request, response) => {
        received += 1;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ completed: true }));
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Missing HTTP listener address");
      const endpoint = `http://127.0.0.1:${address.port}/v1`;
      const evidence: ProviderWireEvidence[] = [];
      const measured = measuredProviderFetch(
        fetch,
        { text: endpoint, embedding: endpoint },
        () => null,
        (wire) => evidence.push(wire),
      );
      const request = {
        model: "local-test",
        messages: [
          { role: "user", content: "complete shutdown request ".repeat(1000) },
        ],
        ...(invalidCache
          ? { prompt_cache_key: "forbidden-in-automatic-mode" }
          : {}),
      };
      const report = {
        status: "success" as const,
        wireEvidence: evidence,
        wireAttemptStats: { total: 0 },
        originalResult: "complete measured reply",
      };
      let published = "";
      try {
        const finalizing = finalizeBenchmarkReport(
          report,
          async () => {
            const response = await measured(`${endpoint}/chat/completions`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(request),
            });
            await response.text();
            if (failedShutdown)
              throw new Error(
                "owned shutdown rejected after completed request",
              );
          },
          async (result) => {
            published = JSON.stringify(result);
          },
          (result) =>
            finalizeBenchmarkWireEvidence(result, evidence, "automatic", false),
        );
        if (failedShutdown || invalidCache) {
          await expect(finalizing).rejects.toMatchObject({
            code: failedShutdown
              ? "BENCHMARK_TEARDOWN_FAILED"
              : "BENCHMARK_FINALIZATION_FAILED",
          });
        } else await finalizing;
        const result = JSON.parse(published);
        expect(received).toBe(1);
        expect(result.wireAttemptStats.total).toBe(received);
        expect(
          result.wireEvidence.map((wire: ProviderWireEvidence) => wire.request),
        ).toEqual([request]);
        expect(result.originalResult).toBe(report.originalResult);
        expect(result.status).toBe(
          failedShutdown || invalidCache ? "failed" : "success",
        );
        expect(result.teardown.status).toBe(
          failedShutdown ? "failed" : "success",
        );
        expect(result.finalization.status).toBe(
          invalidCache ? "failed" : "success",
        );
        expect(result.cacheExperiment.validatedWireRequests).toBe(
          invalidCache ? null : received,
        );
        if (invalidCache)
          expect(result.finalization.error).toContain(
            "Automatic cache experiment was overwritten",
          );
        if (failedShutdown)
          expect(result.teardown.error).toContain("owned shutdown rejected");
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    },
  );
});
