/**
 * The chat message composer: auto-growing textarea plus send / attach / voice
 * controls, driving the primary text-and-voice input for every chat surface.
 * Owns the textarea auto-resize measurement, push-to-talk wiring
 * (`usePushToTalk`), and the send/stop/voice affordance state derived from the
 * passed voice-session mode. Pure presentation — the parent owns the value and
 * the actual send/voice actions.
 */
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
  type ClipboardEvent,
  type KeyboardEvent,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { usePushToTalk } from "../../../hooks/usePushToTalk";
import type { VoiceSessionMode } from "../../../voice/voice-chat-types";
import { Button } from "../../ui/button";
import { Textarea } from "../../ui/textarea";
import type { ChatVariant } from "./chat-types";

const INLINE_TEXTAREA_MIN_HEIGHT_PX = 32;
const INLINE_TEXTAREA_MAX_HEIGHT_PX = 128;
const INLINE_STACKED_INLINE_PADDING_PX = 12;

const inlineTextareaClass =
  "block h-8 max-h-[128px] min-h-0 w-full min-w-0 resize-none overflow-y-hidden appearance-none rounded-none border-0 bg-transparent px-2 py-[6px] text-sm leading-5 text-txt outline-none placeholder:text-muted-strong pointer-coarse:text-[16px]    ";

const inlineMeasureTextareaClass = `${inlineTextareaClass} pointer-events-none fixed left-0 top-0 z-[-1] opacity-0`;

const inlineComposerSurfaceClass =
  "border-[color-mix(in_srgb,var(--border)_62%,var(--txt)_38%)] bg-[color-mix(in_srgb,var(--bg)_78%,var(--txt)_16%)]   ";

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
  /**
   * Clipboard paste handler — pastes an image/file as an attachment and a large
   * text block as a collapsed text-attachment chip (matching the mobile
   * overlay). Optional; when omitted the textarea pastes normally.
   */
  onPaste?: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  onSend: () => void;
  onStop: () => void;
  onStopSpeaking: () => void;
  onToggleAgentVoice: () => void;
  showAgentVoiceToggle?: boolean;
  t: (key: string, options?: Record<string, unknown>) => string;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  variant: ChatVariant;
  voice: ChatComposerVoiceState;
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
  onPaste,
  onSend,
  onStop,
  onStopSpeaking,
  onToggleAgentVoice,
  hideAttachButton = false,
  placeholder,
}: ChatComposerProps) {
  const [isInlineMultiline, setIsInlineMultiline] = useState(false);
  const [inlineMeasureVersion, setInlineMeasureVersion] = useState(0);
  const inlineRootRef = useRef<HTMLDivElement | null>(null);
  const inlineMeasureRef = useRef<HTMLTextAreaElement | null>(null);
  const lastInlineSingleLineWidthRef = useRef<number | null>(null);

  const isGameModal = variant === "game-modal";
  const isInline = layout === "inline";
  const showVoiceButton = isGameModal || voice.supported;
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
  const inputPlaceholder = t("common.message");
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

  const { handlers: micHoldHandlers, shouldSuppressClick } = usePushToTalk({
    canBegin: () => !isComposerLocked && !voice.isListening,
    onHoldStart: () => {
      void voice.startListening("push-to-talk");
    },
    onHoldEnd: (cancelled) => {
      // Clean release submits the dictated turn; a slide-off/cancel discards it.
      void voice.stopListening(cancelled ? undefined : { submit: true });
    },
  });

  const handleMicClick = useCallback(() => {
    // A held push-to-talk turn that is still live when clicked (no pointerup
    // reached us) is stopped-and-submitted here as the fallback.
    if (voice.isListening && voice.captureMode === "push-to-talk") {
      void voice.stopListening({ submit: true });
      return;
    }
    // Swallow the trailing click of a completed hold so it doesn't also toggle.
    if (shouldSuppressClick()) return;
    if (isComposerLocked) return;
    if (voice.isListening && voice.captureMode === "compose") {
      void voice.stopListening();
      return;
    }
    if (voice.isListening) return;
    void voice.startListening("compose");
  }, [isComposerLocked, shouldSuppressClick, voice]);

  if (isInline) {
    const inlineAttachButton =
      !isGameModal && !hideAttachButton ? (
        <Button
          variant="ghost"
          size="icon"
          className={`h-8 w-8 shrink-0 rounded-sm bg-bg p-0 text-muted shadow-none transition-colors hover:bg-bg hover:text-txt pointer-coarse:min-h-touch pointer-coarse:min-w-touch ${
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
          onPaste={onPaste}
          data-testid="chat-composer-textarea"
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
        className={`h-8 w-8 shrink-0 rounded-sm p-0 shadow-none transition-colors active:scale-95 pointer-coarse:min-h-touch pointer-coarse:min-w-touch ${
          voice.isListening
            ? "bg-accent text-bg hover:bg-accent/90 hover:text-bg"
            : "bg-bg text-muted hover:bg-bg hover:text-txt"
        }`}
        data-testid="chat-composer-mic"
        onClick={handleMicClick}
        {...micHoldHandlers}
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
        className="h-8 w-8 shrink-0 rounded-sm bg-txt p-0 text-bg shadow-none transition-transform active:scale-95 disabled:opacity-40 pointer-coarse:min-h-touch pointer-coarse:min-w-touch"
        onClick={onSend}
        // Keep the textarea focused through the tap: without this, tapping the
        // send button blurs the composer (the keyboard starts to dismiss) and the
        // send handler then re-focuses it — the keyboard "flips" closed/open.
        onMouseDown={(e) => e.preventDefault()}
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
        className="h-8 w-8 shrink-0 rounded-sm bg-danger/15 p-0 text-danger shadow-none transition-colors hover:bg-danger/25 pointer-coarse:min-h-touch pointer-coarse:min-w-touch"
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
        className="h-8 w-8 shrink-0 rounded-sm bg-danger/15 p-0 text-danger shadow-none transition-colors hover:bg-danger/25 pointer-coarse:min-h-touch pointer-coarse:min-w-touch"
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
    ) : voice.isListening ? (
      // Keep the mic (release) button mounted while a push-to-talk turn is held,
      // even after live STT text fills the draft — otherwise the composer swaps
      // to the send button mid-hold and pointer-release can no longer submit.
      inlineMicButton
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
            ? `flex min-h-[64px] flex-col gap-1 rounded-sm border px-1.5 py-1.5 ${inlineComposerSurfaceClass}`
            : `flex min-h-[40px] items-center gap-1 rounded-sm border px-1 py-1 ${inlineComposerSurfaceClass}`
        }
      >
        <Textarea
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
              <div className="min-w-0 flex-1" />
              {inlineTrailingActions}
            </div>
          </>
        ) : (
          <>
            {inlineAttachButton}
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
          ? "relative flex w-full items-end gap-2 transition-all max-[380px]:gap-1.5"
          : "flex items-center gap-1.5 sm:gap-2"
      }
    >
      {!isGameModal && !hideAttachButton ? (
        <Button
          variant="ghost"
          size="icon"
          className={
            isInline
              ? `h-8 w-8 shrink-0 rounded-sm bg-bg p-0 text-muted shadow-none transition-colors hover:bg-bg hover:text-txt ${
                  chatPendingImagesCount > 0
                    ? "text-accent hover:text-accent"
                    : ""
                }`
              : `h-[38px] w-9 shrink-0 bg-transparent p-0 shadow-none border-0 text-muted hover:bg-transparent hover:text-txt pointer-coarse:min-h-touch pointer-coarse:min-w-touch ${
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

      {!isInline && showVoiceButton ? (
        <Button
          variant="ghost"
          size="icon"
          className={
            isGameModal
              ? `flex items-center justify-center h-[46px] w-[46px] shrink-0 ${
                  voice.isListening
                    ? "animate-pulse select-none rounded-sm border border-border/28 bg-card text-txt    transition-all duration-300 active:scale-95 "
                    : "select-none rounded-sm border border-transparent bg-transparent text-muted-strong shadow-none  transition-[border-color,background-color,color,transform,box-shadow] duration-300 hover:border-border/28 hover:bg-card hover:text-txt active:scale-95"
                } ${isComposerLocked ? "opacity-50" : ""}`
              : `h-[38px] w-9 shrink-0 bg-transparent p-0 shadow-none border-0 text-muted hover:bg-transparent hover:text-txt pointer-coarse:min-h-touch pointer-coarse:min-w-touch ${voice.isListening ? "text-accent hover:text-accent" : ""}`
          }
          data-testid="chat-composer-mic"
          onClick={handleMicClick}
          {...micHoldHandlers}
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
          onPaste={onPaste}
          data-testid="chat-composer-textarea"
          variant={isInline ? null : undefined}
          density={isInline ? null : undefined}
          className={
            isGameModal
              ? "w-full min-w-0 min-h-0 h-[46px] resize-none overflow-y-hidden max-h-[200px] outline-none     font-[var(--font-chat)] disabled:opacity-50 rounded-sm border border-transparent bg-transparent px-4 pb-[13px] pt-[13px] text-[15px] leading-[1.55] text-txt-strong placeholder:text-muted pointer-coarse:text-[16px]"
              : isInline
                ? inlineTextareaClass
                : "w-full min-w-0 min-h-0 h-[38px] resize-none overflow-y-hidden max-h-[200px] outline-none     font-[var(--font-chat)] disabled:opacity-50 rounded-sm border-0 bg-card/40 px-4 py-[8px] text-[15px] leading-[1.55] text-txt placeholder:text-muted pointer-coarse:text-[16px]"
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
                    ? "select-none rounded-sm border border-border/28 bg-card text-txt    transition-all duration-300 active:scale-95 "
                    : "select-none rounded-sm border border-transparent bg-transparent text-muted-strong shadow-none  transition-[border-color,background-color,color,transform,box-shadow] duration-300 hover:border-border/28 hover:bg-card hover:text-txt active:scale-95"
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
              ? "h-8 w-8 shrink-0 rounded-sm bg-danger/15 p-0 text-danger shadow-none transition-colors hover:bg-danger/25 pointer-coarse:min-h-touch pointer-coarse:min-w-touch"
              : "ml-1 flex items-center justify-center rounded-sm transition-all duration-300 select-none active:scale-95 h-[46px] w-[46px] shrink-0"
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
              ? "h-8 w-8 shrink-0 rounded-sm bg-danger/15 p-0 text-danger shadow-none transition-colors hover:bg-danger/25 pointer-coarse:min-h-touch pointer-coarse:min-w-touch"
              : "ml-1 flex items-center justify-center rounded-sm transition-all duration-300 select-none active:scale-95 h-[46px] w-[46px] shrink-0"
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
          size="icon"
          className={`h-8 w-8 shrink-0 rounded-sm p-0 shadow-none transition-colors active:scale-95 pointer-coarse:min-h-touch pointer-coarse:min-w-touch ${
            voice.isListening
              ? "bg-accent text-bg hover:bg-accent/90 hover:text-bg"
              : "bg-bg text-muted hover:bg-bg hover:text-txt"
          }`}
          data-testid="chat-composer-mic"
          onClick={handleMicClick}
          {...micHoldHandlers}
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
              ? `ml-1 flex items-center justify-center rounded-sm transition-all duration-300 select-none active:scale-95 h-[46px] w-[46px] shrink-0 ${
                  hasDraft
                    ? "select-none rounded-sm border border-border/28 bg-card text-txt    transition-all duration-300 active:scale-95 "
                    : "select-none rounded-sm border border-transparent bg-transparent text-muted-strong shadow-none  transition-[border-color,background-color,color,transform,box-shadow] duration-300 hover:border-border/28 hover:bg-card hover:text-txt active:scale-95 opacity-80"
                }`
              : isInline
                ? "h-8 w-8 shrink-0 rounded-sm bg-txt p-0 text-bg shadow-none transition-transform active:scale-95 disabled:opacity-40 pointer-coarse:min-h-touch pointer-coarse:min-w-touch"
                : "ml-1 h-[38px] w-9 shrink-0 bg-transparent p-0 shadow-none border-0 text-muted hover:bg-transparent hover:text-txt transition-colors select-none active:scale-95  disabled:opacity-40 pointer-coarse:min-h-touch pointer-coarse:min-w-touch"
          }
          onClick={onSend}
          // Keep the textarea focused through the tap so the keyboard doesn't
          // flicker closed/open on send (see the inline send button).
          onMouseDown={(e) => e.preventDefault()}
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
