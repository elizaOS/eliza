import {
  type ChangeEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import "./VoicePill.css";

export interface VoicePillMessage {
  id: string;
  role: "agent" | "user";
  text: string;
}

export interface VoicePillProps {
  /** Whether the chat panel is expanded above the pill. */
  open?: boolean;
  /** Controlled-open callback. If omitted, the component manages its own state. */
  onOpenChange?: (open: boolean) => void;
  /** "Always-on recording" flag. Red pulse when true. */
  recording?: boolean;
  /** Controlled-recording callback. If omitted, mic button toggles internal state. */
  onRecordingChange?: (recording: boolean) => void;
  /** Conversation to render in the expanded panel. */
  messages?: VoicePillMessage[];
  /** Composer placeholder text. Defaults to "Ask Eliza…" */
  placeholder?: string;
  /** Called when user submits text via Enter or the send button. */
  onSubmit?: (text: string) => void;
  /** Called when user clicks the + (attach/add) button. Optional. */
  onAdd?: () => void;
  /** Override the pill's aria-label. Defaults to "Eliza". */
  ariaLabel?: string;
  /** Extra className applied to the outer container (for parent positioning). */
  className?: string;
}

const DEFAULT_PLACEHOLDER = "Ask Eliza…";
const DEFAULT_ARIA_LABEL = "Eliza";

function useControllable<T>(
  controlled: T | undefined,
  initial: T,
  onChange: ((next: T) => void) | undefined,
): [T, (next: T) => void] {
  const [internal, setInternal] = useState<T>(initial);
  const isControlled = controlled !== undefined;
  const value = isControlled ? (controlled as T) : internal;
  const setValue = useCallback(
    (next: T) => {
      if (!isControlled) {
        setInternal(next);
      }
      onChange?.(next);
    },
    [isControlled, onChange],
  );
  return [value, setValue];
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect x="9" y="3" width="6" height="12" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <path d="M12 18v3" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M4 12l16-8-6 16-3-7-7-1z" />
    </svg>
  );
}

export function VoicePill(props: VoicePillProps) {
  const {
    open: openProp,
    onOpenChange,
    recording: recordingProp,
    onRecordingChange,
    messages,
    placeholder = DEFAULT_PLACEHOLDER,
    onSubmit,
    onAdd,
    ariaLabel = DEFAULT_ARIA_LABEL,
    className,
  } = props;

  const [open, setOpen] = useControllable<boolean>(
    openProp,
    false,
    onOpenChange,
  );
  const [recording, setRecording] = useControllable<boolean>(
    recordingProp,
    false,
    onRecordingChange,
  );
  const [inputValue, setInputValue] = useState<string>("");

  const inputRef = useRef<HTMLInputElement>(null);
  const chatRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
    }
  }, [open]);

  const toggleOpen = useCallback(() => {
    setOpen(!open);
  }, [open, setOpen]);

  const handleHitClick = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      // Ignore clicks bubbling out of the expanded chat panel (composer buttons, input, etc.)
      if (
        chatRef.current &&
        event.target instanceof Node &&
        chatRef.current.contains(event.target)
      ) {
        return;
      }
      toggleOpen();
    },
    [toggleOpen],
  );

  const handleHitKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.target !== event.currentTarget) {
        return;
      }
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        toggleOpen();
      }
    },
    [toggleOpen],
  );

  const handleMicClick = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      setRecording(!recording);
    },
    [recording, setRecording],
  );

  const handleAddClick = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      onAdd?.();
    },
    [onAdd],
  );

  const send = useCallback(() => {
    const trimmed = inputValue.trim();
    if (!trimmed) return;
    onSubmit?.(trimmed);
    setInputValue("");
  }, [inputValue, onSubmit]);

  const handleSendClick = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      send();
    },
    [send],
  );

  const handleInputChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      setInputValue(event.target.value);
    },
    [],
  );

  const handleInputKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      // Keep keystrokes from bubbling to the hit area's Enter/Space toggle.
      event.stopPropagation();
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        send();
      }
    },
    [send],
  );

  const stopPointer = useCallback(
    (event: MouseEvent<HTMLInputElement> | PointerEvent<HTMLInputElement>) => {
      event.stopPropagation();
    },
    [],
  );

  const wrapperClassName = className
    ? `elizaos-voice-pill ${className}`
    : "elizaos-voice-pill";

  const pillClassName = recording
    ? "elizaos-voice-pill-pill is-recording"
    : "elizaos-voice-pill-pill";

  const chatClassName = open
    ? "elizaos-voice-pill-chat"
    : "elizaos-voice-pill-chat is-collapsed";

  return (
    // biome-ignore lint/a11y/useSemanticElements: this wrapper contains nested chat input controls, so it cannot be a native button.
    <div
      className={wrapperClassName}
      role="button"
      tabIndex={0}
      aria-expanded={open}
      aria-label={ariaLabel}
      onClick={handleHitClick}
      onKeyDown={handleHitKeyDown}
    >
      <div ref={chatRef} className={chatClassName} aria-hidden={!open}>
        {messages && messages.length > 0 ? (
          <div className="elizaos-voice-pill-messages">
            {messages.map((message) => (
              <div
                key={message.id}
                className={
                  message.role === "user"
                    ? "elizaos-voice-pill-msg is-user"
                    : "elizaos-voice-pill-msg is-agent"
                }
              >
                {message.text}
              </div>
            ))}
          </div>
        ) : null}
        <div className="elizaos-voice-pill-composer">
          <button
            type="button"
            className="elizaos-voice-pill-ctrl-btn"
            aria-label="Add"
            onClick={handleAddClick}
            tabIndex={open ? 0 : -1}
          >
            <PlusIcon />
          </button>
          <input
            ref={inputRef}
            type="text"
            className="elizaos-voice-pill-input"
            placeholder={placeholder}
            aria-label="Message Eliza"
            value={inputValue}
            onChange={handleInputChange}
            onKeyDown={handleInputKeyDown}
            onClick={stopPointer}
            onMouseDown={stopPointer}
            tabIndex={open ? 0 : -1}
          />
          <button
            type="button"
            className={
              recording
                ? "elizaos-voice-pill-ctrl-btn is-recording"
                : "elizaos-voice-pill-ctrl-btn"
            }
            aria-label="Audio"
            aria-pressed={recording}
            onClick={handleMicClick}
            tabIndex={open ? 0 : -1}
          >
            <MicIcon />
          </button>
          <button
            type="button"
            className="elizaos-voice-pill-send-btn"
            aria-label="Send"
            onClick={handleSendClick}
            tabIndex={open ? 0 : -1}
          >
            <SendIcon />
          </button>
        </div>
      </div>
      <span className={pillClassName} aria-hidden="true" />
    </div>
  );
}

VoicePill.displayName = "VoicePill";

export default VoicePill;
