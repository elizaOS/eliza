/**
 * In-chat model-status conductor (headless) (#12178).
 *
 * While the local text model is not yet ready (missing / downloading / loading
 * / error), this hook keeps ONE live system turn (`model:download-status`) in
 * the SAME transcript the floating chat renders, so download progress is
 * visible INSIDE the chat — the home widget is invisible while the full-screen
 * onboarding chat covers home. The card updates in place (never one bubble per
 * tick), shows name / % / ETA, clamps the displayed percent monotonically, and
 * carries `__model__:` controls (cancel / switch to cloud / retry / download)
 * that route through the model action channel — never to the server.
 *
 * It reads the already-plumbed `controller.modelStatus`
 * (`deriveHomeModelStatus`) — nothing new is fetched. It coexists with the
 * first-run conductor (separate turn id) and stays mounted after onboarding, so
 * a later boot where the model isn't ready still surfaces the card.
 */

import * as React from "react";
import type { ConversationMessage } from "../api";
import { client } from "../api";
import { useShellControllerContext } from "../components/shell/ShellControllerContext.hooks";
import type { HomeModelStatus } from "../services/local-inference/home-model-status";
import { TEXT_GENERATION_SLOTS } from "../services/local-inference/types";
import { useConversationMessages } from "../state/ConversationMessagesContext.hooks";
import {
  MODEL_ACTION_PREFIX,
  setModelActionHandler,
} from "./model-action-channel";

const MODEL_STATUS_TURN_ID = "model:download-status";

const NOT_REQUIRED: HomeModelStatus = {
  kind: "not-required",
  blocksSend: false,
  percent: null,
  etaMs: null,
  modelName: null,
  modelId: null,
  errors: [],
};

/** A card the user's action pins over the live status (cancelled / switched). */
interface OverrideCard {
  text: string;
  choices: string[];
}

function formatEta(etaMs: number | null): string {
  if (etaMs == null || !Number.isFinite(etaMs) || etaMs <= 0) return "";
  const totalSeconds = Math.round(etaMs / 1000);
  if (totalSeconds < 60) return ` · ~${totalSeconds}s left`;
  const minutes = Math.round(totalSeconds / 60);
  return ` · ~${minutes}m left`;
}

function choiceBlock(lines: string[]): string {
  return ["[CHOICE:model id=status]", ...lines, "[/CHOICE]"].join("\n");
}

const CANCEL_CHOICE = `${MODEL_ACTION_PREFIX}cancel=Cancel download`;
const SWITCH_CLOUD_CHOICE = `${MODEL_ACTION_PREFIX}switch-cloud=Use Eliza Cloud instead`;
const RETRY_CHOICE = `${MODEL_ACTION_PREFIX}retry=Try again`;
const DOWNLOAD_CHOICE = `${MODEL_ACTION_PREFIX}download=Download now`;

/** Build the live status card text (monotonic percent already applied). */
function liveCard(
  status: HomeModelStatus,
  displayPercent: number | null,
): OverrideCard {
  const name = status.modelName ?? "your local model";
  switch (status.kind) {
    case "downloading": {
      const pct = displayPercent != null ? ` — ${displayPercent}%` : "";
      const eta = formatEta(status.etaMs);
      return {
        text: `Downloading ${name}${pct}${eta}. You can keep chatting — I'll answer as soon as I'm loaded.`,
        choices: [CANCEL_CHOICE, SWITCH_CLOUD_CHOICE],
      };
    }
    case "loading":
      return {
        text: `Loading ${name}… almost ready.`,
        choices: [SWITCH_CLOUD_CHOICE],
      };
    case "missing":
      return {
        text: `${name} isn't downloaded yet. Download it to run on-device, or use Eliza Cloud for now.`,
        choices: [DOWNLOAD_CHOICE, SWITCH_CLOUD_CHOICE],
      };
    case "error": {
      const detail = status.errors[0] ? ` (${status.errors[0]})` : "";
      return {
        text: `I couldn't get ${name} ready${detail}. Try again, or use Eliza Cloud instead.`,
        choices: [RETRY_CHOICE, SWITCH_CLOUD_CHOICE],
      };
    }
    default:
      return { text: "", choices: [] };
  }
}

function cardToTurn(card: OverrideCard): ConversationMessage {
  const body = card.choices.length
    ? `${card.text}\n\n${choiceBlock(card.choices)}`
    : card.text;
  return {
    id: MODEL_STATUS_TURN_ID,
    role: "assistant",
    text: body,
    timestamp: Date.now(),
    source: "model_status",
  };
}

function isBlockingKind(kind: HomeModelStatus["kind"]): boolean {
  return (
    kind === "missing" ||
    kind === "downloading" ||
    kind === "loading" ||
    kind === "error"
  );
}

/**
 * Seed/refresh the in-chat model-status card and wire its `__model__:` controls.
 * `status` is `controller.modelStatus` — the single source of readiness truth.
 */
export function useModelStatusConductor(status: HomeModelStatus): void {
  const { setConversationMessages } = useConversationMessages();

  // Highest download percent shown so far — clamps the display so a server
  // snapshot that regresses (a known local-inference quirk) never rewinds the bar.
  const maxPercentRef = React.useRef<number | null>(null);
  // A sticky card the user's action pins over the live status until they resume.
  const overrideRef = React.useRef<OverrideCard | null>(null);
  // One control action at a time (cancel/switch/retry are async network calls).
  const busyRef = React.useRef(false);
  // Latest model id for the cancel/retry controls (updated every render).
  const modelIdRef = React.useRef<string | null>(status.modelId ?? null);
  modelIdRef.current = status.modelId ?? null;

  const upsertTurn = React.useCallback(
    (turn: ConversationMessage) => {
      setConversationMessages((prev) =>
        prev.some((m) => m.id === MODEL_STATUS_TURN_ID)
          ? prev.map((m) => (m.id === MODEL_STATUS_TURN_ID ? turn : m))
          : [...prev, turn],
      );
    },
    [setConversationMessages],
  );
  const removeTurn = React.useCallback(() => {
    setConversationMessages((prev) =>
      prev.some((m) => m.id === MODEL_STATUS_TURN_ID)
        ? prev.filter((m) => m.id !== MODEL_STATUS_TURN_ID)
        : prev,
    );
  }, [setConversationMessages]);

  const pinOverride = React.useCallback(
    (card: OverrideCard) => {
      overrideRef.current = card;
      upsertTurn(cardToTurn(card));
    },
    [upsertTurn],
  );

  const blocking = isBlockingKind(status.kind);

  // Render the live card from status. An action-pinned override wins until the
  // user resumes (download/retry clears it). When the model becomes ready /
  // not-required (and nothing is pinned), the card is removed.
  React.useEffect(() => {
    if (overrideRef.current) return;
    if (!blocking) {
      maxPercentRef.current = null;
      removeTurn();
      return;
    }
    const percent = status.percent;
    const clamped =
      percent == null
        ? maxPercentRef.current
        : Math.round(Math.max(percent, maxPercentRef.current ?? percent));
    maxPercentRef.current = clamped;
    upsertTurn(cardToTurn(liveCard(status, clamped)));
  }, [blocking, status, upsertTurn, removeTurn]);

  const handleModelAction = React.useCallback(
    (value: string): boolean => {
      if (!value.startsWith(MODEL_ACTION_PREFIX)) return false;
      const id = value.slice(MODEL_ACTION_PREFIX.length);
      if (busyRef.current) return true;
      const modelId = modelIdRef.current;

      if (id === "cancel") {
        overrideRef.current = null;
        pinOverride({
          text: "Download cancelled. Pick how to continue.",
          choices: [DOWNLOAD_CHOICE, SWITCH_CLOUD_CHOICE],
        });
        if (!modelId) return true;
        busyRef.current = true;
        void client
          .cancelLocalInferenceDownload(modelId)
          // error-policy:J4 — a failed cancel is surfaced to the user as a card.
          .catch((err: unknown) => {
            pinOverride({
              text: `Couldn't cancel the download (${err instanceof Error ? err.message : "unknown error"}). It may still be running.`,
              choices: [SWITCH_CLOUD_CHOICE],
            });
          })
          .finally(() => {
            busyRef.current = false;
          });
        return true;
      }

      if (id === "download" || id === "retry") {
        overrideRef.current = null;
        maxPercentRef.current = null;
        if (!modelId) return true;
        busyRef.current = true;
        void client
          .startLocalInferenceDownload(modelId)
          // error-policy:J4 — a failed (re)start is surfaced as an error card.
          .catch((err: unknown) => {
            pinOverride({
              text: `Couldn't start the download (${err instanceof Error ? err.message : "unknown error"}).`,
              choices: [RETRY_CHOICE, SWITCH_CLOUD_CHOICE],
            });
          })
          .finally(() => {
            busyRef.current = false;
          });
        return true;
      }

      if (id === "switch-cloud") {
        pinOverride({
          text: "Switching to Eliza Cloud — I'll answer from the cloud while the on-device model finishes in the background.",
          choices: [],
        });
        busyRef.current = true;
        void Promise.all(
          TEXT_GENERATION_SLOTS.map((slot) =>
            client.setLocalInferencePreferredProvider(slot, "elizacloud"),
          ),
        )
          // error-policy:J4 — a failed provider switch is surfaced as a card.
          .catch((err: unknown) => {
            pinOverride({
              text: `Couldn't switch to Eliza Cloud (${err instanceof Error ? err.message : "unknown error"}).`,
              choices: [RETRY_CHOICE],
            });
          })
          .finally(() => {
            busyRef.current = false;
          });
        return true;
      }

      // Unknown control under the reserved prefix: consume, do nothing.
      return true;
    },
    [pinOverride],
  );
  const handleActionRef = React.useRef(handleModelAction);
  handleActionRef.current = handleModelAction;

  React.useEffect(() => {
    setModelActionHandler((value) => handleActionRef.current(value));
    return () => setModelActionHandler(null);
  }, []);
}

/** Mount point — call once inside the transcript + shell-controller providers. */
export function ModelStatusConductorMount(): null {
  const controller = useShellControllerContext();
  useModelStatusConductor(controller?.modelStatus ?? NOT_REQUIRED);
  return null;
}
