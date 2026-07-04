// ============================================================================
// In-chat model-status conductor (headless).
//
// The local text model download/load is PART OF THE CHAT. While a local runtime
// is still fetching or loading its text model (`HomeModelStatus.kind` in
// {missing, downloading, loading, error}), this hook seeds ONE live-updating
// assistant turn (`model:download-status`) into the SAME transcript the floating
// `ContinuousChatOverlay` renders — never a floating pill, and the home
// model-download widget keeps working unchanged. The turn shows name / % / ETA
// and carries a `[CHOICE]` control row (Cancel · Switch to Eliza Cloud · Keep
// waiting; Retry replaces Cancel in the error state).
//
// It owns NO presentation — `InlineWidgetText` draws the CHOICE widget for free
// from the message text. It registers an action handler on the model channel so
// the chat's single send funnel short-circuits `__model__:` control taps before
// they hit the server.
//
// The turn is updated IN PLACE (never one bubble per tick) and refreshed at most
// once per second (`REFRESH_INTERVAL_MS`); percent is clamped monotonic so a
// transient readiness dip never rewinds the bar. When the model becomes ready
// (or the runtime is cloud/remote) the turn and handler are cleared.
//
// Typed-while-blocked: `acknowledgeTypedWhileBlocked` seeds an instant local
// "still getting ready" reply so a message sent before the model loads is never
// silently lost — the real send still rides the existing server hold/503-retry.
// ============================================================================

import * as React from "react";

import type { ConversationMessage } from "../api";
import { client } from "../api";
import { useHomeModelStatus } from "../components/local-inference/useHomeModelStatus";
import type { HomeModelStatus } from "../services/local-inference/home-model-status";
import type { TextGenerationSlot } from "../services/local-inference/types";
import { TEXT_GENERATION_SLOTS } from "../services/local-inference/types";
import { useAppSelectorShallow } from "../state";
import { useConversationMessages } from "../state/ConversationMessagesContext.hooks";
import {
  MODEL_ACTION_PREFIX,
  setModelActionHandler,
  setTypedWhileBlockedObserver,
} from "./model-action-channel";
import {
  MODEL_ACTION,
  MODEL_STATUS_TURN_ID,
  modelCancelledTurnText,
  modelStatusTurnText,
  modelSwitchedToCloudTurnText,
  typedWhileBlockedReply,
} from "./model-status-copy";

// Update the live turn at most once per second so a fast download stream can't
// churn the transcript — the requirement is one turn updated in place ≤1/s.
const REFRESH_INTERVAL_MS = 1_000;

function makeModelTurn(text: string): ConversationMessage {
  return {
    id: MODEL_STATUS_TURN_ID,
    role: "assistant",
    text,
    timestamp: Date.now(),
    source: "model_status",
  };
}

/** True for the states that seed/keep the live turn (model not usable yet). */
function shouldSeed(status: HomeModelStatus): boolean {
  return (
    status.kind === "missing" ||
    status.kind === "downloading" ||
    status.kind === "loading" ||
    status.kind === "error"
  );
}

export function useModelStatusConductor(): void {
  const status = useHomeModelStatus();
  const { setConversationMessages } = useConversationMessages();
  const { elizaCloudConnected, handleCloudLogin } = useAppSelectorShallow(
    (s) => ({
      elizaCloudConnected: s.elizaCloudConnected,
      handleCloudLogin: s.handleCloudLogin,
    }),
  );

  // Latest status the action handler reads — refs so the handler identity is
  // stable and never re-registers the channel on every % tick.
  const statusRef = React.useRef(status);
  statusRef.current = status;
  const elizaCloudConnectedRef = React.useRef(elizaCloudConnected);
  elizaCloudConnectedRef.current = elizaCloudConnected;
  const handleCloudLoginRef = React.useRef(handleCloudLogin);
  handleCloudLoginRef.current = handleCloudLogin;

  // Set once the user cancels — the live-refresh effect stops overwriting the
  // "cancelled — pick how to continue" turn with fresh download progress that
  // may still be draining out of the stream.
  const cancelledRef = React.useRef(false);
  // Monotonic percent clamp: a transient readiness dip must never rewind the
  // rendered bar.
  const maxPercentRef = React.useRef<number | null>(null);
  // Last text written to the turn — skip an identical rewrite so the ≤1/s
  // refresh never produces a no-op state update.
  const lastTextRef = React.useRef<string | null>(null);

  const seedTurn = React.useCallback(
    (turn: ConversationMessage) => {
      lastTextRef.current = turn.text;
      setConversationMessages((prev) => {
        const idx = prev.findIndex((m) => m.id === MODEL_STATUS_TURN_ID);
        if (idx === -1) return [...prev, turn];
        const next = prev.slice();
        next[idx] = turn;
        return next;
      });
    },
    [setConversationMessages],
  );

  const clearTurn = React.useCallback(() => {
    lastTextRef.current = null;
    setConversationMessages((prev) =>
      prev.some((m) => m.id === MODEL_STATUS_TURN_ID)
        ? prev.filter((m) => m.id !== MODEL_STATUS_TURN_ID)
        : prev,
    );
  }, [setConversationMessages]);

  // Clamp the snapshot's percent monotonic-up before it's rendered.
  const clampMonotonic = React.useCallback(
    (snapshot: HomeModelStatus): HomeModelStatus => {
      if (snapshot.percent == null) return snapshot;
      const prev = maxPercentRef.current;
      const clamped =
        prev == null ? snapshot.percent : Math.max(prev, snapshot.percent);
      maxPercentRef.current = clamped;
      return { ...snapshot, percent: clamped };
    },
    [],
  );

  // ── Actions ───────────────────────────────────────────────────────────────
  const switchToCloud = React.useCallback(async () => {
    // Provider-agnostic "use cloud": force cloud-only routing on the text slots
    // so the router never dispatches on-device. Requires a cloud connection —
    // open login first when we don't have one (until MODEL_SWITCH/WI-6 lands
    // this is the sanctioned client-side switch; Code map §H).
    if (!elizaCloudConnectedRef.current) {
      await handleCloudLoginRef.current();
      if (!elizaCloudConnectedRef.current) return;
    }
    await Promise.all(
      TEXT_GENERATION_SLOTS.map((slot: TextGenerationSlot) =>
        client.setLocalInferencePolicy(slot, "cloud-only"),
      ),
    );
    cancelledRef.current = true;
    seedTurn(makeModelTurn(modelSwitchedToCloudTurnText()));
  }, [seedTurn]);

  const cancelDownload = React.useCallback(async () => {
    const modelId = statusRef.current.modelId;
    if (modelId) await client.cancelLocalInferenceDownload(modelId);
    cancelledRef.current = true;
    seedTurn(makeModelTurn(modelCancelledTurnText(statusRef.current)));
  }, [seedTurn]);

  const startDownload = React.useCallback(async () => {
    const modelId = statusRef.current.modelId;
    if (!modelId) return;
    // Re-arm the live refresh — the readiness stream will drive the turn back to
    // "downloading …" as the job runs.
    cancelledRef.current = false;
    maxPercentRef.current = null;
    await client.startLocalInferenceDownload(modelId);
  }, []);

  const handleModelAction = React.useCallback(
    (value: string): boolean => {
      if (!value.startsWith(MODEL_ACTION_PREFIX)) return false;
      switch (value) {
        case MODEL_ACTION.cancel:
          void cancelDownload();
          return true;
        case MODEL_ACTION.retry:
        case MODEL_ACTION.download:
          void startDownload();
          return true;
        case MODEL_ACTION.switchCloud:
          void switchToCloud();
          return true;
        case MODEL_ACTION.keepWaiting:
          // Explicit no-op: the live turn already narrates progress. Consume it
          // so a "keep waiting" tap never reaches the server as chat text.
          return true;
        default:
          // Unknown value under the reserved prefix — consume, never forward.
          return true;
      }
    },
    [cancelDownload, startDownload, switchToCloud],
  );
  const handleActionRef = React.useRef(handleModelAction);
  handleActionRef.current = handleModelAction;

  // Register the channel handler while the turn is (or could be) live. Reserved
  // unconditionally: a tap on a leftover status widget after the model is ready
  // must be dropped by the funnel, never sent as a literal `__model__:` message.
  const seedable = shouldSeed(status);
  React.useEffect(() => {
    if (!seedable) {
      setModelActionHandler(null);
      return;
    }
    setModelActionHandler((value) => handleActionRef.current(value));
    return () => setModelActionHandler(null);
  }, [seedable]);

  // ── Live refresh: one turn, updated in place, ≤1/s ─────────────────────────
  const lastWriteRef = React.useRef(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `status` is the driver — the body reads statusRef.current but each new snapshot must re-run this throttled write, so it stays in the dep list on purpose.
  React.useEffect(() => {
    if (!seedable) {
      cancelledRef.current = false;
      maxPercentRef.current = null;
      clearTurn();
      return;
    }
    // After a cancel/switch the terminal turn stands until the user acts; don't
    // let residual stream progress overwrite it.
    if (cancelledRef.current) return;

    const now = Date.now();
    const write = () => {
      const text = modelStatusTurnText(clampMonotonic(statusRef.current));
      if (text !== lastTextRef.current) seedTurn(makeModelTurn(text));
      lastWriteRef.current = Date.now();
    };
    const sinceLast = now - lastWriteRef.current;
    if (sinceLast >= REFRESH_INTERVAL_MS) {
      write();
      return;
    }
    const timer = setTimeout(write, REFRESH_INTERVAL_MS - sinceLast);
    return () => clearTimeout(timer);
    // `status` is the driver — a new snapshot re-runs the throttled write.
  }, [seedable, status, clampMonotonic, seedTurn, clearTurn]);

  // Typed-while-blocked observer: seed an instant acknowledgment so a message
  // sent before the model loads is never silently lost. Returns whether the
  // model is blocking so the funnel can proceed untouched when it isn't.
  const acknowledgeTypedWhileBlocked = React.useCallback((): boolean => {
    if (!statusRef.current.blocksSend) return false;
    const ackId = `model:ack:${Date.now()}`;
    setConversationMessages((prev) => [
      ...prev,
      {
        id: ackId,
        role: "assistant",
        text: typedWhileBlockedReply(statusRef.current),
        timestamp: Date.now(),
        source: "model_status",
      },
    ]);
    return true;
  }, [setConversationMessages]);
  const ackRef = React.useRef(acknowledgeTypedWhileBlocked);
  ackRef.current = acknowledgeTypedWhileBlocked;

  React.useEffect(() => {
    setTypedWhileBlockedObserver(() => ackRef.current());
    return () => setTypedWhileBlockedObserver(null);
  }, []);
}

/** Mount point — call once inside the AppContext provider tree. Renders null. */
export function ModelStatusConductorMount(): null {
  useModelStatusConductor();
  return null;
}
