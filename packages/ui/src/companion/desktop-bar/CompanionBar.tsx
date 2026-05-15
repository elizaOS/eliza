import {
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import "./CompanionBar.css";
import type {
  DesktopRuntimeHooks,
  DesktopTrayMode,
  MicState,
  TrayMessage,
} from "./types";
import { useKeyboardShortcuts } from "./useKeyboardShortcuts";

export interface CompanionBarProps {
  messages?: TrayMessage[];
  mode?: DesktopTrayMode;
  defaultMode?: DesktopTrayMode;
  micState?: MicState;
  defaultMicState?: MicState;
  placeholder?: string;
  hooks?: Partial<DesktopRuntimeHooks>;
  className?: string;
}

const DEFAULT_PLACEHOLDER = "Ask eliza…";

function combineClasses(
  ...parts: Array<string | false | null | undefined>
): string {
  return parts.filter((part): part is string => Boolean(part)).join(" ");
}

export function CompanionBar(props: CompanionBarProps) {
  const {
    messages = [],
    mode: controlledMode,
    defaultMode = "collapsed",
    micState: controlledMicState,
    defaultMicState = "off",
    placeholder = DEFAULT_PLACEHOLDER,
    hooks,
    className,
  } = props;

  const composerRef = useRef<HTMLFormElement | null>(null);
  const [composerEl, setComposerEl] = useState<HTMLFormElement | null>(null);
  const [draft, setDraft] = useState("");
  const panelId = useId();

  const isModeControlled = controlledMode !== undefined;
  const isMicControlled = controlledMicState !== undefined;

  const handleExpandChange = useCallback(
    (next: boolean) => {
      hooks?.onExpandChange?.(next);
    },
    [hooks],
  );

  const handleMicChange = useCallback(
    (next: MicState) => {
      hooks?.onMicStateChange?.(next);
    },
    [hooks],
  );

  const handlePushToTalkDown = useCallback(() => {
    hooks?.onPushToTalkDown?.();
  }, [hooks]);

  const handlePushToTalkUp = useCallback(() => {
    hooks?.onPushToTalkUp?.();
  }, [hooks]);

  const { isOpen, micState, setOpen, setMicState } = useKeyboardShortcuts(
    {
      onToggleExpand: handleExpandChange,
      onMicStateChange: handleMicChange,
      onPushToTalkDown: handlePushToTalkDown,
      onPushToTalkUp: handlePushToTalkUp,
    },
    { composerElement: composerEl },
  );

  useEffect(() => {
    if (isModeControlled) {
      setOpen(controlledMode === "expanded");
    } else if (defaultMode === "expanded") {
      setOpen(true);
    }
  }, [isModeControlled, controlledMode, defaultMode, setOpen]);

  useEffect(() => {
    if (isMicControlled && controlledMicState !== undefined) {
      setMicState(controlledMicState);
    } else if (defaultMicState !== "off") {
      setMicState(defaultMicState);
    }
  }, [isMicControlled, controlledMicState, defaultMicState, setMicState]);

  const effectiveMode: DesktopTrayMode = isOpen ? "expanded" : "collapsed";
  const effectiveMic = micState;

  const handlePillClick = useCallback(() => {
    setOpen(!isOpen);
  }, [isOpen, setOpen]);

  const handleSend = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const trimmed = draft.trim();
      if (!trimmed) {
        return;
      }
      hooks?.onSend?.(trimmed);
      setDraft("");
    },
    [draft, hooks],
  );

  const handleMicToggle = useCallback(() => {
    const next: MicState = effectiveMic === "always-on" ? "off" : "always-on";
    setMicState(next);
  }, [effectiveMic, setMicState]);

  const handleComposerKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLFormElement>) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    },
    [setOpen],
  );

  const showRedGlow =
    effectiveMode === "collapsed" && effectiveMic === "always-on";

  return (
    <div
      className={combineClasses("companion-bar-wrap", className)}
      data-mode={effectiveMode}
      data-mic={effectiveMic}
    >
      {effectiveMode === "expanded" ? (
        <section className="companion-bar-expanded" id={panelId}>
          <div className="companion-bar-messages" role="log" aria-live="polite">
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={combineClasses("companion-bar-msg", msg.role)}
              >
                {msg.text}
              </div>
            ))}
          </div>
          <form
            ref={(node) => {
              composerRef.current = node;
              setComposerEl(node);
            }}
            className="companion-bar-composer"
            onSubmit={handleSend}
            onKeyDown={handleComposerKeyDown}
          >
            <button
              type="button"
              className="companion-bar-btn"
              aria-label="Attach"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 5v14M5 12h14" />
              </svg>
            </button>
            <input
              type="text"
              className="companion-bar-input"
              placeholder={placeholder}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              aria-label="Message eliza"
            />
            <button
              type="button"
              className={combineClasses(
                "companion-bar-btn",
                effectiveMic === "always-on" && "mic-on",
              )}
              aria-label="Toggle microphone"
              aria-pressed={effectiveMic === "always-on"}
              onClick={handleMicToggle}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 4a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V7a3 3 0 0 0-3-3Z" />
                <path d="M5 11a7 7 0 0 0 14 0" />
                <path d="M12 18v3" />
                <path d="M9 21h6" />
              </svg>
            </button>
            <button
              type="submit"
              className="companion-bar-btn primary"
              aria-label="Send message"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M5 12h14" />
                <path d="M13 6l6 6-6 6" />
              </svg>
            </button>
          </form>
        </section>
      ) : null}
      <button
        type="button"
        className={combineClasses(
          "companion-bar-pill",
          "is-sky",
          showRedGlow && "is-glow-red",
        )}
        aria-expanded={effectiveMode === "expanded"}
        aria-controls={panelId}
        aria-label="elizaos companion"
        onClick={handlePillClick}
      />
    </div>
  );
}
