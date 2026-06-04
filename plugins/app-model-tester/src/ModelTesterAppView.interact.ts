// View-bundle `interact` capability handler, split out of ModelTesterAppView.tsx
// so that file exports only React components and stays Fast-Refresh-compatible
// (Vite would full-reload a component file that also exports a plain function).
// The view bundle re-exports `interact` via ./model-tester-view-bundle.ts.

const DEFAULT_PROMPT =
  "Say exactly one short sentence about the Eliza-1 model tester working.";

const MODEL_TESTER_COMMAND_TO_TEST: Record<string, string> = {
  "run-text-small": "text-small",
  "run-transcription": "transcription",
  "run-vision": "image-description",
  "run-vad": "vad",
};

async function readJsonResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      text || `[model-tester] ${response.status} ${response.statusText}`.trim(),
    );
  }
  return (text ? JSON.parse(text) : {}) as T;
}

export async function interact(
  capability: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  if (capability === "get-status") {
    const response = await fetch("/api/model-tester/status", {
      headers: { Accept: "application/json" },
    });
    return readJsonResponse(response);
  }

  const test = MODEL_TESTER_COMMAND_TO_TEST[capability];
  if (test) {
    const response = await fetch("/api/model-tester/run", {
      method: "POST",
      headers: { "content-type": "text/plain;charset=utf-8" },
      body: JSON.stringify({
        test,
        prompt:
          typeof params?.prompt === "string" ? params.prompt : DEFAULT_PROMPT,
        imageDataUrl:
          typeof params?.imageDataUrl === "string"
            ? params.imageDataUrl
            : undefined,
        audioDataUrl:
          typeof params?.audioDataUrl === "string"
            ? params.audioDataUrl
            : undefined,
        pcmSamples: Array.isArray(params?.pcmSamples)
          ? params.pcmSamples
          : undefined,
        sampleRateHz:
          typeof params?.sampleRateHz === "number"
            ? params.sampleRateHz
            : undefined,
      }),
    });
    return readJsonResponse(response);
  }

  throw new Error(`Model Tester TUI does not support "${capability}".`);
}
