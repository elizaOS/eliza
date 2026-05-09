export interface TrainingJob {
  id: string;
  run_name: string;
  registry_key: string;
  status: string;
  started_at: string;
  last_step: number;
  last_format_ok: boolean;
  last_content_ok: boolean;
}

export interface TrainingJobDetail extends TrainingJob {
  checkpoints: Checkpoint[];
  progress: ProgressEntry[];
}

export interface Checkpoint {
  step: number;
  pulled_at: string;
  size_mb: number;
}

export interface ProgressEntry {
  step: number;
  format_ok: boolean;
  content_ok: boolean;
  tokens_per_sec: number;
  evaluated_at: string;
}

export interface TrainingModel {
  short_name: string;
  base_repo_id: string;
  gguf_repo_id: string;
  tier: string;
  max_context: number;
  recommended_gpu: string;
}

export interface InferenceEndpoint {
  id: string;
  label: string;
  base_url: string;
  model: string;
}

export interface InferenceStats {
  p50_tps: number;
  p95_tps: number;
  p50_tpot_ms: number;
  p95_tpot_ms: number;
  kv_usage_pct: number;
  peak_vram_mb: number;
  spec_decode_accept_rate: number;
  apc_hit_rate: number;
}

export interface CreateJobRequest {
  registry_key: string;
  epochs: number;
  run_name?: string;
}
