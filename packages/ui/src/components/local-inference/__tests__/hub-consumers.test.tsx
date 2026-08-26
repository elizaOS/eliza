// @vitest-environment jsdom
/**
 * Consumer-boundary render tests for the Model Hub view-model helpers. The
 * pure-function suite (hub-utils.test.ts) pins the helper math; this file
 * proves the wiring: rendered DownloadProgress and ActiveModelBar output must
 * derive from progressPercent / formatEta / formatBytes / displayModelName, so
 * a wiring defect (wrong helper, dropped argument, hardcoded value) reddens
 * these tests while the pure suite stays green. Real components over jsdom;
 * useTranslation falls back to the real English test translator without a
 * provider.
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ActiveModelState,
  DownloadJob,
  InstalledModel,
} from "../../../api/client-local-inference";
import { ActiveModelBar } from "../ActiveModelBar";
import { DownloadProgress } from "../DownloadProgress";

afterEach(cleanup);

function job(overrides: Partial<DownloadJob> = {}): DownloadJob {
  return {
    jobId: "job-1",
    modelId: "eliza-1-2b",
    state: "downloading",
    received: 410_000_000,
    total: 820_000_000,
    bytesPerSec: 12_500_000,
    etaMs: 33_000,
    startedAt: "2026-08-26T00:00:00Z",
    updatedAt: "2026-08-26T00:00:00Z",
    ...overrides,
  };
}

function installedModel(
  overrides: Partial<InstalledModel> = {},
): InstalledModel {
  return {
    id: "eliza-1-2b",
    displayName: "Eliza 1 2B",
    path: "/models/eliza-1-2b.gguf",
    sizeBytes: 820_000_000,
    installedAt: "2026-08-26T00:00:00Z",
    lastUsedAt: null,
    source: "eliza-download",
    ...overrides,
  };
}

function idleActive(): ActiveModelState {
  return { modelId: null, loadedAt: null, status: "idle" };
}

/** The progress bar indicator; its translateX offset is -(100 - pct)% and so
 * pins the percent into the rendered DOM without relying on copy text. */
function indicatorTransform(): string {
  const indicator = document.querySelector<HTMLElement>(
    "[data-slot=progress-indicator]",
  );
  if (indicator === null) throw new Error("progress indicator not rendered");
  return indicator.style.transform;
}

/** Radix's progressbar role surface; aria-valuenow mirrors the percent the
 * bar received. */
function barAriaValueNow(): string {
  const bar = screen.getByRole("progressbar");
  return bar.getAttribute("aria-valuenow") ?? "";
}

describe("DownloadProgress — rendered download telemetry", () => {
  it("derives the bar offset, percent copy, speed, and ETA from the job", () => {
    render(<DownloadProgress job={job()} />);
    // 410_000_000 / 820_000_000 = 50%: the indicator sits at the half-way
    // translateX(-50%) and the copy names the exact rounded percent.
    expect(indicatorTransform()).toBe("translateX(-50%)");
    // getByText throws unless the exact rendered copy is present.
    screen.getByText("391.0 MB of 782.0 MB · 50%");
    screen.getByText("11.9 MB/s · 33s left");
  });

  it("renders a fully-received job as a complete bar with 100% copy", () => {
    render(
      <DownloadProgress
        job={job({
          state: "completed",
          received: 820_000_000,
          bytesPerSec: 0,
          etaMs: null,
        })}
      />,
    );
    // -(100 - 100) is -0; the bar sits fully open and the progressbar role
    // reports 100.
    expect(indicatorTransform()).toBe("translateX(-0%)");
    expect(barAriaValueNow()).toBe("100");
    screen.getByText("782.0 MB of 782.0 MB · 100%");
  });

  it("renders a zero-total job as an empty bar without NaN anywhere", () => {
    render(
      <DownloadProgress job={job({ received: 0, total: 0, etaMs: null })} />,
    );
    // progressPercent's non-positive-total guard must reach the DOM: 0%, not
    // NaN% or a division-by-zero artifact.
    expect(indicatorTransform()).toBe("translateX(-100%)");
    expect(barAriaValueNow()).toBe("0");
    expect(document.body.textContent).not.toContain("NaN");
    expect(document.body.textContent).toContain("· 0%");
  });
});

describe("ActiveModelBar — rendered active-model identity", () => {
  it("labels the loaded model with the curated display name and status", () => {
    const active: ActiveModelState = {
      modelId: "eliza-1-9b-drafter",
      loadedAt: "2026-08-26T00:00:00Z",
      status: "ready",
    };
    render(
      <ActiveModelBar
        active={active}
        installed={[
          installedModel({
            id: "eliza-1-9b-drafter",
            displayName: "Eliza 1 9B Drafter",
            path: "/models/eliza-1-9b-drafter.gguf",
          }),
        ]}
        onUnload={() => {}}
        busy={false}
      />,
    );
    // The rendered label must be displayModelName's derivation ("base id +
    // drafter"), which differs from BOTH the raw id ("eliza-1-9b-drafter")
    // and the displayName ("Eliza 1 9B Drafter") — so dropping the helper
    // for either fallback reddens this assertion.
    screen.getByText("eliza-1-9b drafter");
    screen.getByText("ready");
    screen.getByRole("button", { name: "Unload" });
  });

  it("falls back to the raw model id when nothing is installed for it", () => {
    const active: ActiveModelState = {
      modelId: "external-hf-abc123",
      loadedAt: null,
      status: "loading",
    };
    render(
      <ActiveModelBar
        active={active}
        installed={[installedModel()]}
        onUnload={() => {}}
        busy={false}
      />,
    );
    screen.getByText("external-hf-abc123");
    screen.getByText("loading");
  });

  it("renders nothing when no model is loaded", () => {
    const { container } = render(
      <ActiveModelBar
        active={idleActive()}
        installed={[]}
        onUnload={() => {}}
        busy={false}
      />,
    );
    expect(container.innerHTML).toBe("");
  });
});
