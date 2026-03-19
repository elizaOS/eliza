import { Button, Textarea } from "@elizaos/ui";
import { Mic, Paperclip, Send, Square, Volume2, VolumeX } from "lucide-react";
import {
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
  useEffect,
  useRef,
} from "react";

type ChatComposerVariant = "default" | "game-modal";

interface ChatComposerVoiceState {
  supported: boolean;
  isListening: boolean;
  captureMode: "idle" | "compose" | "push-to-talk";
  interimTranscript: string;
  isSpeaking: boolean;
  toggleListening: () => void;
  startListening: (mode?: "compose" | "push-to-talk") => void | Promise<void>;
  stopListening: (options?: { submit?: boolean }) => void | Promise<void>;
}

interface ChatComposerProps {
  variant: ChatComposerVariant;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  chatInput: string;
  chatPendingImagesCount: number;
  isComposerLocked: boolean;
  isAgentStarting: boolean;
  chatSending: boolean;
  voice: ChatComposerVoiceState;
  agentVoiceEnabled: boolean;
  showAgentVoiceToggle?: boolean;
  t: (key: string) => string;
  onAttachImage: () => void;
  onChatInputChange: (value: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onSend: () => void;
  onStop: () => void;
  onStopSpeaking: () => void;
  onToggleAgentVoice: () => void;
}

const COMPOSER_CONTROL_HEIGHT_CLASSNAME = "h-[46px]";
const COMPOSER_ICON_BUTTON_CLASSNAME = `${COMPOSER_CONTROL_HEIGHT_CLASSNAME} w-[46px] shrink-0`;
const COMPOSER_ACTION_BUTTON_CLASSNAME = `ml-1 flex items-center justify-center rounded-full transition-all ${COMPOSER_ICON_BUTTON_CLASSNAME}`;
const COMMON_TEXTAREA_CLASSNAME = `w-full min-w-0 min-h-0 ${COMPOSER_CONTROL_HEIGHT_CLASSNAME} resize-none overflow-y-hidden max-h-[200px] outline-none ring-0 shadow-none focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0 font-[var(--font-chat)] disabled:opacity-50`;

export function ChatComposer({
  variant,
  textareaRef,
  chatInput,
  chatPendingImagesCount,
  isComposerLocked,
  isAgentStarting,
  chatSending,
  voice,
  agentVoiceEnabled,
  showAgentVoiceToggle = true,
  t,
  onAttachImage,
  onChatInputChange,
  onKeyDown,
  onSend,
  onStop,
  onStopSpeaking,
  onToggleAgentVoice,
}: ChatComposerProps) {
  const isGameModal = variant === "game-modal";
  const showVoiceButton = isGameModal || voice.supported;
  const defaultMicButtonClassName = voice.isListening
    ? "text-white shadow-sm hover:text-white"
    : "text-muted hover:bg-black/5 hover:text-txt";
  const micIconClassName = isGameModal ? "w-5 h-5 text-[#fff1f2]" : "w-4 h-4";
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pushToTalkActiveRef = useRef(false);
  const suppressClickRef = useRef(false);
  const actionButtonTitle = chatSending
    ? t("chat.stopGeneration")
    : isGameModal || !voice.isSpeaking
      ? isAgentStarting
        ? t("chat.agentStarting")
        : t("chat.send")
      : t("chat.stopSpeaking");
  const actionButtonLabel = isGameModal ? undefined : actionButtonTitle;
  const defaultTextareaPlaceholder = isAgentStarting
    ? t("chat.agentStarting")
    : voice.isListening
      ? voice.captureMode === "push-to-talk"
        ? "Release to send..."
        : !chatInput.trim()
          ? "Listening..."
          : t("chat.inputPlaceholder")
      : t("chat.inputPlaceholder");

  useEffect(() => {
    return () => {
      if (holdTimerRef.current) {
        clearTimeout(holdTimerRef.current);
        holdTimerRef.current = null;
      }
    };
  }, []);

  const startPushToTalk = () => {
    if (isComposerLocked || voice.isListening) return;
    pushToTalkActiveRef.current = true;
    suppressClickRef.current = true;
    void voice.startListening("push-to-talk");
  };

  const clearHoldTimer = () => {
    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
  };

  const handleMicPointerDown = (_event: PointerEvent<HTMLButtonElement>) => {
    if (isComposerLocked || voice.isListening) return;
    clearHoldTimer();
    holdTimerRef.current = setTimeout(() => {
      holdTimerRef.current = null;
      startPushToTalk();
    }, 180);
  };

  const handleMicPointerUp = () => {
    clearHoldTimer();
    if (!pushToTalkActiveRef.current) return;
    pushToTalkActiveRef.current = false;
    void voice.stopListening({ submit: true });
    window.setTimeout(() => {
      suppressClickRef.current = false;
    }, 0);
  };

  const handleMicPointerCancel = () => {
    clearHoldTimer();
    if (!pushToTalkActiveRef.current) return;
    pushToTalkActiveRef.current = false;
    void voice.stopListening();
    window.setTimeout(() => {
      suppressClickRef.current = false;
    }, 0);
  };

  const handleMicClick = () => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    if (isComposerLocked) return;
    if (voice.isListening && voice.captureMode === "compose") {
      void voice.stopListening();
      return;
    }
    if (voice.isListening) return;
    void voice.startListening("compose");
  };

  return (
    <div
      className={
        isGameModal
          ? "relative flex items-end gap-1 transition-all"
          : "flex items-end gap-1.5 sm:gap-2"
      }
    >
      {!isGameModal && (
        <Button
          variant={chatPendingImagesCount > 0 ? "secondary" : "ghost"}
          size="icon"
          className={`${COMPOSER_ICON_BUTTON_CLASSNAME} ${chatPendingImagesCount > 0
            ? "bg-accent/10 sm:hover:bg-accent/20 border-accent/20 text-txt/80 hover:text-txt shadow-sm"
            : "text-muted hover:bg-black/5 hover:text-txt"
            }`}
          onClick={onAttachImage}
          aria-label="Attach image"
          title={t("chatview.AttachImage")}
          disabled={isComposerLocked}
        >
          <Paperclip className="w-4 h-4" />
        </Button>
      )}

      {showVoiceButton && (
        <Button
          variant="ghost"
          size="icon"
          className={
            isGameModal
              ? `mr-2 flex items-center justify-center rounded-full transition-all ${COMPOSER_ICON_BUTTON_CLASSNAME} ${voice.isListening
                ? "animate-pulse border text-[#fff1f2] shadow-[0_0_30px_rgba(255,107,112,0.5)]"
                : "bg-transparent text-[#fff1f2] shadow-[0_0_6px_rgba(255,107,112,0.25)] hover:bg-[#ff6b70]/10"
              } ${isComposerLocked ? "opacity-50" : ""}`
              : `${COMPOSER_ICON_BUTTON_CLASSNAME} ${defaultMicButtonClassName}`
          }
          onClick={handleMicClick}
          onPointerDown={handleMicPointerDown}
          onPointerUp={handleMicPointerUp}
          onPointerCancel={handleMicPointerCancel}
          onPointerLeave={handleMicPointerCancel}
          aria-label={
            isAgentStarting
              ? t("chat.agentStarting")
              : voice.isListening
                ? voice.captureMode === "push-to-talk"
                  ? "Release to send"
                  : t("chat.stopListening")
                : t("chat.voiceInput")
          }
          aria-pressed={isGameModal ? undefined : voice.isListening}
          title={
            isAgentStarting
              ? t("chat.agentStarting")
              : voice.isListening
                ? voice.captureMode === "push-to-talk"
                  ? "Release to send"
                  : t("chat.stopListening")
                : "Click to dictate. Hold to talk and send."
          }
          disabled={isComposerLocked}
        >
          <Mic className={micIconClassName} />
        </Button>
      )}

      <div
        className={
          isGameModal
            ? "flex min-h-[46px] flex-1 items-center rounded-2xl bg-black/40 transition-all min-w-0"
            : "flex min-h-[46px] flex-1 items-center rounded-md border min-w-0 border-border/40 bg-card/60 backdrop-blur-md"
        }
      >
        <Textarea
          ref={textareaRef}
          data-testid="chat-composer-textarea"
          className={
            isGameModal
              ? `${COMMON_TEXTAREA_CLASSNAME} px-4 py-2 bg-transparent border-none text-[15px] leading-relaxed text-white placeholder:text-white/30 max-h-[150px]`
              : `${COMMON_TEXTAREA_CLASSNAME} px-3 py-2 bg-transparent border-none text-[15px] leading-[1.7] text-txt placeholder:text-muted`
          }
          style={{ fontFamily: "var(--font-chat)" }}
          rows={1}
          aria-label="Chat message"
          placeholder={
            isGameModal
              ? isAgentStarting
                ? t("chat.agentStarting")
                : voice.isListening
                  ? voice.captureMode === "push-to-talk"
                    ? "Release to send..."
                    : t("chat.listening")
                  : t("chat.inputPlaceholder")
              : defaultTextareaPlaceholder
          }
          value={chatInput}
          onChange={(event) => onChatInputChange(event.target.value)}
          onKeyDown={onKeyDown}
          disabled={isComposerLocked}
        />
      </div>

      {showAgentVoiceToggle && (
        <Button
          variant="ghost"
          size="icon"
          className={
            isGameModal
              ? `${COMPOSER_ICON_BUTTON_CLASSNAME} rounded-full bg-black/35 text-white/75 hover:bg-black/55 hover:text-white`
              : `${COMPOSER_ICON_BUTTON_CLASSNAME} border border-border/50 bg-card/70 text-muted hover:text-txt hover:bg-bg`
          }
          onClick={onToggleAgentVoice}
          aria-label={agentVoiceEnabled ? "Agent voice on" : "Agent voice off"}
          aria-pressed={agentVoiceEnabled}
          title={agentVoiceEnabled ? "Agent voice on" : "Agent voice off"}
        >
          {agentVoiceEnabled ? (
            <Volume2 className="h-4 w-4" />
          ) : (
            <VolumeX className="h-4 w-4" />
          )}
        </Button>
      )}

      {chatSending ? (
        <Button
          variant="destructive"
          data-testid="chat-composer-action"
          className={`${COMPOSER_ACTION_BUTTON_CLASSNAME} bg-danger/20 text-danger hover:bg-danger/30`}
          onClick={onStop}
          size="icon"
          title={actionButtonLabel}
          aria-label={actionButtonLabel}
        >
          <Square className="w-4 h-4 fill-current" />
        </Button>
      ) : !isGameModal && voice.isSpeaking ? (
        <Button
          variant="destructive"
          data-testid="chat-composer-action"
          className={`${COMPOSER_ACTION_BUTTON_CLASSNAME} bg-danger/20 text-danger hover:bg-danger/30`}
          onClick={onStopSpeaking}
          size="icon"
          title={actionButtonLabel}
          aria-label={actionButtonLabel}
        >
          <Square className="w-4 h-4 fill-current" />
        </Button>
      ) : (
        <Button
          variant="default"
          data-testid="chat-composer-action"
          size="icon"
          className={`${COMPOSER_ACTION_BUTTON_CLASSNAME} bg-accent text-accent-fg hover:shadow-[0_0_15px_rgba(240,178,50,0.4)] disabled:opacity-40`}
          onClick={onSend}
          disabled={isComposerLocked || !chatInput.trim()}
          aria-label={actionButtonLabel}
          title={actionButtonLabel}
        >
          <Send className="w-5 h-5" />
        </Button>
      )}
    </div>
  );
}
