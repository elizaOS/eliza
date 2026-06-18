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

import { VOICE_PILL_CSS } from "./voice-pill.css.ts";

const STYLE_TAG_MARKER = "data-elizaos-voice-pill";
let stylesInjected = false;

/**
 * Inject the VoicePill stylesheet into `document.head` once per page.
 *
 * Done at runtime (rather than via a `.css` import) so the component file
 * stays importable from Node's ESM loader — re-exporting `<VoicePill>` from
 * plugin barrels (e.g. `@elizaos/plugin-training/ui`) must not break
 * server-side plugin discovery, which trips on `ERR_UNKNOWN_FILE_EXTENSION`
 * when tsx encounters a `.css` import. The dataset marker guards against
 * duplicate insertion when multiple instances or multiple bundles of
 * `@elizaos/ui` mount on the same page.
 *
 * SSR-safe: no-op when `document` is unavailable.
 */
function ensureVoicePillStyles(): void {
  if (stylesInjected) return;
  if (typeof document === "undefined") return;
  if (document.head.querySelector(`style[${STYLE_TAG_MARKER}]`)) {
    stylesInjected = true;
    return;
  }
  const style = document.createElement("style");
  style.setAttribute(STYLE_TAG_MARKER, "");
  style.textContent = VOICE_PILL_CSS;
  document.head.appendChild(style);
  stylesInjected = true;
}

export interface VoicePillMessage {
  id: string;
  role: "agent" | "user";
  text: string;
}

export interface VoicePillProps {
  /** Controlled open state. If omitted, component manages its own. */
  open?: boolean;
  /** Fired when the open state changes (click on pill-hit). */
  onOpenChange?: (open: boolean) => void;
  /** "Always-on recording" flag. Red pulse when true. */
  recording?: boolean;
  /** Fired when the mic button toggles recording. */
  onRecordingChange?: (recording: boolean) => void;
  /** Conversation rendered in the expanded panel. */
  messages?: VoicePillMessage[];
  /** Composer placeholder. Default "Ask Eliza…" */
  placeholder?: string;
  /** Called when user submits text via Enter or send. Component clears input after. */
  onSubmit?: (text: string) => void;
  /** Called when user clicks the + button. */
  onAdd?: () => void;
  /** aria-label for the pill. Default "Eliza". */
  ariaLabel?: string;
  /** Extra className on the outer container. */
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
  // Inject styles inline during render so they're present before paint.
  // The module-level `stylesInjected` flag makes every call after the first
  // a single boolean check.
  ensureVoicePillStyles();

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
      // Ignore clicks bubbling out of the expanded chat panel (composer buttons,
      // input, etc.) — only bare pill-hit clicks should toggle.
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
    ? "elizaos-voice-pill__pill elizaos-voice-pill__pill--recording"
    : "elizaos-voice-pill__pill";

  const chatClassName = open
    ? "elizaos-voice-pill__chat"
    : "elizaos-voice-pill__chat elizaos-voice-pill__chat--collapsed";

  const micClassName = recording
    ? "elizaos-voice-pill__ctrl elizaos-voice-pill__ctrl--recording"
    : "elizaos-voice-pill__ctrl";

  return (
    <div className={wrapperClassName}>
      {/* Eyes-free state announcement for screen readers (the pulsing pill is a
          visual-only cue otherwise). Always mounted so the live region exists
          before the text changes. */}
      <span
        className="elizaos-voice-pill__sr-only"
        role="status"
        aria-live="polite"
      >
        {recording ? "Listening" : "Stopped listening"}
      </span>
      {/* biome-ignore lint/a11y/useSemanticElements: this wrapper contains nested chat input controls, so it cannot be a native button. */}
      <div
        className="elizaos-voice-pill__hit"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={handleHitClick}
        onKeyDown={handleHitKeyDown}
      >
        <div ref={chatRef} className={chatClassName} aria-hidden={!open}>
          {messages && messages.length > 0 ? (
            <div className="elizaos-voice-pill__messages">
              {messages.map((message) => (
                <div
                  key={message.id}
                  className={
                    message.role === "user"
                      ? "elizaos-voice-pill__msg elizaos-voice-pill__msg--user"
                      : "elizaos-voice-pill__msg elizaos-voice-pill__msg--agent"
                  }
                >
                  {message.text}
                </div>
              ))}
            </div>
          ) : null}
          <div className="elizaos-voice-pill__composer">
            <button
              type="button"
              className="elizaos-voice-pill__ctrl"
              aria-label="Add"
              onClick={handleAddClick}
              tabIndex={open ? 0 : -1}
            >
              <PlusIcon />
            </button>
            <input
              ref={inputRef}
              type="text"
              className="elizaos-voice-pill__input"
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
              className={micClassName}
              aria-label="Audio"
              aria-pressed={recording}
              onClick={handleMicClick}
              tabIndex={open ? 0 : -1}
            >
              <MicIcon />
            </button>
            <button
              type="button"
              className="elizaos-voice-pill__send"
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
