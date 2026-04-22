/** Small default embedding model for Ollama (common, fast pull). */
export const SUGGESTED_OLLAMA_EMBEDDING_MODEL = "nomic-embed-text";

const DEFAULT_PULL_TIMEOUT_MS = 900_000;

function trimOllamaBaseUrl(endpoint: string): string {
  return endpoint.trim().replace(/\/+$/, "");
}

/** Latest line from Ollama’s streamed `POST /api/pull` (NDJSON). */
export type OllamaPullProgressSnapshot = {
  status: string;
  /** Layer byte progress 0–100, or null when unknown (manifest, etc.). */
  percent: number | null;
  completed: number | null;
  total: number | null;
};

type PullLine = {
  status?: unknown;
  error?: unknown;
  completed?: unknown;
  total?: unknown;
};

function snapshotFromLine(rec: PullLine): OllamaPullProgressSnapshot {
  const status = typeof rec.status === "string" ? rec.status : "";
  const total = typeof rec.total === "number" ? rec.total : null;
  const completed = typeof rec.completed === "number" ? rec.completed : null;
  let percent: number | null = null;
  if (total !== null && total > 0 && completed !== null) {
    percent = Math.min(100, Math.round((completed / total) * 100));
  }
  return { status, percent, completed, total };
}

function parsePullLines(
  chunk: string,
  onLine: (rec: PullLine) => void,
): string {
  const lines = chunk.split("\n");
  const rest = lines.pop() ?? "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec: PullLine;
    try {
      rec = JSON.parse(trimmed) as PullLine;
    } catch {
      continue;
    }
    onLine(rec);
  }
  return rest;
}

/**
 * POSTs to Ollama `/api/pull` with `stream: true`, parses NDJSON progress
 * (status, completed, total) and resolves when a `success` line is seen.
 */
export async function pullOllamaModel(
  endpoint: string,
  name: string,
  options?: {
    signal?: AbortSignal;
    onProgress?: (p: OllamaPullProgressSnapshot) => void;
  },
): Promise<void> {
  const base = trimOllamaBaseUrl(endpoint);
  const signal =
    options?.signal ?? AbortSignal.timeout(DEFAULT_PULL_TIMEOUT_MS);
  const res = await fetch(`${base}/api/pull`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, stream: true }),
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text.trim() || `Ollama pull failed (HTTP ${res.status})`);
  }
  if (!res.body) {
    throw new Error("Ollama pull: empty response body");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sawSuccess = false;

  const handleRecord = (rec: PullLine) => {
    if (typeof rec.error === "string" && rec.error.trim()) {
      throw new Error(rec.error.trim());
    }
    const status = typeof rec.status === "string" ? rec.status : "";
    if (status === "success") {
      sawSuccess = true;
    }
    options?.onProgress?.(snapshotFromLine(rec));
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    buffer = parsePullLines(buffer, handleRecord);
  }
  buffer = parsePullLines(`${buffer}\n`, handleRecord);

  if (!sawSuccess) {
    throw new Error("Ollama pull ended without a success status");
  }
}
