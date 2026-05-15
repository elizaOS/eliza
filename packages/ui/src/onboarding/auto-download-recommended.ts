/**
 * Auto-download a recommended local model when the user picks Local mode.
 *
 * Background-only — never blocks the UI. The user lands in chat immediately
 * via `RuntimeGate.finishAsLocal()`; this helper polls the local agent's
 * `/api/health` until the runtime is up, then enqueues a download for a
 * model that fits the device's hardware bucket. The user can interact with
 * the chat (with the composer-locked / "set up provider" placeholder) while
 * the download runs; once complete, the local-inference panel and the
 * provider selector see the new model.
 *
 * Idempotency: a `localStorage` marker stops us from re-enqueuing on every
 * boot. The marker is set after a successful enqueue OR after we determine
 * the user already has at least one `eliza-download` model installed; the
 * Local Inference panel is the source of truth from then on.
 *
 * Failure modes:
 *   - agent never comes up within the deadline → silent no-op, no marker.
 *     A future boot can retry.
 *   - hub fetch fails → silent no-op, no marker. Same retry semantics.
 *   - download POST fails → silent no-op, no marker.
 *
 * The user request was specifically: "we want to start downloading the
 * recommended models immediately when they start a local agent, but we
 * dont want to keep them in loading screen". This file is the kickoff;
 * the loading screen is bypassed by `finishAsLocal()` already running
 * `completeOnboarding()` before this helper is invoked.
 */

import { client } from "../api";
import { selectRecommendedModelForSlot } from "../services/local-inference/recommendation";
import type {
  CatalogModel,
  ModelHubSnapshot,
} from "../services/local-inference/types";

const AUTO_DOWNLOAD_MARKER_KEY = "eliza.localInference.autoDownloadAttempted";
const HEALTH_POLL_INTERVAL_MS = 2_000;
const HEALTH_POLL_DEADLINE_MS = 5 * 60 * 1000;

function readMarker(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage?.getItem(AUTO_DOWNLOAD_MARKER_KEY) === "1";
  } catch {
    return false;
  }
}

function writeMarker(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage?.setItem(AUTO_DOWNLOAD_MARKER_KEY, "1");
  } catch {
    // Embedded shells without storage simply lose dedupe across sessions.
  }
}

async function waitForLocalAgent(apiBase: string): Promise<boolean> {
  const deadline = Date.now() + HEALTH_POLL_DEADLINE_MS;
  const url = `${apiBase.replace(/\/$/, "")}/api/health`;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { method: "GET" });
      if (res.ok) return true;
    } catch {
      // network not ready yet; fall through to sleep
    }
    await new Promise<void>((r) => setTimeout(r, HEALTH_POLL_INTERVAL_MS));
  }
  return false;
}

function pickRecommendedModel(snapshot: ModelHubSnapshot): CatalogModel | null {
  const installedIds = new Set(snapshot.installed.map((m) => m.id));
  return (
    selectRecommendedModelForSlot(
      "TEXT_LARGE",
      snapshot.hardware,
      snapshot.catalog,
    ).alternatives.find((model) => !installedIds.has(model.id)) ?? null
  );
}

export async function autoDownloadRecommendedLocalModelInBackground(
  apiBase: string,
): Promise<void> {
  if (readMarker()) return;

  const ready = await waitForLocalAgent(apiBase);
  if (!ready) return;

  let snapshot: ModelHubSnapshot;
  try {
    snapshot = await client.getLocalInferenceHub();
  } catch {
    return;
  }

  const alreadyHasElizaDownload = snapshot.installed.some(
    (m) => m.source === "eliza-download",
  );
  if (alreadyHasElizaDownload) {
    writeMarker();
    return;
  }

  const recommended = pickRecommendedModel(snapshot);
  if (!recommended) {
    writeMarker();
    return;
  }

  try {
    await client.startLocalInferenceDownload(recommended.id);
    writeMarker();
  } catch {
    // Leave the marker unset so a later boot retries once the runtime
    // stabilizes — e.g. the user toggled Local while the network was off.
  }
}
