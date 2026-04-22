import { describe, expect, it } from "vitest";
import {
  externalHubProbeStatusTitle,
  getExternalHubProbeBadgeLabel,
  getExternalHubProbeStatus,
} from "./external-hub-probe-status";
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

describe("external-hub-probe-status", () => {
  it("maps reachability and routerInferenceReady to three badges", () => {
    expect(
      externalHubProbeStatusTitle(
        getExternalHubProbeStatus(
          row({ id: "ollama", reachable: false, routerInferenceReady: false }),
        ),
      ),
    ).toBe("Not detected");
    expect(
      externalHubProbeStatusTitle(
        getExternalHubProbeStatus(
          row({
            id: "ollama",
            reachable: true,
            hasDownloadedModels: true,
            models: ["m"],
            routerInferenceReady: false,
          }),
        ),
      ),
    ).toBe("Detected");
    expect(
      externalHubProbeStatusTitle(
        getExternalHubProbeStatus(
          row({
            id: "ollama",
            reachable: true,
            routerInferenceReady: true,
          }),
        ),
      ),
    ).toBe("Working");
  });

  it("shows Idle for Ollama when tags have models but /api/ps count is 0", () => {
    const r = row({
      id: "ollama",
      reachable: true,
      hasDownloadedModels: true,
      models: ["llama3.2:latest"],
      routerInferenceReady: false,
      ollamaRunningModelCount: 0,
    });
    expect(getExternalHubProbeStatus(r)).toBe("detected");
    expect(getExternalHubProbeBadgeLabel(r)).toBe("Idle");
  });
});
