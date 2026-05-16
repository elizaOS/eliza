import {
  type FormEvent,
  type KeyboardEvent,
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
  /** Initial open state. Default false. */
  defaultOpen?: boolean;
  /** Controlled open state. If provided, `onOpenChange` should also be provided. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;

  /** Initial recording state. Default false. */
  defaultRecording?: boolean;
  /** Controlled recording state. */
  recording?: boolean;
  onRecordingChange?: (recording: boolean) => void;

  /** Greeting text shown above the pill when no chat is open. */
  greeting?: string;

  /** Conversation messages to render in the expanded panel. */
  messages?: VoicePillMessage[];

  /** Called when the user submits the composer (Enter or click Send). */
  onSubmit?: (text: string) => void | Promise<void>;
  /** Called when the user clicks the [+] add button. */
  onAddClick?: () => void;

  /** Placeholder for the input. Default "Ask Eliza…". */
  placeholder?: string;

  /** className passthrough on the outer wrapper for positioning by parent. */
  className?: string;
}

const DEFAULT_PLACEHOLDER = "Ask Eliza…";
const DEFAULT_MESSAGES: VoicePillMessage[] = [
  { id: "default-agent-ready", role: "agent", text: "Ready when you are." },
];

function useControllableBoolean(
  controlled: boolean | undefined,
  defaultValue: boolean,
  onChange: ((next: boolean) => void) | undefined,
): [boolean, (next: boolean) => void] {
  const [internal, setInternal] = useState<boolean>(defaultValue);
  const isControlled = controlled !== undefined;
  const value = isControlled ? controlled : internal;
  const setValue = useCallback(
    (next: boolean) => {
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
    defaultOpen = false,
    open: openProp,
    onOpenChange,
    defaultRecording = false,
    recording: recordingProp,
    onRecordingChange,
    greeting,
    messages,
    onSubmit,
    onAddClick,
    placeholder = DEFAULT_PLACEHOLDER,
    className,
  } = props;

  const [open, setOpen] = useControllableBoolean(
    openProp,
    defaultOpen,
    onOpenChange,
  );
  const [recording, setRecording] = useControllableBoolean(
    recordingProp,
    defaultRecording,
    onRecordingChange,
  );
  const [text, setText] = useState<string>("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
    }
  }, [open]);

  const togglePill = useCallback(() => {
    setOpen(!open);
  }, [open, setOpen]);

  const toggleRecording = useCallback(() => {
    setRecording(!recording);
  }, [recording, setRecording]);

  const submit = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setText("");
    if (onSubmit) {
      await onSubmit(trimmed);
    }
  }, [text, onSubmit]);

  const handleFormSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      void submit();
    },
    [submit],
  );

  const handleInputKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        void submit();
      }
    },
    [submit],
  );

  const resolvedMessages: VoicePillMessage[] = messages ?? DEFAULT_MESSAGES;
  const wrapperClassName = className
    ? `voice-pill-anchor ${className}`
    : "voice-pill-anchor";

  return (
    <div className={wrapperClassName}>
      {greeting && !open ? (
        <div className="voice-pill-greeting">{greeting}</div>
      ) : null}

      <div
        className={
          open ? "voice-pill-chat" : "voice-pill-chat voice-pill-chat-hidden"
        }
        aria-hidden={open ? undefined : true}
      >
        {resolvedMessages.length > 0 ? (
          <div className="voice-pill-messages">
            {resolvedMessages.map((message) => (
              <div
                key={message.id}
                className={
                  message.role === "user"
                    ? "voice-pill-msg user"
                    : "voice-pill-msg agent"
                }
              >
                {message.text}
              </div>
            ))}
          </div>
        ) : null}

        <form className="voice-pill-composer" onSubmit={handleFormSubmit}>
          <button
            type="button"
            className="voice-pill-ctrl-btn"
            aria-label="Attach"
            onClick={onAddClick}
            tabIndex={open ? 0 : -1}
          >
            <PlusIcon />
          </button>
          <input
            ref={inputRef}
            type="text"
            className="voice-pill-input"
            placeholder={placeholder}
            aria-label="Message Eliza"
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={handleInputKeyDown}
            tabIndex={open ? 0 : -1}
          />
          <button
            type="button"
            className={
              recording
                ? "voice-pill-ctrl-btn recording-on"
                : "voice-pill-ctrl-btn"
            }
            aria-label="Voice input"
            aria-pressed={recording}
            onClick={toggleRecording}
            tabIndex={open ? 0 : -1}
          >
            <MicIcon />
          </button>
          <button
            type="submit"
            className="voice-pill-send-btn"
            aria-label="Send"
            tabIndex={open ? 0 : -1}
          >
            <SendIcon />
          </button>
        </form>
      </div>

      <button
        type="button"
        className="voice-pill-hit"
        aria-label="Eliza"
        aria-expanded={open}
        onClick={togglePill}
      >
        <span className={recording ? "voice-pill recording" : "voice-pill"} />
      </button>
    </div>
  );
}

export default VoicePill;
