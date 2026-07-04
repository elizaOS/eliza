/**
 * User-facing copy for the in-chat model-status turn (`model:download-status`).
 *
 * The conductor (`use-model-status-conductor.ts`) seeds ONE live-updating
 * assistant turn while a local text model is downloading/loading/missing/failed;
 * these builders turn a `HomeModelStatus` snapshot into that turn's markdown,
 * including the `[CHOICE]` control row the model action channel intercepts. Copy
 * is deterministic and pure so it can be unit-tested without React.
 */

import type { HomeModelStatus } from "../services/local-inference/home-model-status";

/** Stable id of the single live model-status turn. */
export const MODEL_STATUS_TURN_ID = "model:download-status";

/** Model control values — carry the reserved `__model__:` action-channel prefix. */
export const MODEL_ACTION = {
  cancel: "__model__:cancel",
  switchCloud: "__model__:switch-cloud",
  retry: "__model__:retry",
  keepWaiting: "__model__:keep-waiting",
  download: "__model__:download",
} as const;

/** Placeholder shown in the composer while the local model blocks send. */
export const BLOCKED_COMPOSER_PLACEHOLDER =
  "downloading eliza-1 — you can keep typing";

function roundedPercent(percent: number | null): number | null {
  if (percent == null || !Number.isFinite(percent)) return null;
  return Math.max(0, Math.min(100, Math.round(percent)));
}

/** Compact ETA, e.g. "~3m left", "~45s left". Null when the ETA is unknown. */
export function formatEta(etaMs: number | null): string | null {
  if (etaMs == null || !Number.isFinite(etaMs) || etaMs <= 0) return null;
  const totalSeconds = Math.round(etaMs / 1000);
  if (totalSeconds < 60) return `~${totalSeconds}s left`;
  const minutes = Math.round(totalSeconds / 60);
  if (minutes < 60) return `~${minutes}m left`;
  const hours = Math.round(minutes / 60);
  return `~${hours}h left`;
}

function modelLabel(status: HomeModelStatus): string {
  return status.modelName ?? "the local model";
}

/**
 * Build a `[CHOICE]` control row for the status turn. `first-run` scope reuses
 * the prominent full-width row styling; the VALUES carry the `__model__:`
 * prefix so the model action channel — not the server — consumes taps.
 */
function choiceBlock(options: { value: string; label: string }[]): string {
  const lines = options.map((o) => `${o.value}=${o.label}`);
  return ["[CHOICE:first-run id=model-status]", ...lines, "[/CHOICE]"].join(
    "\n",
  );
}

/**
 * The instant local acknowledgment seeded when the user types a real chat
 * message while the model still blocks send — so the message is never silently
 * lost. The optimistic send still rides the server hold/503-retry path; this is
 * the visible "I heard you, still getting ready" reply.
 */
export function typedWhileBlockedReply(status: HomeModelStatus): string {
  const percent = roundedPercent(status.percent);
  const eta = formatEta(status.etaMs);
  const progress =
    percent != null
      ? ` — ${percent}%${eta ? `, ${eta}` : ""}`
      : status.kind === "loading"
        ? " — loading into memory"
        : "";
  return `Still getting ${modelLabel(status)} ready${progress}. I'll answer as soon as I'm loaded.`;
}

/**
 * The full status-turn markdown for a live (non-cancelled) state: a status line
 * plus the always-reachable control row. Cancel + switch-cloud are always
 * offered; retry is added in the error state.
 */
export function modelStatusTurnText(status: HomeModelStatus): string {
  const name = modelLabel(status);
  const percent = roundedPercent(status.percent);
  const eta = formatEta(status.etaMs);

  let line: string;
  switch (status.kind) {
    case "downloading":
      line =
        percent != null
          ? `Downloading ${name} — ${percent}%${eta ? ` · ${eta}` : ""}. You can keep typing; I'll reply as soon as it's ready.`
          : `Downloading ${name}. You can keep typing; I'll reply as soon as it's ready.`;
      break;
    case "loading":
      line = `Loading ${name} into memory. Almost ready — you can keep typing.`;
      break;
    case "missing":
      line = `${name} isn't downloaded yet. Starting the download — you can keep typing.`;
      break;
    case "error": {
      const detail = status.errors[0] ? ` (${status.errors[0]})` : "";
      line = `${name} couldn't finish downloading${detail}. Retry, or switch to Eliza Cloud.`;
      break;
    }
    default:
      // ready / not-required never seed a turn; guarded by the conductor.
      line = `${name} is ready.`;
  }

  const controls =
    status.kind === "error"
      ? [
          { value: MODEL_ACTION.retry, label: "Retry download" },
          { value: MODEL_ACTION.switchCloud, label: "Switch to Eliza Cloud" },
        ]
      : [
          { value: MODEL_ACTION.cancel, label: "Cancel download" },
          { value: MODEL_ACTION.switchCloud, label: "Switch to Eliza Cloud" },
          { value: MODEL_ACTION.keepWaiting, label: "Keep waiting" },
        ];

  return `${line}\n\n${choiceBlock(controls)}`;
}

/**
 * The status-turn markdown after the user cancels: a dead end is not allowed —
 * re-offer the download and the cloud switch.
 */
export function modelCancelledTurnText(status: HomeModelStatus): string {
  const name = modelLabel(status);
  const controls = [
    { value: MODEL_ACTION.download, label: `Download ${name}` },
    { value: MODEL_ACTION.switchCloud, label: "Switch to Eliza Cloud" },
  ];
  return `Cancelled the ${name} download. Pick how to continue.\n\n${choiceBlock(controls)}`;
}

/** The status-turn markdown after switching inference to Eliza Cloud. */
export function modelSwitchedToCloudTurnText(): string {
  return "Switched to Eliza Cloud inference — you're ready to chat.";
}
