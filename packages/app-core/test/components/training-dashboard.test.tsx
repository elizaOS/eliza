import { describe, it, expect } from "vitest";
import type {
  TrainingJob,
  TrainingJobDetail,
  TrainingModel,
  InferenceEndpoint,
  InferenceStats,
  CreateJobRequest,
  Checkpoint,
  ProgressEntry,
} from "../../src/components/training/types";

describe("Training Types", () => {
  it("TrainingJob type is defined", () => {
    const job: TrainingJob = {
      id: "test",
      run_name: "test-run",
      registry_key: "test-model",
      status: "running",
      started_at: "2024-05-04T10:00:00Z",
      last_step: 100,
      last_format_ok: true,
      last_content_ok: true,
    };
    expect(job.id).toBe("test");
  });

  it("TrainingJobDetail type is defined", () => {
    const detail: TrainingJobDetail = {
      id: "test",
      run_name: "test-run",
      registry_key: "test-model",
      status: "running",
      started_at: "2024-05-04T10:00:00Z",
      last_step: 100,
      last_format_ok: true,
      last_content_ok: true,
      checkpoints: [],
      progress: [],
    };
    expect(detail.checkpoints).toEqual([]);
  });

  it("TrainingModel type is defined", () => {
    const model: TrainingModel = {
      short_name: "test",
      base_repo_id: "repo/model",
      gguf_repo_id: "repo/gguf",
      tier: "base",
      max_context: 4096,
      recommended_gpu: "A100",
    };
    expect(model.short_name).toBe("test");
  });

  it("InferenceEndpoint type is defined", () => {
    const endpoint: InferenceEndpoint = {
      id: "test",
      label: "Test",
      base_url: "http://localhost:5000",
      model: "llama-7b",
    };
    expect(endpoint.id).toBe("test");
  });

  it("InferenceStats type is defined", () => {
    const stats: InferenceStats = {
      p50_tps: 50,
      p95_tps: 100,
      p50_tpot_ms: 20,
      p95_tpot_ms: 40,
      kv_usage_pct: 50,
      peak_vram_mb: 8000,
      spec_decode_accept_rate: 75,
      apc_hit_rate: 80,
    };
    expect(stats.p50_tps).toBe(50);
  });

  it("CreateJobRequest type is defined", () => {
    const request: CreateJobRequest = {
      registry_key: "test-model",
      epochs: 3,
      run_name: "test-run",
    };
    expect(request.registry_key).toBe("test-model");
    expect(request.epochs).toBe(3);
  });

  it("Checkpoint type is defined", () => {
    const checkpoint: Checkpoint = {
      step: 1000,
      pulled_at: "2024-05-04T10:00:00Z",
      size_mb: 5000,
    };
    expect(checkpoint.step).toBe(1000);
  });

  it("ProgressEntry type is defined", () => {
    const progress: ProgressEntry = {
      step: 100,
      format_ok: true,
      content_ok: true,
      tokens_per_sec: 50,
      evaluated_at: "2024-05-04T10:00:00Z",
    };
    expect(progress.step).toBe(100);
  });
});
