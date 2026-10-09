import type { TaskChoiceWidget } from "@elizaos/core/protocol";
import { validateTaskChoiceWidget } from "@elizaos/core/protocol";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

export interface TaskChoiceMessages {
  choose: string;
  failed: string;
  received: string;
  /** Shown with `explainUnavailable` when a choice is tapped while one is in flight. */
  checking: string;
}

/**
 * Neutral choice controls; the host owns transport, result presentation and style.
 *
 * By default unavailable options render as disabled buttons. With
 * `explainUnavailable`, options stay focusable and activatable (marked
 * `aria-disabled`) and activating one announces why it cannot be used, while
 * the same guards still prevent any duplicate or late `onChoose` dispatch.
 * Options of a widget that is no longer pending are hidden in that mode; the
 * received status remains.
 *
 * With `consumeOnChoose`, a tap removes the options at once and shows the
 * chosen label. The options come back only if `onChoose` fails. After it
 * succeeds, `onAccepted` receives the chosen label so the host can show it as
 * the person's answer; the generic received status is then not shown.
 */
export function TaskChoice({
  widget,
  taskId,
  pending = false,
  onChoose,
  expiredMessage = "This choice has expired.",
  messages,
  explainUnavailable = false,
  consumeOnChoose = false,
  onAccepted,
}: {
  widget: TaskChoiceWidget;
  taskId: string;
  pending?: boolean;
  onChoose: (value: string) => Promise<void>;
  expiredMessage?: string;
  messages?: Partial<TaskChoiceMessages>;
  explainUnavailable?: boolean;
  consumeOnChoose?: boolean;
  onAccepted?: (label: string) => void;
}) {
  validateTaskChoiceWidget(widget);
  const [busy, setBusy] = useState(false),
    [expired, setExpired] = useState(
      Date.now() >= Date.parse(widget.expiresAt),
    );
  const [failed, setFailed] = useState(false);
  const [checkingNotice, setCheckingNotice] = useState(false);
  // The option a consumed tap chose; cleared only when the choice fails.
  const [chosen, setChosen] = useState<string | null>(null);
  const locked = useRef(false),
    generation = useRef(0),
    active = useRef(widget.callbackData);
  useLayoutEffect(() => {
    locked.current = false;
    active.current = widget.callbackData;
    setFailed(false);
    setCheckingNotice(false);
    setBusy(false);
    setChosen(null);
    const duration = Date.parse(widget.expiresAt) - Date.now();
    setExpired(duration <= 0);
    const timer = setTimeout(
      () => setExpired(true),
      Math.max(0, Math.min(duration, 2_147_483_647)),
    );
    return () => {
      generation.current++;
      clearTimeout(timer);
    };
  }, [widget.callbackData, widget.expiresAt]);
  useEffect(() => {
    if (!pending && !busy) setCheckingNotice(false);
  }, [pending, busy]);
  async function choose(value: string) {
    const pastDeadline = expired || Date.now() >= Date.parse(widget.expiresAt);
    if (
      locked.current ||
      pending ||
      pastDeadline ||
      widget.state !== "pending" ||
      taskId !== widget.taskId
    ) {
      if (explainUnavailable) {
        // Surface the existing expired status even if the timer has not fired.
        if (pastDeadline) setExpired(true);
        else if (widget.state === "pending") setCheckingNotice(true);
      }
      return;
    }
    locked.current = true;
    setFailed(false);
    setCheckingNotice(false);
    setBusy(true);
    if (consumeOnChoose) setChosen(value);
    const ticket = generation.current;
    try {
      await onChoose(value);
      if (ticket === generation.current) {
        const label = widget.block.options.find(
          (option) => option.value === value,
        )?.label;
        if (label !== undefined) onAccepted?.(label);
      }
    } catch {
      if (ticket === generation.current) {
        setFailed(true);
        setChosen(null);
      }
    } finally {
      if (
        ticket === generation.current &&
        active.current === widget.callbackData
      ) {
        locked.current = false;
        setBusy(false);
      }
    }
  }
  if (taskId !== widget.taskId) return null;
  const unavailable = pending || busy || expired || widget.state !== "pending";
  const showOptions =
    (!explainUnavailable || widget.state === "pending") && chosen === null;
  const chosenLabel =
    chosen === null
      ? null
      : widget.block.options.find((option) => option.value === chosen)?.label;
  return (
    <fieldset>
      <legend>
        {widget.block.prompt || messages?.choose || "Choose an option"}
      </legend>
      {failed && (
        <p role="alert">
          {messages?.failed ?? "The choice could not be sent. Try again."}
        </p>
      )}
      {/* Live notices stay outside the options' busy state. */}
      {showOptions &&
        widget.block.options.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-busy={pending || busy}
            disabled={!explainUnavailable && unavailable}
            aria-disabled={explainUnavailable && unavailable ? true : undefined}
            onClick={() => void choose(option.value)}
          >
            {option.label}
            {option.description && <span>{option.description}</span>}
          </button>
        ))}
      {checkingNotice && !expired && widget.state === "pending" && (
        <p role="status">
          {messages?.checking ??
            "Your choice is being checked. Please wait for the result."}
        </p>
      )}
      {expired && widget.state === "pending" && (
        <p role="status">{expiredMessage}</p>
      )}
      {chosenLabel && <p data-chosen="">{chosenLabel}</p>}
      {widget.state !== "pending" && !consumeOnChoose && (
        <p role="status">{messages?.received ?? "Your choice was received."}</p>
      )}
    </fieldset>
  );
}
