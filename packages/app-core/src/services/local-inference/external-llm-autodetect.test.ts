import { describe, expect, it } from "vitest";
import {
  EXTERNAL_LLM_PROBE_ORDER,
  externalLocalLlmRowReadyForGguf,
  resolveExternalLlmAutodetectUi,
} from "./external-llm-autodetect";
import type { ExternalLlmRuntimeRow } from "./types";

function row(
  partial: Partial<ExternalLlmRuntimeRow> & Pick<ExternalLlmRuntimeRow, "id">,
): ExternalLlmRuntimeRow {
  return {
    displayName: partial.displayName ?? partial.id,
    endpoint: partial.endpoint ?? "http://127.0.0.1",
    models: partial.models ?? [],
    hasDownloadedModels: partial.hasDownloadedModels ?? false,
    reachable: partial.reachable ?? true,
    ...partial,
  } as ExternalLlmRuntimeRow;
}

describe("external-llm-autodetect", () => {
  it("keeps probe order stable for router + UI", () => {
    expect(EXTERNAL_LLM_PROBE_ORDER).toEqual([
      "ollama",
      "lmstudio",
      "vllm",
      "jan",
    ]);
  });

  it("externalLocalLlmRowReadyForGguf honours explicit routerInferenceReady boolean", () => {
    expect(
      externalLocalLlmRowReadyForGguf(
        row({
          id: "ollama",
          routerInferenceReady: false,
          hasDownloadedModels: true,
          models: ["a"],
        }),
      ),
    ).toBe(false);
    expect(
      externalLocalLlmRowReadyForGguf(
        row({
          id: "ollama",
          routerInferenceReady: true,
        }),
      ),
    ).toBe(true);
  });

  it("resolveExternalLlmAutodetectUi picks first in probe order when several qualify", () => {
    const backends = [
      row({
        id: "jan",
        displayName: "Jan",
        routerInferenceReady: true,
      }),
      row({
        id: "ollama",
        displayName: "Ollama",
        routerInferenceReady: true,
      }),
    ];
    const r = resolveExternalLlmAutodetectUi(backends);
    expect(r.qualifyingRowsInProbeOrder.map((x) => x.id)).toEqual([
      "ollama",
      "jan",
    ]);
    expect(r.automaticSelectLabel).toContain("Ollama");
    expect(r.automaticSelectLabel).toContain("leads probe order");
  });
});
