import { useCallback, useMemo, useState } from "react";

export type ComposerMode = "idle" | "voice" | "dictate";

export interface ComposerBarProps {
  onSend?: (text: string) => void;
  onDictateStart?: () => void;
  onDictateStop?: (text: string) => void;
  onVoiceStart?: () => void;
  onVoiceStop?: () => void;
  onAttach?: () => void;
  placeholder?: string;
  className?: string;
}

export function describeRightButton(args: {
  hasText: boolean;
  mode: ComposerMode;
}): "send" | "voice" | "check" {
  if (args.mode === "dictate") return "check";
  if (args.hasText) return "send";
  return "voice";
}

export function ComposerBar(props: ComposerBarProps): JSX.Element {
  const {
    onSend,
    onDictateStart,
    onDictateStop,
    onVoiceStart,
    onVoiceStop,
    onAttach,
    placeholder = "Ask anything",
    className,
  } = props;
  const [text, setText] = useState("");
  const [mode, setMode] = useState<ComposerMode>("idle");
  const hasText = text.trim().length > 0;
  const rightKind = useMemo(
    () => describeRightButton({ hasText, mode }),
    [hasText, mode],
  );

  const handleSend = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed) return;
    onSend?.(trimmed);
    setText("");
  }, [text, onSend]);

  const handleRight = useCallback(() => {
    if (rightKind === "send") {
      handleSend();
      return;
    }
    if (rightKind === "check") {
      onDictateStop?.(text);
      setMode("idle");
      return;
    }
    if (mode === "voice") {
      onVoiceStop?.();
      setMode("idle");
      return;
    }
    setMode("voice");
    onVoiceStart?.();
  }, [
    rightKind,
    mode,
    text,
    handleSend,
    onDictateStop,
    onVoiceStart,
    onVoiceStop,
  ]);

  const handleDictate = useCallback(() => {
    if (mode === "dictate") {
      onDictateStop?.(text);
      setMode("idle");
      return;
    }
    setMode("dictate");
    onDictateStart?.();
  }, [mode, text, onDictateStart, onDictateStop]);

  const voiceActive = mode === "voice";

  return (
    <form
      data-eliza-composer=""
      data-mode={mode}
      className={className}
      onSubmit={(event) => {
        event.preventDefault();
        if (rightKind === "send") handleSend();
      }}
      style={{
        display: "grid",
        gridTemplateColumns: "38px 1fr 38px 44px",
        alignItems: "center",
        gap: 8,
        minHeight: 58,
        borderRadius: 999,
        padding: 7,
        background: "rgba(6, 19, 31, 0.26)",
        boxShadow:
          "inset 0 0 0 1px rgba(255, 255, 255, 0.18), 0 18px 46px rgba(0, 0, 0, 0.16)",
      }}
    >
      <button
        type="button"
        aria-label="Attach"
        onClick={onAttach}
        data-eliza-composer-attach=""
        style={iconButtonStyle()}
      >
        <svg viewBox="0 0 24 24" style={iconSvgStyle()}>
          <path d="M12 5v14M5 12h14" />
        </svg>
      </button>
      {voiceActive ? (
        <div
          aria-hidden="true"
          data-eliza-composer-waveform=""
          style={{
            display: "flex",
            alignItems: "center",
            gap: 3,
            minWidth: 0,
            height: 38,
          }}
        >
          {Array.from({ length: 24 }).map((_, idx) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: decorative
              key={idx}
              style={{
                display: "block",
                flex: 1,
                maxWidth: 6,
                height: 12,
                borderRadius: 999,
                background: "rgba(255, 255, 255, 0.76)",
                animation: `eliza-composer-meter 0.86s ease-in-out ${idx * 0.04}s infinite`,
              }}
            />
          ))}
        </div>
      ) : (
        <input
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={placeholder}
          autoComplete="off"
          data-eliza-composer-input=""
          style={{
            minWidth: 0,
            height: 38,
            border: 0,
            outline: "none",
            background: "transparent",
            color: "#ffffff",
            fontSize: 14,
            fontFamily: "inherit",
          }}
        />
      )}
      <button
        type="button"
        aria-label={mode === "dictate" ? "Cancel dictation" : "Dictate"}
        onClick={handleDictate}
        data-eliza-composer-dictate=""
        data-active={mode === "dictate" ? "true" : "false"}
        style={iconButtonStyle()}
      >
        {mode === "dictate" ? (
          <svg viewBox="0 0 24 24" style={iconSvgStyle()}>
            <path d="M6 6l12 12M6 18l12-12" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" style={iconSvgStyle()}>
            <path d="M12 4a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V7a3 3 0 0 0-3-3Z" />
            <path d="M5 11a7 7 0 0 0 14 0" />
            <path d="M12 18v3" />
            <path d="M9 21h6" />
          </svg>
        )}
      </button>
      <button
        type="button"
        aria-label={
          rightKind === "send"
            ? "Send"
            : rightKind === "check"
              ? "Confirm"
              : voiceActive
                ? "Stop voice"
                : "Continuous voice"
        }
        onClick={handleRight}
        data-eliza-composer-action=""
        data-kind={rightKind}
        style={iconButtonStyle(true)}
      >
        {rightKind === "send" ? (
          <svg viewBox="0 0 24 24" style={iconSvgStyle(true)}>
            <path d="M5 12h14" />
            <path d="M13 6l6 6-6 6" />
          </svg>
        ) : rightKind === "check" ? (
          <svg viewBox="0 0 24 24" style={iconSvgStyle(true)}>
            <path d="M5 12l5 5L20 7" />
          </svg>
        ) : voiceActive ? (
          <svg viewBox="0 0 24 24" style={iconSvgStyle(true)}>
            <rect x="6" y="6" width="12" height="12" rx="2" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" style={iconSvgStyle(true)}>
            <path d="M4 12h.01" />
            <path d="M7 10v4" />
            <path d="M10 7.5v9" />
            <path d="M13 5.5v13" />
            <path d="M16 8.5v7" />
            <path d="M19 11v2" />
          </svg>
        )}
      </button>
      <style>{`
        @keyframes eliza-composer-meter {
          0%, 100% { height: 6px; }
          50% { height: 22px; }
        }
      `}</style>
    </form>
  );
}

function iconButtonStyle(primary = false): React.CSSProperties {
  return {
    display: "grid",
    placeItems: "center",
    width: primary ? 44 : 38,
    height: primary ? 44 : 38,
    borderRadius: "50%",
    background: primary ? "rgba(255,255,255,0.94)" : "rgba(255,255,255,0.16)",
    color: primary ? "#06131f" : "rgba(255,255,255,0.9)",
    border: 0,
    cursor: "pointer",
  };
}

function iconSvgStyle(primary = false): React.CSSProperties {
  return {
    display: "block",
    width: primary ? 23 : 19,
    height: primary ? 23 : 19,
    fill: "none",
    stroke: "currentColor",
    strokeWidth: primary ? 2 : 1.75,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    pointerEvents: "none",
  };
}
