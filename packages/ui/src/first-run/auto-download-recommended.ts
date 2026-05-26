/**
 * Auto-download a recommended local model when the user picks Local mode.
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
