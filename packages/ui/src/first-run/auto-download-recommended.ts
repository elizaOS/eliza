/**
 * Auto-download a recommended local model when the user picks Local mode.
 *
 * Background-only — never blocks the UI. The user lands in chat immediately
 * via the first-run local handoff; this helper polls the local agent's
 * `/api/health` until the runtime is up, then activates an installed
 * Eliza-1 bundle or enqueues a download for a model that fits the device's
 * hardware bucket. The user can interact with the chat while download/warmup
 * happens in the background; once complete, the local-inference panel and the
 * provider selector see the ready model.
 *
 * Idempotency: a `localStorage` marker stops us from re-enqueuing on every
 * boot. The marker is set after a successful enqueue OR after an installed
 * `eliza-download` bundle is already active/activating or successfully starts
 * activation; the Local Inference panel is the source of truth from then on.
 *
 * Failure modes:
 *   - agent never comes up within the deadline → silent no-op, no marker.
 *     A future boot can retry.
 *   - hub fetch fails → silent no-op, no marker. Same retry semantics.
 *   - download POST fails → silent no-op, no marker.
 */

import { client } from "../api";
import { fetchWithCsrf } from "../api/csrf-client";
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
      const res = await fetchWithCsrf(url, { method: "GET" });
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

function pickInstalledElizaDownloadModel(
  snapshot: ModelHubSnapshot,
): string | null {
  const catalogIds = new Set(snapshot.catalog.map((model) => model.id));
  return (
    snapshot.installed.find(
      (model) => model.source === "eliza-download" && catalogIds.has(model.id),
    )?.id ?? null
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

  const installedElizaDownload = pickInstalledElizaDownloadModel(snapshot);
  if (installedElizaDownload) {
    if (
      snapshot.active.modelId === installedElizaDownload &&
      (snapshot.active.status === "ready" ||
        snapshot.active.status === "loading")
    ) {
      writeMarker();
      return;
    }

    try {
      await client.setLocalInferenceActive(installedElizaDownload);
    } catch {
      // Leave the marker unset so a later boot retries activation after the
      // local runtime stabilizes.
      return;
    }
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
