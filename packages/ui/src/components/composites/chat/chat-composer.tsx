import { Mic, Paperclip, Send, Square, Volume2, VolumeX } from "lucide-react";
import {
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";

import { Button } from "../../ui/button";
import { Textarea } from "../../ui/textarea";
import type { ChatVariant } from "./chat-types";
import { CreateTaskPopover } from "./create-task-popover";

export interface ChatComposerVoiceState {
  assistantTtsQuality?: "enhanced" | "standard";
  captureMode: "idle" | "compose" | "push-to-talk";
  interimTranscript: string;
  isListening: boolean;
  isSpeaking: boolean;
  startListening: (mode?: "compose" | "push-to-talk") => void | Promise<void>;
  stopListening: (options?: { submit?: boolean }) => void | Promise<void>;
  supported: boolean;
  toggleListening: () => void;
}

export interface ChatComposerProps {
  agentVoiceEnabled: boolean;
  chatInput: string;
  chatPendingImagesCount: number;
  chatSending: boolean;
  isAgentStarting: boolean;
  isComposerLocked: boolean;
  onAttachImage: () => void;
  onChatInputChange: (value: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onSend: () => void;
  onStop: () => void;
  onStopSpeaking: () => void;
  onToggleAgentVoice: () => void;
  showAgentVoiceToggle?: boolean;
  t: (key: string, options?: Record<string, unknown>) => string;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  variant: ChatVariant;
  voice: ChatComposerVoiceState;
  codingAgentsAvailable?: boolean;
  onCreateTask?: (description: string, agentType: string) => void;
}

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
  codingAgentsAvailable = false,
  onCreateTask,
}: ChatComposerProps) {
  const [isNarrow, setIsNarrow] = useState(
    () => typeof window !== "undefined" && window.innerWidth < 310,
  );

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(max-width: 309px)");
    const sync = () => setIsNarrow(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  const isGameModal = variant === "game-modal";
  const showVoiceButton = isGameModal || voice.supported;
  const defaultMicButtonVariant = voice.isListening
    ? "surfaceAccent"
    : "surface";
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pushToTalkActiveRef = useRef(false);
  const suppressClickRef = useRef(false);
  const hasDraft = chatInput.trim().length > 0 || chatPendingImagesCount > 0;
  const shouldShowStopButton = chatSending && !hasDraft;
  const actionButtonTitle = shouldShowStopButton
    ? t("chat.stopGeneration")
    : isGameModal || !voice.isSpeaking || hasDraft
      ? isAgentStarting
        ? t("chat.agentStarting")
        : t("chat.send")
      : t("chat.stopSpeaking");
  const actionButtonLabel = isGameModal ? undefined : actionButtonTitle;
  const inputPlaceholder = isNarrow
    ? t("chat.inputPlaceholderNarrow")
    : t("chat.inputPlaceholder");
  const defaultTextareaPlaceholder = isAgentStarting
    ? t("chat.agentStarting")
    : voice.isListening
      ? voice.captureMode === "push-to-talk"
        ? t("chat.releaseToSend")
        : !chatInput.trim()
          ? t("chat.listening")
          : inputPlaceholder
      : inputPlaceholder;

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
          ? "relative flex w-full items-end gap-2 transition-all max-[380px]:gap-1.5"
          : "flex items-end gap-1.5 sm:gap-2"
      }
    >
      {!isGameModal ? (
        <Button
          variant={chatPendingImagesCount > 0 ? "surfaceAccent" : "surface"}
          size="icon"
          className={`h-[46px] w-[46px] shrink-0 ${
            chatPendingImagesCount > 0 ? "ring-1 ring-inset ring-accent/25" : ""
          }`}
          onClick={onAttachImage}
          aria-label={t("aria.attachImage")}
          title={t("chatview.AttachImage")}
          disabled={isComposerLocked}
        >
          <Paperclip className="h-4 w-4" />
        </Button>
      ) : null}

      {!isGameModal && codingAgentsAvailable && onCreateTask && (
        <CreateTaskPopover
          chatInput={chatInput}
          disabled={isComposerLocked}
          onCreateTask={onCreateTask}
          t={t}
        />
      )}

      {showVoiceButton ? (
        <Button
          variant={isGameModal ? "ghost" : defaultMicButtonVariant}
          size="icon"
          className={
            isGameModal
              ? `flex items-center justify-center h-[46px] w-[46px] shrink-0 ${
                  voice.isListening
                    ? "animate-pulse select-none rounded-full border border-border/28 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_82%,transparent),color-mix(in_srgb,var(--bg)_66%,transparent))] text-txt shadow-[inset_0_1px_0_rgba(255,255,255,0.14),0_16px_26px_-24px_rgba(15,23,42,0.16)] ring-1 ring-inset ring-white/8 backdrop-blur-md transition-all duration-300 active:scale-95 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_18px_28px_-24px_rgba(0,0,0,0.3)]"
                    : "select-none rounded-full border border-transparent bg-transparent text-muted-strong shadow-none ring-0 backdrop-blur-none transition-[border-color,background-color,color,transform,box-shadow] duration-300 hover:border-border/28 hover:bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_74%,transparent),color-mix(in_srgb,var(--bg)_58%,transparent))] hover:text-txt active:scale-95"
                } ${isComposerLocked ? "opacity-50" : ""}`
              : "h-[46px] w-[46px] shrink-0"
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
                  ? t("chat.releaseToSend")
                  : t("chat.stopListening")
                : t("chat.voiceInput")
          }
          aria-pressed={isGameModal ? undefined : voice.isListening}
          title={
            isAgentStarting
              ? t("chat.agentStarting")
              : voice.isListening
                ? voice.captureMode === "push-to-talk"
                  ? t("chat.releaseToSend")
                  : t("chat.stopListening")
                : voice.assistantTtsQuality === "enhanced"
                  ? t("chat.micTitleIdleEnhanced")
                  : t("chat.micTitleIdleStandard")
          }
          disabled={isComposerLocked}
        >
          <Mic className={isGameModal ? "h-5 w-5" : "h-4 w-4"} />
        </Button>
      ) : null}

      <div className="relative min-w-0 flex-1">
        <Textarea
          ref={textareaRef}
          value={chatInput}
          onChange={(event) => onChatInputChange(event.target.value)}
          onKeyDown={onKeyDown}
          data-testid="chat-composer-textarea"
          className={
            isGameModal
              ? "w-full min-w-0 min-h-0 h-[46px] resize-none overflow-y-hidden max-h-[200px] outline-none ring-0 shadow-none focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0 font-[var(--font-chat)] disabled:opacity-50 rounded-3xl border border-transparent bg-transparent px-4 pb-[13px] pt-[13px] text-[15px] leading-[1.55] text-txt-strong placeholder:text-muted"
              : "w-full min-w-0 min-h-0 h-[46px] resize-none overflow-y-hidden max-h-[200px] outline-none ring-0 shadow-none focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0 font-[var(--font-chat)] disabled:opacity-50 rounded-3xl border border-border/28 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_82%,transparent),color-mix(in_srgb,var(--bg)_96%,transparent))] px-4 py-[13px] text-[15px] leading-[1.55] text-txt shadow-[inset_0_1px_0_rgba(255,255,255,0.12),0_18px_24px_-22px_rgba(15,23,42,0.12)] placeholder:text-muted"
          }
          placeholder={defaultTextareaPlaceholder}
          rows={1}
          disabled={isComposerLocked}
        />
        {voice.isListening && voice.interimTranscript ? (
          <div className="pointer-events-none absolute inset-x-4 bottom-2.5 truncate text-xs-tight text-muted">
            {voice.interimTranscript}
          </div>
        ) : null}
      </div>

      {showAgentVoiceToggle ? (
        <Button
          variant={
            isGameModal
              ? "ghost"
              : agentVoiceEnabled
                ? "surfaceAccent"
                : "surface"
          }
          size="icon"
          className={
            isGameModal
              ? `flex items-center justify-center h-[46px] w-[46px] shrink-0 ${
                  agentVoiceEnabled
                    ? "select-none rounded-full border border-border/28 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_82%,transparent),color-mix(in_srgb,var(--bg)_66%,transparent))] text-txt shadow-[inset_0_1px_0_rgba(255,255,255,0.14),0_16px_26px_-24px_rgba(15,23,42,0.16)] ring-1 ring-inset ring-white/8 backdrop-blur-md transition-all duration-300 active:scale-95 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_18px_28px_-24px_rgba(0,0,0,0.3)]"
                    : "select-none rounded-full border border-transparent bg-transparent text-muted-strong shadow-none ring-0 backdrop-blur-none transition-[border-color,background-color,color,transform,box-shadow] duration-300 hover:border-border/28 hover:bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_74%,transparent),color-mix(in_srgb,var(--bg)_58%,transparent))] hover:text-txt active:scale-95"
                }`
              : "h-[46px] w-[46px] shrink-0"
          }
          onClick={onToggleAgentVoice}
          aria-label={
            agentVoiceEnabled ? t("aria.agentVoiceOn") : t("aria.agentVoiceOff")
          }
          title={
            agentVoiceEnabled ? t("chat.agentVoiceOn") : t("chat.agentVoiceOff")
          }
          disabled={isComposerLocked}
        >
          {agentVoiceEnabled ? (
            <Volume2 className={isGameModal ? "h-5 w-5" : "h-4 w-4"} />
          ) : (
            <VolumeX className={isGameModal ? "h-5 w-5" : "h-4 w-4"} />
          )}
        </Button>
      ) : null}

      {shouldShowStopButton ? (
        <Button
          variant="surfaceDestructive"
          data-testid="chat-composer-action"
          className="ml-1 flex items-center justify-center rounded-full transition-all duration-300 select-none active:scale-95 h-[46px] w-[46px] shrink-0"
          onClick={onStop}
          size="icon"
          title={actionButtonLabel}
          aria-label={actionButtonLabel}
        >
          <Square className={isGameModal ? "h-4.5 w-4.5" : "h-4 w-4"} />
        </Button>
      ) : !isGameModal && voice.isSpeaking && !hasDraft ? (
        <Button
          variant="surfaceDestructive"
          data-testid="chat-composer-action"
          className="ml-1 flex items-center justify-center rounded-full transition-all duration-300 select-none active:scale-95 h-[46px] w-[46px] shrink-0"
          onClick={onStopSpeaking}
          size="icon"
          title={actionButtonLabel}
          aria-label={actionButtonLabel}
        >
          <Square className="h-4 w-4" />
        </Button>
      ) : (
        <Button
          variant={isGameModal ? "default" : "surfaceAccent"}
          data-testid="chat-composer-action"
          size="icon"
          className={
            isGameModal
              ? `ml-1 flex items-center justify-center rounded-full transition-all duration-300 select-none active:scale-95 h-[46px] w-[46px] shrink-0 ${
                  hasDraft
                    ? "select-none rounded-full border border-border/28 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_82%,transparent),color-mix(in_srgb,var(--bg)_66%,transparent))] text-txt shadow-[inset_0_1px_0_rgba(255,255,255,0.14),0_16px_26px_-24px_rgba(15,23,42,0.16)] ring-1 ring-inset ring-white/8 backdrop-blur-md transition-all duration-300 active:scale-95 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_18px_28px_-24px_rgba(0,0,0,0.3)]"
                    : "select-none rounded-full border border-transparent bg-transparent text-muted-strong shadow-none ring-0 backdrop-blur-none transition-[border-color,background-color,color,transform,box-shadow] duration-300 hover:border-border/28 hover:bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_74%,transparent),color-mix(in_srgb,var(--bg)_58%,transparent))] hover:text-txt active:scale-95 opacity-80"
                }`
              : "ml-1 flex items-center justify-center rounded-full transition-all duration-300 select-none active:scale-95 h-[46px] w-[46px] shrink-0 border-accent/26 disabled:ring-0"
          }
          onClick={onSend}
          disabled={isComposerLocked || (!hasDraft && !chatSending)}
          title={actionButtonLabel}
          aria-label={actionButtonLabel}
        >
          <Send className={isGameModal ? "h-4.5 w-4.5" : "h-4 w-4"} />
        </Button>
      )}
    </div>
  );
}
