import { Mic, Send } from "lucide-react";
import type * as React from "react";
import { useMemo, useState } from "react";

import { CloudVideoBackground } from "../../backgrounds/CloudVideoBackground";
import { cn } from "../../lib/utils";
import { useShellControllerContext } from "../shell/ShellControllerContext";
import { VoiceWaveform } from "../voice/VoiceWaveform";

/**
 * Default landing surface — the "home" assistant view.
 *
 * Renders the clouds backdrop with a centered voice-avatar waveform as the
 * assistant's presence. Home suppresses the global assistant pill and exposes
 * its own composer/mic controls; the waveform mode is driven by the shared
 * shell controller phase.
 */
export function HomeView(): React.JSX.Element {
  const controller = useShellControllerContext();
  const mode = controller?.waveformMode ?? "idle";
  const [draft, setDraft] = useState("");
  const [focused, setFocused] = useState(false);
  const trimmed = draft.trim();
  const canSend = Boolean(controller?.canSend && trimmed.length > 0);
  const recentMessages = useMemo(
    () => controller?.messages.slice(-4) ?? [],
    [controller?.messages],
  );
  const latestAssistantWords = useMemo(() => {
    const text =
      [...(controller?.messages ?? [])]
        .reverse()
        .find((message) => message.role === "assistant")
        ?.content.trim() ?? "";
    if (!text) return "How can I help?";
    const words = text.split(/\s+/).slice(-14);
    return words.join(" ");
  }, [controller?.messages]);

  function sendDraft() {
    if (!canSend || !controller) return;
    controller.send(trimmed);
    setDraft("");
  }

  const showRecent = focused || draft.trim().length > 0;
  const draftPreview = draft.trim();

  return (
    <CloudVideoBackground scrim={0.08} style={{ height: "100%" }}
    >
      <div
        data-testid="home-view"
        className="relative flex h-full w-full flex-col items-center justify-center overflow-hidden px-4 py-8 text-txt"
      >
        <div className="flex min-h-0 w-full max-w-3xl flex-1 flex-col items-center justify-center gap-5">
          <div className="relative grid h-[min(42vh,280px)] min-h-44 w-full place-items-center">
            <VoiceWaveform mode={mode} size={240} />
          </div>
          <p
            className="min-h-6 max-w-xl text-center text-sm text-muted"
            aria-live="polite"
            data-testid="home-assistant-transcript"
          >
            {latestAssistantWords}
          </p>
        </div>

        <div className="w-full max-w-2xl shrink-0 pb-[calc(var(--safe-area-bottom,0px)+0.25rem)]">
          {showRecent &&
          (recentMessages.length > 0 || draftPreview.length > 0) ? (
            <ol
              className="mb-3 flex max-h-32 flex-col gap-1 overflow-hidden"
              data-testid="home-recent-chats"
              aria-label="Recent chat"
            >
              {recentMessages.map((message) => (
                <li
                  key={message.id}
                  className={cn(
                    "truncate rounded-md border border-border/30 bg-bg/45 px-3 py-1.5 text-xs backdrop-blur",
                    message.role === "user"
                      ? "ml-auto max-w-[82%]"
                      : "mr-auto max-w-[82%]",
                  )}
                >
                  {message.content}
                </li>
              ))}
              {draftPreview.length > 0 ? (
                <li className="ml-auto max-w-[82%] truncate rounded-md border border-accent/25 bg-accent/10 px-3 py-1.5 text-xs text-txt backdrop-blur">
                  {draftPreview}
                </li>
              ) : null}
            </ol>
          ) : null}

          <div className="flex items-center gap-2 rounded-full border border-black/10 bg-white/60 p-2 text-slate-800 shadow-lg backdrop-blur-md">
            <input
              type="text"
              value={draft}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  sendDraft();
                }
              }}
              placeholder="Ask Eliza..."
              aria-label="Message Eliza"
              data-testid="home-chat-input"
              className="min-w-0 flex-1 bg-transparent px-3 text-sm text-slate-800 placeholder:text-slate-500 focus:outline-none"
            />
            <button
              type="button"
              aria-label={
                controller?.recording ? "Stop voice input" : "Start voice input"
              }
              aria-pressed={controller?.recording ?? false}
              onClick={() => controller?.toggleRecording()}
              className={cn(
                "grid h-10 w-10 shrink-0 place-items-center rounded-full text-slate-500 transition-colors hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                controller?.recording &&
                  "bg-warn/25 text-slate-900 animate-pulse",
              )}
            >
              <Mic className="h-4 w-4" aria-hidden />
            </button>
            <button
              type="button"
              aria-label="Send message"
              disabled={!canSend}
              onClick={sendDraft}
              className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-accent text-bg transition-opacity disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Send className="h-4 w-4" aria-hidden />
            </button>
          </div>
        </div>
      </div>
    </CloudVideoBackground>
  );
}
