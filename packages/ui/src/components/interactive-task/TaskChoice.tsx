import {
  type TaskChoiceWidget,
  validateTaskChoiceWidget,
} from "@elizaos/core/messaging/task-widgets";
import { useEffect, useRef, useState } from "react";

export interface TaskChoiceMessages {
  choose: string;
  failed: string;
  received: string;
}

/** Neutral choice controls; the host owns transport, result presentation and style. */
export function TaskChoice({
  widget,
  taskId,
  pending = false,
  onChoose,
  expiredMessage = "This choice has expired.",
  messages,
}: {
  widget: TaskChoiceWidget;
  taskId: string;
  pending?: boolean;
  onChoose: (value: string) => Promise<void>;
  expiredMessage?: string;
  messages?: Partial<TaskChoiceMessages>;
}) {
  validateTaskChoiceWidget(widget);
  const [busy, setBusy] = useState(false),
    [expired, setExpired] = useState(
      Date.now() >= Date.parse(widget.expiresAt),
    );
  const [failed, setFailed] = useState(false);
  const locked = useRef(false),
    generation = useRef(0),
    active = useRef(widget.callbackData);
  useEffect(() => {
    locked.current = false;
    active.current = widget.callbackData;
    setFailed(false);
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
  async function choose(value: string) {
    if (
      locked.current ||
      pending ||
      expired ||
      Date.now() >= Date.parse(widget.expiresAt) ||
      widget.state !== "pending" ||
      taskId !== widget.taskId
    )
      return;
    locked.current = true;
    setFailed(false);
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
  return (
    <fieldset aria-busy={pending || busy}>
      <legend>
        {widget.block.prompt || messages?.choose || "Choose an option"}
      </legend>
      {failed && (
        <p role="alert">
          {messages?.failed ?? "The choice could not be sent. Try again."}
        </p>
      )}
      {widget.block.options.map((option) => (
        <button
          key={option.value}
          type="button"
          disabled={pending || busy || expired || widget.state !== "pending"}
          onClick={() => void choose(option.value)}
        >
          {option.label}
          {option.description && <span>{option.description}</span>}
        </button>
      ))}
      {expired && widget.state === "pending" && (
        <p role="status">{expiredMessage}</p>
      )}
      {widget.state !== "pending" && (
        <p role="status">{messages?.received ?? "Your choice was received."}</p>
      )}
    </fieldset>
  );
}
