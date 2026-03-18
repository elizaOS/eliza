import { ElizaClient } from "@elizaos/app-core/api";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

describe("ElizaClient training endpoints", () => {
  const originalFetch = globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => {
        return new Response(
          JSON.stringify({
            ok: true,
            trajectories: [],
            datasets: [],
            jobs: [],
            models: [],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      },
    );
    globalThis.fetch = fetchMock as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("calls training status and list endpoints", async () => {
    const client = new ElizaClient("http://localhost:2138", "token");

    await client.getTrainingStatus();
    await client.listTrainingTrajectories({ limit: 25, offset: 10 });
    await client.listTrainingDatasets();
    await client.listTrainingJobs();
    await client.listTrainingModels();

    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls).toContain("http://localhost:2138/api/training/status");
    expect(urls).toContain(
      "http://localhost:2138/api/training/trajectories?limit=25&offset=10",
    );
    expect(urls).toContain("http://localhost:2138/api/training/datasets");
    expect(urls).toContain("http://localhost:2138/api/training/jobs");
    expect(urls).toContain("http://localhost:2138/api/training/models");
  });

  test("calls training mutation endpoints with expected methods and paths", async () => {
    const client = new ElizaClient("http://localhost:2138", "token");

    await client.buildTrainingDataset({
      limit: 120,
      minLlmCallsPerTrajectory: 2,
    });
    await client.startTrainingJob({
      datasetId: "dataset-1",
      backend: "cpu",
      iterations: 10,
      batchSize: 4,
      learningRate: 0.0001,
    });
    await client.getTrainingJob("job-1");
    await client.cancelTrainingJob("job-1");
    await client.importTrainingModelToOllama("model-1", {
      modelName: "eliza-ft-model",
      baseModel: "qwen2.5:7b-instruct",
      ollamaUrl: "http://localhost:11434",
    });
    await client.activateTrainingModel("model-1", "ollama/eliza-ft-model");
    await client.benchmarkTrainingModel("model-1");

    const calls = fetchMock.mock.calls.map((call) => ({
      url: String(call[0]),
      method: (call[1]?.method as string | undefined) ?? "GET",
      body: call[1]?.body as string | undefined,
    }));

    expect(calls).toContainEqual({
      url: "http://localhost:2138/api/training/datasets/build",
      method: "POST",
      body: JSON.stringify({ limit: 120, minLlmCallsPerTrajectory: 2 }),
    });
    expect(calls).toContainEqual({
      url: "http://localhost:2138/api/training/jobs",
      method: "POST",
      body: JSON.stringify({
        datasetId: "dataset-1",
        backend: "cpu",
        iterations: 10,
        batchSize: 4,
        learningRate: 0.0001,
      }),
    });
    expect(calls).toContainEqual({
      url: "http://localhost:2138/api/training/jobs/job-1",
      method: "GET",
      body: undefined,
    });
    expect(calls).toContainEqual({
      url: "http://localhost:2138/api/training/jobs/job-1/cancel",
      method: "POST",
      body: undefined,
    });
    expect(calls).toContainEqual({
      url: "http://localhost:2138/api/training/models/model-1/import-ollama",
      method: "POST",
      body: JSON.stringify({
        modelName: "eliza-ft-model",
        baseModel: "qwen2.5:7b-instruct",
        ollamaUrl: "http://localhost:11434",
      }),
    });
    expect(calls).toContainEqual({
      url: "http://localhost:2138/api/training/models/model-1/activate",
      method: "POST",
      body: JSON.stringify({ providerModel: "ollama/eliza-ft-model" }),
    });
    expect(calls).toContainEqual({
      url: "http://localhost:2138/api/training/models/model-1/benchmark",
      method: "POST",
      body: undefined,
    });
  });
});
