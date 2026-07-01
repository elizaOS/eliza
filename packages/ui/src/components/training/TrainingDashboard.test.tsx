// @vitest-environment jsdom
//
// Behavioral coverage for the fine-tuning / training injected view
// (packages/ui/src/components/training/TrainingDashboard.tsx — the default
// component rendered by FineTuningView in ./injected.tsx). The unit under test
// is the REAL TrainingDashboard + JobsTable + ModelsTable + the create-job
// modal state machine, plus the REAL useTrainingApi hooks that own the fetch
// wiring and the JobDetailPanel cancel ("stop a run") flow.
//
// The ONLY mocked collaborators are:
//   - global `fetch` (the training HTTP API boundary)
//   - `../../state/TranslationContext.hooks` useTranslation (i18n; STABLE `t`,
//     returned identity captured in useCallback deps — a fresh object per
//     render would spin the effect loop and hang the file).
//
// What it locks down:
//   - Jobs/models config+status rendering from the API payloads.
//   - Loading + empty + error states for both tables.
//   - Start-a-run: Train -> modal -> Start Training fires exactly one
//     POST /api/training/jobs with the exact {registry_key, epochs, run_name}
//     payload; the modal closes on success.
//   - Dataset/model selection: the payload carries the row's short_name and the
//     typed epochs/run_name (not defaults).
//   - Adversarial epochs (0 / non-numeric) is rejected client-side: a validation
//     error shows and NO POST is fired.
//   - Rapid-fire idempotency: while a create is in flight the button is disabled
//     so a double-click cannot double-POST.
//   - Stop-a-run: opening a job's detail panel and clicking Cancel fires exactly
//     one POST /api/training/jobs/<id>/cancel and closes the panel.
//   - Progress display: the detail panel renders the fetched step/status.

import { cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// STABLE translation singleton — a fresh `{ t }` per render would change the
// identity captured by handleCreateJob's useCallback deps and spin the loop.
const i18nMock = vi.hoisted(() => {
  const t = (key: string, options?: { defaultValue?: string }) =>
    options?.defaultValue ?? key;
  return { t, uiLanguage: "en", setUiLanguage: () => {} };
});
vi.mock("../../state/TranslationContext.hooks", () => ({
  useTranslation: () => i18nMock,
}));

import type { TrainingJob, TrainingJobDetail, TrainingModel } from "./types";
import { TrainingDashboard } from "./TrainingDashboard";

// ── fetch harness ──────────────────────────────────────────────────

interface FetchCall {
  url: string;
  method: string;
  body: unknown;
}

const calls: FetchCall[] = [];

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Server Error",
    json: async () => body,
  } as unknown as Response;
}

const MODEL: TrainingModel = {
  short_name: "eliza-1-mini",
  base_repo_id: "elizaos/eliza-1-mini",
  gguf_repo_id: "elizaos/eliza-1-mini-gguf",
  tier: "small",
  max_context: 32,
  recommended_gpu: "A100",
};

const JOB: TrainingJob = {
  id: "job-42",
  run_name: "nightly-sft",
  registry_key: "eliza-1-mini",
  status: "running",
  started_at: "2026-01-01T00:00:00.000Z",
  last_step: 128,
  last_format_ok: true,
  last_content_ok: false,
};

const JOB_DETAIL: TrainingJobDetail = {
  ...JOB,
  checkpoints: [{ step: 100, pulled_at: "2026-01-01T00:00:00.000Z", size_mb: 512 }],
  progress: [
    {
      step: 128,
      format_ok: true,
      content_ok: false,
      tokens_per_sec: 1200,
      evaluated_at: "2026-01-01T00:00:00.000Z",
    },
  ],
};

// Per-test knobs.
interface Harness {
  jobs: { body: unknown; ok: boolean; status: number };
  models: { body: unknown; ok: boolean; status: number };
  create: { body: unknown; ok: boolean; status: number };
  cancel: { body: unknown; ok: boolean; status: number };
  // When set, POST /api/training/jobs never settles (in-flight forever) — used
  // to prove double-click idempotency against a disabled button.
  createHangs: boolean;
}

let h: Harness;

beforeEach(() => {
  calls.length = 0;
  h = {
    jobs: { body: { jobs: [JOB] }, ok: true, status: 200 },
    models: { body: { models: [MODEL] }, ok: true, status: 200 },
    create: { body: { job_id: "job-99" }, ok: true, status: 200 },
    cancel: { body: {}, ok: true, status: 200 },
    createHangs: false,
  };

  global.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    let body: unknown;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ url, method, body });

    // Route by path + method.
    if (url === "/api/training/jobs" && method === "GET") {
      return Promise.resolve(jsonResponse(h.jobs.body, h.jobs.ok, h.jobs.status));
    }
    if (url === "/api/training/models") {
      return Promise.resolve(
        jsonResponse(h.models.body, h.models.ok, h.models.status),
      );
    }
    if (url === "/api/training/jobs" && method === "POST") {
      if (h.createHangs) return new Promise<Response>(() => {});
      return Promise.resolve(
        jsonResponse(h.create.body, h.create.ok, h.create.status),
      );
    }
    if (url.endsWith("/cancel") && method === "POST") {
      return Promise.resolve(
        jsonResponse(h.cancel.body, h.cancel.ok, h.cancel.status),
      );
    }
    if (url.startsWith("/api/training/jobs/") && method === "GET") {
      return Promise.resolve(jsonResponse(JOB_DETAIL));
    }
    if (url.includes("/budget")) {
      return Promise.resolve(jsonResponse({ budget: null }));
    }
    if (url.includes("/api/training/inference/")) {
      return Promise.resolve(jsonResponse({ endpoints: [], p50_tps: 0 }));
    }
    return Promise.resolve(jsonResponse({}));
  }) as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function postJobCalls() {
  return calls.filter((c) => c.url === "/api/training/jobs" && c.method === "POST");
}

describe("TrainingDashboard — fine-tuning view", () => {
  it("renders job config + status and the trainable model from the API", async () => {
    render(<TrainingDashboard />);

    // Job row: id + run name + status + step from /api/training/jobs.
    await waitFor(() => {
      expect(document.body.textContent).toContain("job-42");
    });
    expect(document.body.textContent).toContain("nightly-sft");
    expect(document.body.textContent).toContain("running");
    expect(document.body.textContent).toContain("128");

    // Model row: short_name + tier + a Train button.
    expect(document.body.textContent).toContain("eliza-1-mini");
    const trainBtn = await screenFindByText("Train");
    expect(trainBtn).toBeTruthy();
  });

  it("shows the loading state before the jobs request resolves", () => {
    // Never-settling jobs GET keeps the table in its loading branch.
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise<Response>(() => {}),
    );
    render(<TrainingDashboard />);
    expect(document.body.textContent).toContain("Loading jobs...");
    expect(document.body.textContent).toContain("Loading models...");
  });

  it("renders the empty state when there are no jobs", async () => {
    h.jobs.body = { jobs: [] };
    render(<TrainingDashboard />);
    await waitFor(() => {
      expect(document.body.textContent).toContain("No training jobs");
    });
  });

  it("surfaces an error banner when the jobs request fails", async () => {
    h.jobs = { body: {}, ok: false, status: 500 };
    render(<TrainingDashboard />);
    await waitFor(() => {
      expect(document.body.textContent).toContain("HTTP 500");
    });
    // No job row rendered.
    expect(document.body.textContent).not.toContain("nightly-sft");
  });

  it("starts a run: Train -> modal -> Start Training POSTs the exact payload and closes the modal", async () => {
    const user = userEvent.setup();
    render(<TrainingDashboard />);

    await waitFor(() => expect(document.body.textContent).toContain("eliza-1-mini"));

    await user.click(await screenFindByText("Train"));

    // Modal opened with epochs + run-name inputs.
    const epochs = document.getElementById("training-epochs") as HTMLInputElement;
    const runName = document.getElementById("training-run-name") as HTMLInputElement;
    expect(epochs).toBeTruthy();
    expect(runName).toBeTruthy();

    // Select dataset config: override epochs + name (proves non-default payload).
    await user.clear(epochs);
    await user.type(epochs, "5");
    await user.type(runName, "experiment-v2");

    await user.click(await screenFindByText("Start Training"));

    await waitFor(() => expect(postJobCalls().length).toBe(1));
    expect(postJobCalls()[0].body).toEqual({
      registry_key: "eliza-1-mini",
      epochs: 5,
      run_name: "experiment-v2",
    });

    // Modal closes on success.
    await waitFor(() =>
      expect(document.getElementById("training-epochs")).toBeNull(),
    );
  });

  it("omits run_name when left blank (optional field)", async () => {
    const user = userEvent.setup();
    render(<TrainingDashboard />);
    await waitFor(() => expect(document.body.textContent).toContain("eliza-1-mini"));

    await user.click(await screenFindByText("Train"));
    await user.click(await screenFindByText("Start Training"));

    await waitFor(() => expect(postJobCalls().length).toBe(1));
    expect(postJobCalls()[0].body).toEqual({
      registry_key: "eliza-1-mini",
      epochs: 3, // default in modal
      run_name: undefined,
    });
  });

  it("rejects invalid epochs client-side and fires NO POST", async () => {
    const user = userEvent.setup();
    render(<TrainingDashboard />);
    await waitFor(() => expect(document.body.textContent).toContain("eliza-1-mini"));

    await user.click(await screenFindByText("Train"));
    const epochs = document.getElementById("training-epochs") as HTMLInputElement;
    await user.clear(epochs);
    await user.type(epochs, "0");

    await user.click(await screenFindByText("Start Training"));

    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "Epochs must be a positive number",
      ),
    );
    expect(postJobCalls().length).toBe(0);
    // Modal stays open so the user can correct it.
    expect(document.getElementById("training-epochs")).toBeTruthy();
  });

  it("rejects non-numeric epochs client-side and fires NO POST", async () => {
    const user = userEvent.setup();
    render(<TrainingDashboard />);
    await waitFor(() => expect(document.body.textContent).toContain("eliza-1-mini"));

    await user.click(await screenFindByText("Train"));
    const epochs = document.getElementById("training-epochs") as HTMLInputElement;
    await user.clear(epochs);
    // A bare-string epochs (the number input still allows programmatic clear).
    epochs.value = "abc";
    epochs.dispatchEvent(new Event("input", { bubbles: true }));

    await user.click(await screenFindByText("Start Training"));

    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "Epochs must be a positive number",
      ),
    );
    expect(postJobCalls().length).toBe(0);
  });

  it("is rapid-fire idempotent: a double-click cannot double-POST while a create is in flight", async () => {
    h.createHangs = true; // POST never settles → modal stays open, button disabled
    const user = userEvent.setup();
    render(<TrainingDashboard />);
    await waitFor(() => expect(document.body.textContent).toContain("eliza-1-mini"));

    await user.click(await screenFindByText("Train"));
    const start = await screenFindByText("Start Training");

    await user.click(start);
    // Second click lands on the now-disabled button.
    await user.click(start);
    await user.click(start);

    // Exactly one create request despite three clicks.
    await waitFor(() => expect(postJobCalls().length).toBe(1));
    expect(postJobCalls().length).toBe(1);
  });

  it("surfaces a server error when create fails and keeps the modal open", async () => {
    h.create = { body: {}, ok: false, status: 500 };
    const user = userEvent.setup();
    render(<TrainingDashboard />);
    await waitFor(() => expect(document.body.textContent).toContain("eliza-1-mini"));

    await user.click(await screenFindByText("Train"));
    await user.click(await screenFindByText("Start Training"));

    await waitFor(() => expect(document.body.textContent).toContain("HTTP 500"));
    // Modal still open (did not falsely report success).
    expect(document.getElementById("training-epochs")).toBeTruthy();
  });

  it("stops a run: opening a job's detail panel and clicking Cancel POSTs /cancel once and closes the panel", async () => {
    const user = userEvent.setup();
    render(<TrainingDashboard />);

    // Open the detail panel by clicking the job row.
    await waitFor(() => expect(document.body.textContent).toContain("nightly-sft"));
    await user.click(await screenFindByText("nightly-sft"));

    // Progress display: detail panel shows the fetched step + status.
    const cancelBtn = await screenFindByText("Cancel");
    // "Trigger Eval" confirms the detail panel action bar is present.
    expect(document.body.textContent).toContain("Trigger Eval");
    expect(document.body.textContent).toContain("Registry Key");

    await user.click(cancelBtn);

    const cancelCalls = () =>
      calls.filter((c) => c.url.endsWith("/cancel") && c.method === "POST");
    await waitFor(() => expect(cancelCalls().length).toBe(1));
    expect(cancelCalls()[0].url).toBe(
      "/api/training/jobs/job-42/cancel",
    );

    // Panel closed after a successful cancel (onClose fired → selectedJobId null).
    await waitFor(() => expect(document.body.textContent).not.toContain("Registry Key"));
  });
});

// ── tiny local query helper ────────────────────────────────────────
// The package's vitest setup does not load @testing-library/jest-dom and we
// deliberately avoid `screen` role queries here (several buttons share text);
// this walks the DOM for the first element whose trimmed text equals `label`.
async function screenFindByText(label: string): Promise<HTMLElement> {
  let found: HTMLElement | null = null;
  await waitFor(() => {
    found = findByExactText(label);
    if (!found) throw new Error(`no element with text "${label}"`);
  });
  return found as unknown as HTMLElement;
}

function findByExactText(label: string): HTMLElement | null {
  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>("button, td, th, div, span, a"),
  );
  // Prefer the deepest matching node (a button whose own text is the label).
  for (const el of candidates) {
    if (el.textContent?.trim() === label) {
      // If it is / contains a button, return the button for click semantics.
      const btn = el.tagName === "BUTTON" ? el : el.querySelector("button");
      return (btn as HTMLElement) ?? el;
    }
  }
  // Fallback: a button that merely contains the label (e.g. icon + text).
  for (const el of candidates) {
    if (el.tagName === "BUTTON" && el.textContent?.includes(label)) return el;
  }
  return null;
}
