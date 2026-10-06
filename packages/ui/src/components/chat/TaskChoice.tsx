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
 */
export function TaskChoice({
  widget,
  taskId,
  pending = false,
  onChoose,
  expiredMessage = "This choice has expired.",
  messages,
  explainUnavailable = false,
}: {
  widget: TaskChoiceWidget;
  taskId: string;
  pending?: boolean;
  onChoose: (value: string) => Promise<void>;
  expiredMessage?: string;
  messages?: Partial<TaskChoiceMessages>;
  explainUnavailable?: boolean;
}) {
  validateTaskChoiceWidget(widget);
  const [busy, setBusy] = useState(false),
    [expired, setExpired] = useState(
      Date.now() >= Date.parse(widget.expiresAt),
    );
  const [failed, setFailed] = useState(false);
  const [checkingNotice, setCheckingNotice] = useState(false);
  const locked = useRef(false),
    generation = useRef(0),
    active = useRef(widget.callbackData);
  useLayoutEffect(() => {
    locked.current = false;
    active.current = widget.callbackData;
    setFailed(false);
    setCheckingNotice(false);
    setBusy(false);
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
    const ticket = generation.current;
    try {
      await onChoose(value);
    } catch {
      if (ticket === generation.current) setFailed(true);
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
  const showOptions = !explainUnavailable || widget.state === "pending";
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
      {widget.state !== "pending" && (
        <p role="status">{messages?.received ?? "Your choice was received."}</p>
      )}
    </fieldset>
  );
}
