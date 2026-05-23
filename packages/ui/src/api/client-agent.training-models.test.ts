import { describe, expect, it, vi } from "vitest";
import "./client-agent";
import { ElizaClient } from "./client-base";

describe("ElizaClient training model listing", () => {
  it("returns legacy training models when they are available", async () => {
    const client = new ElizaClient("http://agent.example:31337", "token");
    const fetch = vi.fn().mockResolvedValue({
      models: [
        {
          id: "trained-0_8b",
          createdAt: "2026-05-23T00:00:00.000Z",
          jobId: "job-1",
          outputDir: "/runs/job-1",
          modelPath: "/runs/job-1/model.gguf",
          adapterPath: null,
          sourceModel: "eliza-1-0_8b-base",
          backend: "cuda",
          ollamaModel: null,
          active: false,
          benchmark: {
            status: "not_run",
            lastRunAt: null,
            output: null,
          },
        },
      ],
    });
    client.fetch = fetch;

    await expect(client.listTrainingModels()).resolves.toMatchObject({
      models: [{ id: "trained-0_8b" }],
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("/api/training/models");
  });

  it("falls back to Vast registry models when the legacy list is empty", async () => {
    const client = new ElizaClient("http://agent.example:31337", "token");
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ models: [] })
      .mockResolvedValueOnce({
        loaded_at: "2026-05-23T00:00:00.000Z",
        entries: [
          {
            short_name: "eliza-1-0_8b",
            entry: {
              eliza_short_name: "eliza-1-0_8b",
              eliza_repo_id: "elizaos/eliza-1-0_8b",
              gguf_repo_id: "elizaos/eliza-1-0_8b-gguf",
              base_hf_id: "NousResearch/Hermes-3-Llama-3.1-8B",
              tier: "0_8b",
              inference_max_context: 128000,
            },
          },
        ],
      });
    client.fetch = fetch;

    await expect(client.listTrainingModels()).resolves.toEqual({
      models: [
        {
          id: "eliza-1-0_8b",
          createdAt: "2026-05-23T00:00:00.000Z",
          jobId: "vast-registry:eliza-1-0_8b",
          outputDir: "elizaos/eliza-1-0_8b-gguf",
          modelPath: "elizaos/eliza-1-0_8b-gguf",
          adapterPath: null,
          sourceModel: "NousResearch/Hermes-3-Llama-3.1-8B",
          backend: "cuda",
          ollamaModel: null,
          active: false,
          benchmark: {
            status: "not_run",
            lastRunAt: null,
            output: "Eliza-1 0_8b registry entry",
          },
        },
      ],
    });
    expect(fetch).toHaveBeenNthCalledWith(1, "/api/training/models");
    expect(fetch).toHaveBeenNthCalledWith(2, "/api/training/vast/models");
  });

  it("keeps the legacy empty list when the Vast registry is unavailable", async () => {
    const client = new ElizaClient("http://agent.example:31337", "token");
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ models: [] })
      .mockRejectedValueOnce(new Error("registry unavailable"));
    client.fetch = fetch;

    await expect(client.listTrainingModels()).resolves.toEqual({
      models: [],
    });
  });
});

describe("ElizaClient training collection listing", () => {
  it("passes the custom collection root through to the training API", async () => {
    const client = new ElizaClient("http://agent.example:31337", "token");
    const fetch = vi.fn().mockResolvedValue({
      root: "/tmp/eliza-training/collections",
      indexJsonPath: "/tmp/eliza-training/collections/collection-index.json",
      indexHtmlPath: "/tmp/eliza-training/collections/collection-index.html",
      collections: [],
    });
    client.fetch = fetch;

    await expect(
      client.listTrainingCollections({
        limit: 5,
        root: "/tmp/eliza training/collections",
      }),
    ).resolves.toMatchObject({
      root: "/tmp/eliza-training/collections",
      collections: [],
    });
    expect(fetch).toHaveBeenCalledWith(
      "/api/training/collections?limit=5&root=%2Ftmp%2Feliza+training%2Fcollections",
    );
  });
});
