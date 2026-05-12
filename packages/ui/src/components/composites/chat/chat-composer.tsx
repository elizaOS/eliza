import {
  ArrowUp,
  Mic,
  Paperclip,
  Plus,
  Send,
  Square,
  Volume2,
  VolumeX,
} from "lucide-react";
// biome-ignore lint/correctness/noUnusedImports: Required for this package's JSX transform in tests.
import * as React from "react";
import {
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { VoiceSessionMode } from "../../../voice/voice-chat-types";
import { Button } from "../../ui/button";
import { Textarea } from "../../ui/textarea";
import type { ChatVariant } from "./chat-types";
import { CreateTaskPopover } from "./create-task-popover";

const INLINE_TEXTAREA_MIN_HEIGHT_PX = 32;
const INLINE_TEXTAREA_MAX_HEIGHT_PX = 128;
const INLINE_STACKED_INLINE_PADDING_PX = 12;

const inlineTextareaClass =
  "block h-8 max-h-[128px] min-h-0 w-full min-w-0 resize-none overflow-y-hidden appearance-none rounded-none border-0 bg-transparent px-2 py-[6px] text-sm leading-5 text-txt shadow-none outline-none ring-0 placeholder:text-muted/60 focus:!border-0 focus:!outline-none focus:!ring-0 focus-visible:!border-0 focus-visible:!outline-none focus-visible:!ring-0 focus-visible:!ring-offset-0 focus-visible:!shadow-none";

const inlineMeasureTextareaClass = `${inlineTextareaClass} pointer-events-none fixed left-0 top-0 z-[-1] opacity-0`;

const chatComposerFocusResetClass =
  "[&_button:focus]:!outline-none [&_button:focus-visible]:!outline-none [&_button:focus-visible]:!ring-0 [&_button:focus-visible]:!ring-offset-0 [&_button:focus-visible]:!shadow-none [&_textarea:focus]:!outline-none [&_textarea:focus-visible]:!outline-none [&_textarea:focus-visible]:!ring-0 [&_textarea:focus-visible]:!ring-offset-0 [&_textarea:focus-visible]:!shadow-none";

type InlineTextareaMeasurement = {
  scrollHeight: number;
  wraps: boolean;
};

function getTextareaVerticalPadding(textarea: HTMLTextAreaElement): number {
  const styles = window.getComputedStyle(textarea);
  const paddingTop = Number.parseFloat(styles.paddingTop);
  const paddingBottom = Number.parseFloat(styles.paddingBottom);
  const verticalPadding = paddingTop + paddingBottom;
  if (
    Number.isFinite(paddingTop) &&
    Number.isFinite(paddingBottom) &&
    verticalPadding > 0
  ) {
    return verticalPadding;
  }
  return 12;
}

function getTextareaLineHeight(textarea: HTMLTextAreaElement): number {
  const lineHeight = Number.parseFloat(
    window.getComputedStyle(textarea).lineHeight,
  );
  return Number.isFinite(lineHeight) && lineHeight > 0 ? lineHeight : 20;
}

function measureInlineTextarea(
  textarea: HTMLTextAreaElement,
  value: string,
  width: number,
): InlineTextareaMeasurement {
  textarea.value = value.endsWith("\n") ? `${value} ` : value || " ";
  textarea.style.width = `${Math.max(1, width)}px`;
  textarea.style.height = "auto";
  textarea.style.overflowY = "hidden";

  const scrollHeight = textarea.scrollHeight;
  const contentHeight = Math.max(
    0,
    scrollHeight - getTextareaVerticalPadding(textarea),
  );
  const lineHeight = getTextareaLineHeight(textarea);

  return {
    scrollHeight,
    wraps: contentHeight > lineHeight * 1.25,
  };
}

export interface ChatComposerVoiceState {
  assistantTtsQuality?: "enhanced" | "standard";
  captureMode: VoiceSessionMode;
  interimTranscript: string;
  isListening: boolean;
  isSpeaking: boolean;
  startListening: (
    mode?: Exclude<VoiceSessionMode, "idle">,
  ) => void | Promise<void>;
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
  layout?: "default" | "inline";
  onAttachImage: () => void;
  onChatInputChange: (value: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onSend: () => void;
  onStop: () => void;
  onStopSpeaking: () => void;
  onToggleAgentVoice: () => void;
  showAgentVoiceToggle?: boolean;
  t: (key: string, options?: Record<string, unknown>) => string;
  textareaAriaLabel?: string;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  variant: ChatVariant;
  voice: ChatComposerVoiceState;
  codingAgentsAvailable?: boolean;
  onCreateTask?: (description: string, agentType: string) => void;
  /** Hide the attach-image button (used where outbound attachments aren't supported). */
  hideAttachButton?: boolean;
  /** Placeholder override for the textarea. */
  placeholder?: string;
}

export function ChatComposer({
  variant,
  layout = "default",
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
  hideAttachButton = false,
  placeholder,
  textareaAriaLabel,
}: ChatComposerProps) {
  const [isNarrow, setIsNarrow] = useState(
    () => typeof window !== "undefined" && window.innerWidth < 310,
  );
  const [isInlineMultiline, setIsInlineMultiline] = useState(false);
  const [inlineMeasureVersion, setInlineMeasureVersion] = useState(0);
  const inlineRootRef = useRef<HTMLDivElement | null>(null);
  const inlineMeasureRef = useRef<HTMLTextAreaElement | null>(null);
  const lastInlineSingleLineWidthRef = useRef<number | null>(null);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(max-width: 309px)");
    const sync = () => setIsNarrow(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  const isGameModal = variant === "game-modal";
  const isInline = layout === "inline";
  const showVoiceButton = isGameModal || voice.supported;
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
        : t("common.send")
      : t("chat.stopSpeaking");
  const actionButtonLabel = isGameModal ? undefined : actionButtonTitle;
  const inputPlaceholder = isNarrow ? t("common.message") : t("common.message");
  const voiceButtonTitle = isAgentStarting
    ? t("chat.agentStarting")
    : voice.isListening
      ? voice.captureMode === "push-to-talk"
        ? t("chat.releaseToSend")
        : t("chat.stopListening")
      : voice.assistantTtsQuality === "enhanced"
        ? t("chat.micTitleIdleEnhanced")
        : t("chat.micTitleIdleStandard");
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

  useEffect(() => {
    if (!isInline) return;
    const root = inlineRootRef.current;
    if (!root || typeof ResizeObserver === "undefined") return;

    let frame = 0;
    const observer = new ResizeObserver(() => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        setInlineMeasureVersion((version) => version + 1);
      });
    });
    observer.observe(root);

    return () => {
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [isInline]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: inlineMeasureVersion is a ResizeObserver tick that reruns measurement after width changes.
  useLayoutEffect(() => {
    if (!isInline) {
      setIsInlineMultiline(false);
      lastInlineSingleLineWidthRef.current = null;
      return;
    }
    const textarea = textareaRef.current;
    const measureTextarea = inlineMeasureRef.current;
    const root = inlineRootRef.current;
    if (!textarea || !measureTextarea || !root) return;

    const measuredSingleLineWidth =
      textarea.clientWidth > 0 ? textarea.clientWidth : null;
    const currentSingleLineWidth = isInlineMultiline
      ? lastInlineSingleLineWidthRef.current
      : measuredSingleLineWidth;
    if (!isInlineMultiline && measuredSingleLineWidth) {
      lastInlineSingleLineWidthRef.current = measuredSingleLineWidth;
    }

    const decisionWidth =
      currentSingleLineWidth ??
      Math.max(1, root.clientWidth - INLINE_STACKED_INLINE_PADDING_PX);
    const stackedWidth = Math.max(
      1,
      root.clientWidth - INLINE_STACKED_INLINE_PADDING_PX,
    );
    const decision = measureInlineTextarea(
      measureTextarea,
      chatInput,
      decisionWidth,
    );
    const nextIsInlineMultiline = chatInput.includes("\n") || decision.wraps;
    const heightMeasurement = nextIsInlineMultiline
      ? measureInlineTextarea(measureTextarea, chatInput, stackedWidth)
      : decision;
    const nextHeight = nextIsInlineMultiline
      ? Math.min(
          Math.max(
            heightMeasurement.scrollHeight,
            INLINE_TEXTAREA_MIN_HEIGHT_PX,
          ),
          INLINE_TEXTAREA_MAX_HEIGHT_PX,
        )
      : INLINE_TEXTAREA_MIN_HEIGHT_PX;

    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY =
      heightMeasurement.scrollHeight > INLINE_TEXTAREA_MAX_HEIGHT_PX
        ? "auto"
        : "hidden";
    setIsInlineMultiline(nextIsInlineMultiline);
  }, [
    chatInput,
    inlineMeasureVersion,
    isInline,
    isInlineMultiline,
    textareaRef,
  ]);

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

  const renderCreateTaskButton = () => {
    if (isGameModal || !codingAgentsAvailable || !onCreateTask) {
      return null;
    }

    return (
      <CreateTaskPopover
        chatInput={chatInput}
        disabled={isComposerLocked}
        onCreateTask={onCreateTask}
        t={t}
        triggerVariant={isInline ? "ghost" : "surface"}
        triggerClassName={
          isInline
            ? "h-8 w-8 shrink-0 rounded-full bg-bg/60 p-0 text-muted shadow-none transition-colors hover:bg-bg/60 hover:text-txt focus-visible:ring-0 focus-visible:ring-offset-0"
            : "h-[46px] w-[46px] shrink-0"
        }
        triggerIconClassName={isInline ? "h-4.5 w-4.5" : "h-4 w-4"}
      />
    );
  };

  if (isInline) {
    const inlineAttachButton =
      !isGameModal && !hideAttachButton ? (
        <Button
          variant="ghost"
          size="icon"
          className={`h-8 w-8 shrink-0 rounded-full bg-bg/60 p-0 text-muted shadow-none transition-colors hover:bg-bg/60 hover:text-txt focus-visible:ring-0 focus-visible:ring-offset-0 ${
            chatPendingImagesCount > 0 ? "text-accent hover:text-accent" : ""
          }`}
          onClick={onAttachImage}
          aria-label={t("aria.attachImage")}
          title={t("aria.attachImage")}
          disabled={isComposerLocked}
        >
          <Plus className="h-5 w-5" />
        </Button>
      ) : null;

    const inlineTextarea = (
      <div
        className={
          isInlineMultiline
            ? "relative min-w-0 w-full"
            : "relative min-w-0 flex-1"
        }
      >
        <Textarea
          ref={textareaRef}
          value={chatInput}
          onChange={(event) => onChatInputChange(event.target.value)}
          onKeyDown={onKeyDown}
          data-testid="chat-composer-textarea"
          aria-label={textareaAriaLabel}
          variant={null}
          density={null}
          className={inlineTextareaClass}
          placeholder={placeholder ?? defaultTextareaPlaceholder}
          rows={1}
          disabled={isComposerLocked}
        />
        {voice.isListening && voice.interimTranscript ? (
          <div
            className={
              isInlineMultiline
                ? "pointer-events-none absolute inset-x-3 bottom-2 truncate text-xs text-muted"
                : "pointer-events-none absolute inset-x-2 bottom-2 truncate text-xs text-muted"
            }
          >
            {voice.interimTranscript}
          </div>
        ) : null}
      </div>
    );

    const inlineMicButton = (
      <Button
        variant="ghost"
        size="icon"
        className={`h-8 w-8 shrink-0 rounded-full p-0 shadow-none transition-colors focus-visible:ring-0 focus-visible:ring-offset-0 active:scale-95 ${
          voice.isListening
            ? "bg-accent text-bg hover:bg-accent/90 hover:text-bg"
            : "bg-bg/60 text-muted hover:bg-bg/60 hover:text-txt"
        }`}
        onClick={handleMicClick}
        onPointerDown={handleMicPointerDown}
        onPointerUp={handleMicPointerUp}
        onPointerCancel={handleMicPointerCancel}
        onPointerLeave={handleMicPointerCancel}
        disabled={isComposerLocked || !voice.supported}
        title={voiceButtonTitle}
        aria-label={voiceButtonTitle}
        aria-pressed={voice.isListening}
      >
        <Mic className="h-4.5 w-4.5" />
      </Button>
    );

    const inlineSendButton = (
      <Button
        variant="ghost"
        data-testid="chat-composer-action"
        size="icon"
        className="h-8 w-8 shrink-0 rounded-full bg-txt p-0 text-bg shadow-none transition-transform focus-visible:ring-0 focus-visible:ring-offset-0 active:scale-95 disabled:opacity-40"
        onClick={onSend}
        disabled={isComposerLocked || !hasDraft}
        title={actionButtonLabel}
        aria-label={actionButtonLabel}
      >
        <ArrowUp className="h-4.5 w-4.5" />
      </Button>
    );

    const inlineStopButton = (
      <Button
        variant="surfaceDestructive"
        data-testid="chat-composer-action"
        className="h-8 w-8 shrink-0 rounded-full bg-danger/15 p-0 text-danger shadow-none transition-colors hover:bg-danger/25 focus-visible:ring-0 focus-visible:ring-offset-0"
        onClick={onStop}
        size="icon"
        title={actionButtonLabel}
        aria-label={actionButtonLabel}
      >
        <Square className="h-3.5 w-3.5 fill-current" />
      </Button>
    );

    const inlineStopSpeakingButton = (
      <Button
        variant="surfaceDestructive"
        data-testid="chat-composer-action"
        className="h-8 w-8 shrink-0 rounded-full bg-danger/15 p-0 text-danger shadow-none transition-colors hover:bg-danger/25 focus-visible:ring-0 focus-visible:ring-offset-0"
        onClick={onStopSpeaking}
        size="icon"
        title={actionButtonLabel}
        aria-label={actionButtonLabel}
      >
        <Square className="h-3.5 w-3.5 fill-current" />
      </Button>
    );

    const inlineTrailingActions = shouldShowStopButton ? (
      inlineStopButton
    ) : !isGameModal && voice.isSpeaking && !hasDraft ? (
      inlineStopSpeakingButton
    ) : isInlineMultiline ? (
      <>
        {inlineMicButton}
        {inlineSendButton}
      </>
    ) : hasDraft ? (
      inlineSendButton
    ) : (
      inlineMicButton
    );

    return (
      <div
        ref={inlineRootRef}
        data-chat-composer="true"
        data-inline-layout={isInlineMultiline ? "stacked" : "single-line"}
        className={
          isInlineMultiline
            ? `flex min-h-[64px] flex-col gap-1 rounded-[22px] border border-border/35 bg-card/45 px-1.5 py-1.5 ${chatComposerFocusResetClass}`
            : `flex min-h-[40px] items-center gap-1 rounded-full border border-border/35 bg-card/45 px-1 py-1 ${chatComposerFocusResetClass}`
        }
      >
        <textarea
          ref={inlineMeasureRef}
          aria-hidden="true"
          className={inlineMeasureTextareaClass}
          data-chat-composer-measure="true"
          readOnly
          rows={1}
          tabIndex={-1}
          value={chatInput}
        />
        {isInlineMultiline ? (
          <>
            {inlineTextarea}
            <div className="flex min-w-0 items-center gap-1">
              {inlineAttachButton}
              {renderCreateTaskButton()}
              <div className="min-w-0 flex-1" />
              {inlineTrailingActions}
            </div>
          </>
        ) : (
          <>
            {inlineAttachButton}
            {renderCreateTaskButton()}
            {inlineTextarea}
            {inlineTrailingActions}
          </>
        )}
      </div>
    );
  }

  return (
    <div
      data-chat-composer="true"
      className={
        isGameModal
          ? `relative flex w-full items-end gap-2 transition-all max-[380px]:gap-1.5 ${chatComposerFocusResetClass}`
          : `flex items-center gap-1.5 sm:gap-2 ${chatComposerFocusResetClass}`
      }
    >
      {!isGameModal && !hideAttachButton ? (
        <Button
          variant="ghost"
          size="icon"
          className={
            isInline
              ? `h-8 w-8 shrink-0 rounded-full bg-bg/60 p-0 text-muted shadow-none transition-colors hover:bg-bg/60 hover:text-txt focus-visible:ring-0 focus-visible:ring-offset-0 ${
                  chatPendingImagesCount > 0
                    ? "text-accent hover:text-accent"
                    : ""
                }`
              : `h-[38px] w-9 shrink-0 bg-transparent p-0 shadow-none border-0 text-muted hover:bg-transparent hover:text-txt ${
                  chatPendingImagesCount > 0
                    ? "text-accent hover:text-accent"
                    : ""
                }`
          }
          onClick={onAttachImage}
          aria-label={t("aria.attachImage")}
          title={t("aria.attachImage")}
          disabled={isComposerLocked}
        >
          {isInline ? (
            <Plus className="h-5 w-5" />
          ) : (
            <Paperclip className="h-6 w-6" />
          )}
        </Button>
      ) : null}

      {renderCreateTaskButton()}

      {!isInline && showVoiceButton ? (
        <Button
          variant="ghost"
          size="icon"
          className={
            isGameModal
              ? `flex items-center justify-center h-[46px] w-[46px] shrink-0 ${
                  voice.isListening
                    ? "animate-pulse select-none rounded-full border border-border/28 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_82%,transparent),color-mix(in_srgb,var(--bg)_66%,transparent))] text-txt shadow-[inset_0_1px_0_rgba(255,255,255,0.14),0_16px_26px_-24px_rgba(15,23,42,0.16)] ring-1 ring-inset ring-white/8 backdrop-blur-md transition-all duration-300 active:scale-95 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_18px_28px_-24px_rgba(0,0,0,0.3)]"
                    : "select-none rounded-full border border-transparent bg-transparent text-muted-strong shadow-none ring-0 backdrop-blur-none transition-[border-color,background-color,color,transform,box-shadow] duration-300 hover:border-border/28 hover:bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_74%,transparent),color-mix(in_srgb,var(--bg)_58%,transparent))] hover:text-txt active:scale-95"
                } ${isComposerLocked ? "opacity-50" : ""}`
              : `h-[38px] w-9 shrink-0 bg-transparent p-0 shadow-none border-0 text-muted hover:bg-transparent hover:text-txt ${voice.isListening ? "text-accent hover:text-accent" : ""}`
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
          title={voiceButtonTitle}
          disabled={isComposerLocked}
        >
          <Mic className="h-6 w-6" />
        </Button>
      ) : null}

      <div className="relative min-w-0 flex-1">
        <Textarea
          ref={textareaRef}
          value={chatInput}
          onChange={(event) => onChatInputChange(event.target.value)}
          onKeyDown={onKeyDown}
          data-testid="chat-composer-textarea"
          aria-label={textareaAriaLabel}
          variant={isInline ? null : undefined}
          density={isInline ? null : undefined}
          className={
            isGameModal
              ? "w-full min-w-0 min-h-0 h-[46px] resize-none overflow-y-hidden max-h-[200px] outline-none ring-0 shadow-none focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0 font-[var(--font-chat)] disabled:opacity-50 rounded-3xl border border-transparent bg-transparent px-4 pb-[13px] pt-[13px] text-[15px] leading-[1.55] text-txt-strong placeholder:text-muted"
              : isInline
                ? inlineTextareaClass
                : "w-full min-w-0 min-h-0 h-[38px] resize-none overflow-y-hidden max-h-[200px] outline-none ring-0 shadow-none focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0 font-[var(--font-chat)] disabled:opacity-50 rounded-2xl border-0 bg-card/40 px-4 py-[8px] text-[15px] leading-[1.55] text-txt placeholder:text-muted"
          }
          placeholder={placeholder ?? defaultTextareaPlaceholder}
          rows={1}
          disabled={isComposerLocked}
        />
        {voice.isListening && voice.interimTranscript ? (
          <div
            className={
              isInline
                ? "pointer-events-none absolute inset-x-2 bottom-2 truncate text-xs text-muted"
                : "pointer-events-none absolute inset-x-4 bottom-2.5 truncate text-xs-tight text-muted"
            }
          >
            {voice.interimTranscript}
          </div>
        ) : null}
      </div>

      {!isInline && showAgentVoiceToggle ? (
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
          className={
            isInline
              ? "h-8 w-8 shrink-0 rounded-full bg-danger/15 p-0 text-danger shadow-none transition-colors hover:bg-danger/25 focus-visible:ring-0 focus-visible:ring-offset-0"
              : "ml-1 flex items-center justify-center rounded-full transition-all duration-300 select-none active:scale-95 h-[46px] w-[46px] shrink-0"
          }
          onClick={onStop}
          size="icon"
          title={actionButtonLabel}
          aria-label={actionButtonLabel}
        >
          <Square
            className={
              isInline
                ? "h-3.5 w-3.5 fill-current"
                : isGameModal
                  ? "h-4.5 w-4.5"
                  : "h-4 w-4"
            }
          />
        </Button>
      ) : !isGameModal && voice.isSpeaking && !hasDraft ? (
        <Button
          variant="surfaceDestructive"
          data-testid="chat-composer-action"
          className={
            isInline
              ? "h-8 w-8 shrink-0 rounded-full bg-danger/15 p-0 text-danger shadow-none transition-colors hover:bg-danger/25 focus-visible:ring-0 focus-visible:ring-offset-0"
              : "ml-1 flex items-center justify-center rounded-full transition-all duration-300 select-none active:scale-95 h-[46px] w-[46px] shrink-0"
          }
          onClick={onStopSpeaking}
          size="icon"
          title={actionButtonLabel}
          aria-label={actionButtonLabel}
        >
          <Square
            className={isInline ? "h-3.5 w-3.5 fill-current" : "h-4 w-4"}
          />
        </Button>
      ) : isInline && !hasDraft ? (
        <Button
          variant="ghost"
          data-testid="chat-composer-action"
          size="icon"
          className={`h-8 w-8 shrink-0 rounded-full p-0 shadow-none transition-colors focus-visible:ring-0 focus-visible:ring-offset-0 active:scale-95 ${
            voice.isListening
              ? "bg-accent text-bg hover:bg-accent/90 hover:text-bg"
              : "bg-bg/60 text-muted hover:bg-bg/60 hover:text-txt"
          }`}
          onClick={handleMicClick}
          onPointerDown={handleMicPointerDown}
          onPointerUp={handleMicPointerUp}
          onPointerCancel={handleMicPointerCancel}
          onPointerLeave={handleMicPointerCancel}
          disabled={isComposerLocked || !voice.supported}
          title={voiceButtonTitle}
          aria-label={voiceButtonTitle}
          aria-pressed={voice.isListening}
        >
          <Mic className="h-4.5 w-4.5" />
        </Button>
      ) : (
        <Button
          variant={isGameModal ? "default" : "ghost"}
          data-testid="chat-composer-action"
          size="icon"
          className={
            isGameModal
              ? `ml-1 flex items-center justify-center rounded-full transition-all duration-300 select-none active:scale-95 h-[46px] w-[46px] shrink-0 ${
                  hasDraft
                    ? "select-none rounded-full border border-border/28 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_82%,transparent),color-mix(in_srgb,var(--bg)_66%,transparent))] text-txt shadow-[inset_0_1px_0_rgba(255,255,255,0.14),0_16px_26px_-24px_rgba(15,23,42,0.16)] ring-1 ring-inset ring-white/8 backdrop-blur-md transition-all duration-300 active:scale-95 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_18px_28px_-24px_rgba(0,0,0,0.3)]"
                    : "select-none rounded-full border border-transparent bg-transparent text-muted-strong shadow-none ring-0 backdrop-blur-none transition-[border-color,background-color,color,transform,box-shadow] duration-300 hover:border-border/28 hover:bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_74%,transparent),color-mix(in_srgb,var(--bg)_58%,transparent))] hover:text-txt active:scale-95 opacity-80"
                }`
              : isInline
                ? "h-8 w-8 shrink-0 rounded-full bg-txt p-0 text-bg shadow-none transition-transform focus-visible:ring-0 focus-visible:ring-offset-0 active:scale-95 disabled:opacity-40"
                : "ml-1 h-[38px] w-9 shrink-0 bg-transparent p-0 shadow-none border-0 text-muted hover:bg-transparent hover:text-txt transition-colors select-none active:scale-95 disabled:ring-0 disabled:opacity-40"
          }
          onClick={onSend}
          disabled={isComposerLocked || !hasDraft}
          title={actionButtonLabel}
          aria-label={actionButtonLabel}
        >
          {isInline ? (
            <ArrowUp className="h-4.5 w-4.5" />
          ) : (
            <Send className={isGameModal ? "h-4.5 w-4.5" : "h-6 w-6"} />
          )}
        </Button>
      )}
    </div>
  );
}
