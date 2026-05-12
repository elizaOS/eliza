import {
  APP_EMOTE_EVENT,
  type AppEmoteEventDetail,
  Z_GLOBAL_EMOTE,
} from "@elizaos/ui";
import { useEffect, useRef, useState } from "react";

const OVERLAY_LIFETIME_MS = 2400;

const EMOTE_EMOJIS: Record<string, string> = {
  wave: "\u{1F44B}",
  kiss: "\u{1F48B}",
  crying: "\u{1F62D}",
  sorrow: "\u{1F614}",
  "rude-gesture": "\u{1F595}",
  "looking-around": "\u{1F440}",
  "dance-happy": "\u{1F483}",
  "dance-breaking": "\u{1F938}",
  "dance-hiphop": "\u{1F57A}",
  "dance-popping": "\u{1FAA9}",
  "hook-punch": "\u{1F44A}",
  punching: "\u{1F94A}",
  "firing-gun": "\u{1F52B}",
  "sword-swing": "\u{2694}",
  chopping: "\u{1FA93}",
  "spell-cast": "\u{1FA84}",
  range: "\u{1F3F9}",
  death: "\u{1F480}",
  talk: "\u{1F5E3}",
  squat: "\u{1F9CE}",
  fishing: "\u{1F3A3}",
  float: "\u{2728}",
  jump: "\u{1F4A8}",
  flip: "\u{1F938}",
  crawling: "\u{1F43E}",
  fall: "\u{1F4A5}",
};

function getOverlayEmoji(emoteId: string): string {
  return EMOTE_EMOJIS[emoteId] ?? "\u2728";
}

export function GlobalEmoteOverlay() {
  const [activeEmote, setActiveEmote] = useState<{
    key: number;
    emoteId: string;
    emoji: string;
  } | null>(null);
  const hideTimerRef = useRef<number | null>(null);
  const nextKeyRef = useRef(1);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<AppEmoteEventDetail>).detail;
      if (!detail?.emoteId) return;
      if (detail.showOverlay === false) return;
      if (hideTimerRef.current != null) {
        window.clearTimeout(hideTimerRef.current);
      }
      const nextOverlay = {
        key: nextKeyRef.current,
        emoteId: detail.emoteId,
        emoji: getOverlayEmoji(detail.emoteId),
      };
      nextKeyRef.current += 1;
      setActiveEmote(nextOverlay);
      hideTimerRef.current = window.setTimeout(() => {
        setActiveEmote((current) =>
          current?.key === nextOverlay.key ? null : current,
        );
        hideTimerRef.current = null;
      }, OVERLAY_LIFETIME_MS);
    };

    window.addEventListener(APP_EMOTE_EVENT, handler);
    return () => {
      window.removeEventListener(APP_EMOTE_EVENT, handler);
      if (hideTimerRef.current != null) {
        window.clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
    };
  }, []);

  return (
    <>
      <style>{`
        @keyframes eliza-emote-burst {
          0% {
            opacity: 0;
            transform: translateY(32px) scale(0.42) rotate(-10deg);
          }
          16% {
            opacity: 1;
            transform: translateY(-10px) scale(1.12) rotate(5deg);
          }
          48% {
            opacity: 1;
            transform: translateY(-24px) scale(1) rotate(-2deg);
          }
          100% {
            opacity: 0;
            transform: translateY(-72px) scale(0.84) rotate(6deg);
          }
        }

        @keyframes eliza-emote-aura {
          0% {
            opacity: 0;
            transform: scale(0.5);
          }
          24% {
            opacity: 0.7;
            transform: scale(1);
          }
          100% {
            opacity: 0;
            transform: scale(1.35);
          }
        }
      `}</style>
      {activeEmote && (
        <div
          aria-hidden="true"
          data-testid="global-emote-overlay"
          data-emote-id={activeEmote.emoteId}
          className={`pointer-events-none fixed inset-0 z-[${Z_GLOBAL_EMOTE}] flex items-start justify-center overflow-hidden`}
        >
          <div className="relative mt-[18vh] flex items-center justify-center">
            <div
              className="absolute h-36 w-36 rounded-full"
              style={{
                background:
                  "radial-gradient(circle, rgba(255,255,255,0.35) 0%, rgba(255,214,102,0.18) 34%, rgba(255,214,102,0) 72%)",
                filter: "blur(6px)",
                animation: "eliza-emote-aura 2400ms ease-out forwards",
              }}
            />
            <div
              key={activeEmote.key}
              className="relative flex h-32 w-32 items-center justify-center rounded-full border border-white/18 bg-black/18 text-[88px] shadow-[0_20px_54px_rgba(0,0,0,0.24)] backdrop-blur-md"
              style={{
                animation:
                  "eliza-emote-burst 2400ms cubic-bezier(.2,.8,.2,1) forwards",
              }}
            >
              <span className="select-none leading-none">
                {activeEmote.emoji}
              </span>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
