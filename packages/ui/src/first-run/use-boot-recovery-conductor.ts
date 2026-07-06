/**
 * In-chat boot-recovery conductor (headless).
 *
 * When the agent fails to come up — a cold boot that outlasts the stall
 * threshold, or a shared→dedicated cloud handoff that times out / fails — this
 * hook seeds ONE live assistant turn (`boot:recovery`) into the SAME transcript
 * the floating chat renders, phrased as the agent asking for help with a
 * SPECIFIC remedy: re-log in when the Eliza Cloud session is unusable, retry
 * the handoff when dedicated-agent setup stalled, plain reconnect otherwise.
 * There is deliberately NO floating banner/pill above the chat for boot state
 * — the transcript is the single voice (the old `BootStatusIndicator` pill and
 * `CloudHandoffBanner` toast read as clutter and offered only a generic
 * settings escape).
 *
 * The card's `__boot_recovery__:` controls route through the boot-recovery
 * action channel — never to the server. The card updates in place, is removed
 * the moment the agent is healthy, and never renders during onboarding
 * (`firstRunComplete === false`): the first-run conductor owns every word on
 * that screen and surfaces its own sign-in retries. The no-provider state is
 * likewise excluded — the transcript's no-provider gate is that honest surface.
 */

import * as React from "react";
import type { ConversationMessage } from "../api";
import { openCloudBillingConsole } from "../cloud/billing-console";
import { useShellControllerContext } from "../components/shell/ShellControllerContext.hooks";
import {
  type CloudHandoffPhaseDetail,
  dispatchChatOpen,
  dispatchCloudHandoffRetry,
} from "../events";
import { useCloudHandoffPhase } from "../hooks/useCloudHandoffPhase";
import { useAppSelectorShallow } from "../state";
import { useConversationMessages } from "../state/ConversationMessagesContext.hooks";
import { hasUsableStoredStewardToken } from "../state/cloud-steward-login";
import {
  BOOT_RECOVERY_ACTION_PREFIX,
  setBootRecoveryActionHandler,
} from "./boot-recovery-channel";

const BOOT_RECOVERY_TURN_ID = "boot:recovery";

/**
 * How long a cold boot may run before the agent speaks up in the transcript.
 * A warm agent leaves "booting" within a frame; only a genuinely stuck boot
 * crosses this. Exported for tests.
 */
export const BOOT_STALL_AFTER_MS = 90_000;

const RELOGIN_CHOICE = `${BOOT_RECOVERY_ACTION_PREFIX}relogin=Re-log in`;
const RETRY_CHOICE = `${BOOT_RECOVERY_ACTION_PREFIX}retry=Try again`;
const RETRY_HANDOFF_CHOICE = `${BOOT_RECOVERY_ACTION_PREFIX}retry-handoff=Retry setup`;
const RECONNECT_CHOICE = `${BOOT_RECOVERY_ACTION_PREFIX}reconnect=Reconnect`;
const ADD_CREDITS_CHOICE = `${BOOT_RECOVERY_ACTION_PREFIX}add-credits=Add credits`;

interface RecoveryCard {
  text: string;
  choices: string[];
}

function choiceBlock(lines: string[]): string {
  return ["[CHOICE:boot-recovery id=status]", ...lines, "[/CHOICE]"].join("\n");
}

function cardToTurn(card: RecoveryCard): ConversationMessage {
  const body = card.choices.length
    ? `${card.text}\n\n${choiceBlock(card.choices)}`
    : card.text;
  return {
    id: BOOT_RECOVERY_TURN_ID,
    role: "assistant",
    text: body,
    timestamp: Date.now(),
    source: "boot_recovery",
  };
}

/** The trouble the conductor is currently voicing, in precedence order. */
type Trouble =
  | { kind: "connection" }
  | { kind: "insufficient-credits"; agentId: string }
  | { kind: "handoff"; agentId: string }
  | { kind: "signed-out" }
  | { kind: "unresponsive" }
  | null;

function liveCard(trouble: NonNullable<Trouble>): RecoveryCard {
  switch (trouble.kind) {
    case "connection":
      return {
        text: "I've lost my connection to the backend — I can't hear you until it's back.",
        choices: [RECONNECT_CHOICE],
      };
    case "insufficient-credits":
      // Nubs's 0-credit guidance: the user keeps chatting on the free shared
      // agent (never a silent connect failure), and gets an explicit prompt to
      // add credits for their own dedicated agent — with a retry once they do.
      return {
        text: "You're on the free shared agent for now. Add credits to spin up your own dedicated agent — I'll switch you over automatically once it's ready.",
        choices: [ADD_CREDITS_CHOICE, RETRY_HANDOFF_CHOICE],
      };
    case "handoff":
      return {
        text: "I couldn't finish setting up your dedicated agent — you're still on the shared one for now.",
        choices: [RETRY_HANDOFF_CHOICE],
      };
    case "signed-out":
      return {
        text: "I'm having a hard time waking up — your Eliza Cloud session looks signed out.",
        choices: [RELOGIN_CHOICE, RETRY_CHOICE],
      };
    case "unresponsive":
      return {
        text: "I'm having a hard time waking up — the agent still isn't responding.",
        choices: [RETRY_CHOICE, RELOGIN_CHOICE],
      };
  }
}

/**
 * Watch boot + handoff health and keep the single in-chat recovery turn in
 * step. `booting`/`noProviderConfigured` come from the shell controller (the
 * transcript's own readiness source); `handoff` from the handoff phase event.
 */
export function useBootRecoveryConductor(
  booting: boolean,
  noProviderConfigured: boolean,
  handoff: CloudHandoffPhaseDetail | null,
): void {
  const {
    firstRunComplete,
    handleCloudLogin,
    triggerRestart,
    backendConnection,
    retryBackendConnection,
  } = useAppSelectorShallow((s) => ({
    firstRunComplete: s.firstRunComplete,
    handleCloudLogin: s.handleCloudLogin,
    triggerRestart: s.triggerRestart,
    backendConnection: s.backendConnection,
    retryBackendConnection: s.retryBackendConnection,
  }));
  const { setConversationMessages } = useConversationMessages();

  const upsertTurn = React.useCallback(
    (turn: ConversationMessage) => {
      setConversationMessages((prev) =>
        prev.some((m) => m.id === BOOT_RECOVERY_TURN_ID)
          ? prev.map((m) => (m.id === BOOT_RECOVERY_TURN_ID ? turn : m))
          : [...prev, turn],
      );
    },
    [setConversationMessages],
  );
  const removeTurn = React.useCallback(() => {
    setConversationMessages((prev) =>
      prev.some((m) => m.id === BOOT_RECOVERY_TURN_ID)
        ? prev.filter((m) => m.id !== BOOT_RECOVERY_TURN_ID)
        : prev,
    );
  }, [setConversationMessages]);

  // A boot only counts as stalled after it holds for BOOT_STALL_AFTER_MS.
  const [stalled, setStalled] = React.useState(false);
  React.useEffect(() => {
    if (!booting) {
      setStalled(false);
      return;
    }
    const id = window.setTimeout(() => setStalled(true), BOOT_STALL_AFTER_MS);
    return () => window.clearTimeout(id);
  }, [booting]);

  // Conductor active only post-onboarding (the first-run conductor owns the
  // onboarding screen).
  const active = firstRunComplete === true;

  const handoffFailed =
    handoff != null &&
    (handoff.phase === "timed-out" || handoff.phase === "failed");
  // The dedicated upgrade was refused for lack of credits (402). Distinct from a
  // boot failure: the fix is add-credits, not retry-as-is, so it gets its own
  // trouble kind + card copy.
  const handoffInsufficientCredits =
    handoff != null && handoff.phase === "insufficient-credits";
  // A dead backend connection outranks everything (nothing else can work),
  // and skips the card when another surface owns the disconnected state.
  const connectionFailed =
    backendConnection?.state === "failed" &&
    !backendConnection.showDisconnectedUI;

  // The no-provider exclusion scopes to the STALL diagnosis only: an
  // unconfigured provider legitimately never finishes booting and the
  // transcript's no-provider gate owns that state — but a failed handoff or a
  // dead connection is real trouble regardless of provider config.
  const trouble: Trouble = !active
    ? null
    : connectionFailed
      ? { kind: "connection" }
      : handoffInsufficientCredits
        ? { kind: "insufficient-credits", agentId: handoff.agentId }
        : handoffFailed
          ? { kind: "handoff", agentId: handoff.agentId }
          : stalled && !noProviderConfigured
            ? hasUsableStoredStewardToken()
              ? { kind: "unresponsive" }
              : { kind: "signed-out" }
            : null;

  // An action pins its in-flight copy over the live card; when the action
  // settles without healing the boot, `cardVersion` bumps so the live card
  // (with its controls) returns — an in-flight "Reconnecting…" must never be
  // a dead end.
  const overrideRef = React.useRef<RecoveryCard | null>(null);
  const retryHandoffReleaseTimerRef = React.useRef<number | null>(null);
  const [cardVersion, setCardVersion] = React.useState(0);
  // One control action at a time (re-login/restart are async).
  const busyRef = React.useRef(false);
  const troubleRef = React.useRef<Trouble>(trouble);
  troubleRef.current = trouble;

  React.useEffect(
    () => () => {
      if (retryHandoffReleaseTimerRef.current !== null) {
        window.clearTimeout(retryHandoffReleaseTimerRef.current);
        retryHandoffReleaseTimerRef.current = null;
      }
    },
    [],
  );

  const pinOverride = React.useCallback(
    (card: RecoveryCard) => {
      overrideRef.current = card;
      upsertTurn(cardToTurn(card));
    },
    [upsertTurn],
  );
  const releaseOverride = React.useCallback(() => {
    if (retryHandoffReleaseTimerRef.current !== null) {
      window.clearTimeout(retryHandoffReleaseTimerRef.current);
      retryHandoffReleaseTimerRef.current = null;
    }
    overrideRef.current = null;
    setCardVersion((v) => v + 1);
  }, []);

  const troubleKind = trouble === null ? null : trouble.kind;
  // The resting overlay shows no transcript, so a card seeded while the sheet
  // is collapsed would be silent. On the FIRST seed of a trouble episode (null
  // → non-null), open the chat so the agent's ask is actually seen; updates
  // within the same episode never re-open (the user may have collapsed it).
  const spokeRef = React.useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `cardVersion` is a re-render nonce — releaseOverride bumps it so the live card reseeds after an action settles on an unchanged trouble kind.
  React.useEffect(() => {
    if (troubleKind === null) {
      if (retryHandoffReleaseTimerRef.current !== null) {
        window.clearTimeout(retryHandoffReleaseTimerRef.current);
        retryHandoffReleaseTimerRef.current = null;
      }
      overrideRef.current = null;
      spokeRef.current = false;
      removeTurn();
      return;
    }
    if (overrideRef.current) return;
    const current = troubleRef.current;
    if (current) {
      upsertTurn(cardToTurn(liveCard(current)));
      if (!spokeRef.current) {
        spokeRef.current = true;
        dispatchChatOpen();
      }
    }
  }, [troubleKind, cardVersion, upsertTurn, removeTurn]);

  const handleAction = React.useCallback(
    (value: string): boolean => {
      if (!value.startsWith(BOOT_RECOVERY_ACTION_PREFIX)) return false;
      const id = value.slice(BOOT_RECOVERY_ACTION_PREFIX.length);
      if (busyRef.current) return true;

      if (id === "relogin") {
        pinOverride({
          text: "Opening Eliza Cloud sign-in…",
          choices: [],
        });
        busyRef.current = true;
        void Promise.resolve(handleCloudLogin())
          .then(() => {
            // Sign-in flow finished: hand the card back to the live trouble
            // state so the controls return if the boot is still stuck — the
            // in-flight copy must never be a dead end. (On recovery the
            // healthy state removes the card entirely.)
            releaseOverride();
          })
          // error-policy:J4 — a failed sign-in launch is surfaced as an error
          // card with the same recovery controls, never silently dropped.
          .catch((err: unknown) => {
            pinOverride({
              text: `Couldn't open Eliza Cloud sign-in (${err instanceof Error ? err.message : "unknown error"}).`,
              choices: [RELOGIN_CHOICE, RETRY_CHOICE],
            });
          })
          .finally(() => {
            busyRef.current = false;
          });
        return true;
      }

      if (id === "retry") {
        pinOverride({ text: "Reconnecting…", choices: [] });
        busyRef.current = true;
        void Promise.resolve(triggerRestart())
          .then(() => {
            releaseOverride();
          })
          // error-policy:J4 — a failed restart is surfaced as an error card.
          .catch((err: unknown) => {
            pinOverride({
              text: `Couldn't reconnect (${err instanceof Error ? err.message : "unknown error"}).`,
              choices: [RETRY_CHOICE, RELOGIN_CHOICE],
            });
          })
          .finally(() => {
            busyRef.current = false;
          });
        return true;
      }

      if (id === "reconnect") {
        // Synchronous kick: the connection state flips to "reconnecting",
        // which clears the trouble (card removed); if every attempt fails the
        // state returns to "failed" and a fresh card (with controls) reseeds.
        retryBackendConnection();
        return true;
      }

      if (id === "add-credits") {
        // Open the hosted billing console (add funds). Deliberately does NOT pin
        // an in-flight card or heal the trouble: the user stays on the working
        // shared agent with the add-credits prompt in view, and hits "Retry
        // setup" once funded — the dedicated upgrade then proceeds.
        void openCloudBillingConsole();
        return true;
      }

      if (id === "retry-handoff") {
        const current = troubleRef.current;
        if (
          current?.kind === "handoff" ||
          current?.kind === "insufficient-credits"
        ) {
          pinOverride({
            text: "Retrying your dedicated agent setup…",
            choices: [],
          });
          dispatchCloudHandoffRetry({ agentId: current.agentId });
          if (retryHandoffReleaseTimerRef.current !== null) {
            window.clearTimeout(retryHandoffReleaseTimerRef.current);
          }
          retryHandoffReleaseTimerRef.current = window.setTimeout(() => {
            retryHandoffReleaseTimerRef.current = null;
            releaseOverride();
          }, 1_500);
        }
        return true;
      }

      // Unknown control under the reserved prefix: consume, do nothing.
      return true;
    },
    [
      handleCloudLogin,
      pinOverride,
      releaseOverride,
      retryBackendConnection,
      triggerRestart,
    ],
  );
  const handleActionRef = React.useRef(handleAction);
  handleActionRef.current = handleAction;

  React.useEffect(() => {
    setBootRecoveryActionHandler((value) => handleActionRef.current(value));
    return () => setBootRecoveryActionHandler(null);
  }, []);
}

/** Mount point — call once inside the transcript + shell-controller providers. */
export function BootRecoveryConductorMount(): null {
  const controller = useShellControllerContext();
  const handoff = useCloudHandoffPhase();
  useBootRecoveryConductor(
    controller?.phase === "booting",
    controller?.noProviderConfigured ?? false,
    handoff,
  );
  return null;
}
