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

import "./voice-pill.css";

export type VoicePillVoiceState = "idle" | "listening" | "speaking";

export interface VoicePillMessage {
  id: string;
  role: "agent" | "user";
  text: string;
}

export interface VoicePillProps {
  /** Whether the expanded chat panel is open. If undefined, component manages state internally. */
  open?: boolean;
  /** Called when the user toggles open/closed by clicking the pill (or hit area). */
  onOpenChange?: (open: boolean) => void;

  /** Whether always-on voice capture is on. If undefined, component manages state internally. */
  recording?: boolean;
  /** Called when the user toggles recording. */
  onRecordingChange?: (recording: boolean) => void;

  /** Voice state for visual feedback. Drives subtle animation, not required. */
  voiceState?: VoicePillVoiceState;

  /** Messages shown in the expanded chat panel. */
  messages?: VoicePillMessage[];

  /** Current input value. If undefined, component manages state internally. */
  inputValue?: string;
  onInputChange?: (value: string) => void;
  /** Fires on Enter or send-button click. */
  onSend?: (value: string) => void;
  /** Fires when the + button is clicked. */
  onAddAttachment?: () => void;

  /** Optional className for the outer hit-area wrapper. */
  className?: string;
  /** Optional placeholder for the input. Default: "Ask Eliza…" */
  placeholder?: string;
}

const DEFAULT_PLACEHOLDER = "Ask Eliza…";

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
    voiceState = "idle",
    messages,
    inputValue: inputValueProp,
    onInputChange,
    onSend,
    onAddAttachment,
    className,
    placeholder = DEFAULT_PLACEHOLDER,
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
  const [inputValue, setInputValue] = useControllable<string>(
    inputValueProp,
    "",
    onInputChange,
  );

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
      // Stop the parent hit-area from also toggling open.
      event.stopPropagation();
      setRecording(!recording);
    },
    [recording, setRecording],
  );

  const handleAddClick = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      onAddAttachment?.();
    },
    [onAddAttachment],
  );

  const send = useCallback(() => {
    const trimmed = inputValue.trim();
    if (!trimmed) return;
    onSend?.(trimmed);
    setInputValue("");
  }, [inputValue, onSend, setInputValue]);

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
    [setInputValue],
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

  // Pointer/mouse events from inside the input shouldn't toggle the pill.
  const stopPointer = useCallback(
    (
      event:
        | MouseEvent<HTMLInputElement>
        | PointerEvent<HTMLInputElement>,
    ) => {
      event.stopPropagation();
    },
    [],
  );

  const wrapperClassName = className
    ? `eliza-voice-pill-hit ${className}`
    : "eliza-voice-pill-hit";

  const pillClassName = [
    "eliza-voice-pill",
    recording ? "is-recording" : "",
    !recording && voiceState === "listening" ? "is-listening" : "",
    !recording && voiceState === "speaking" ? "is-speaking" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const chatClassName = open
    ? "eliza-voice-pill-chat"
    : "eliza-voice-pill-chat is-collapsed";

  return (
    <div
      className={wrapperClassName}
      role="button"
      tabIndex={0}
      aria-expanded={open}
      aria-label="Eliza"
      onClick={handleHitClick}
      onKeyDown={handleHitKeyDown}
    >
      <div className="eliza-voice-pill-anchor">
        <div
          ref={chatRef}
          className={chatClassName}
          aria-hidden={!open}
        >
          {messages && messages.length > 0 ? (
            <div className="eliza-voice-pill-messages">
              {messages.map((message) => (
                <div
                  key={message.id}
                  className={
                    message.role === "user"
                      ? "eliza-voice-pill-msg is-user"
                      : "eliza-voice-pill-msg is-agent"
                  }
                >
                  {message.text}
                </div>
              ))}
            </div>
          ) : null}
          <div className="eliza-voice-pill-composer">
            <button
              type="button"
              className="eliza-voice-pill-ctrl-btn"
              aria-label="Add"
              onClick={handleAddClick}
              tabIndex={open ? 0 : -1}
            >
              <PlusIcon />
            </button>
            <input
              ref={inputRef}
              type="text"
              className="eliza-voice-pill-input"
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
                  ? "eliza-voice-pill-ctrl-btn is-recording"
                  : "eliza-voice-pill-ctrl-btn"
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
              className="eliza-voice-pill-send-btn"
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
    </div>
  );
}

VoicePill.displayName = "VoicePill";

export default VoicePill;
