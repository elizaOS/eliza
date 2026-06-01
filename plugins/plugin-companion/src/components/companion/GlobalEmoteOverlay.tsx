import {
  APP_EMOTE_EVENT,
  type AppEmoteEventDetail,
  Z_GLOBAL_EMOTE,
} from "@elizaos/ui";
import {
  Accessibility,
  Activity,
  ArrowUp,
  Axe,
  Bird,
  Bone,
  ChevronsUp,
  Cloud,
  Dumbbell,
  Eye,
  Fish,
  Footprints,
  Frown,
  Hand,
  Heart,
  Leaf,
  type LucideIcon,
  MessageCircle,
  Music2,
  Rabbit,
  Shield,
  Skull,
  Sparkles,
  Swords,
  Target,
  WandSparkles,
  Waves,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

const OVERLAY_LIFETIME_MS = 2400;

const EMOTE_ICONS: Record<string, LucideIcon> = {
  wave: Hand,
  kiss: Heart,
  crying: Waves,
  sorrow: Frown,
  "rude-gesture": Hand,
  "looking-around": Eye,
  "dance-happy": Music2,
  "dance-breaking": Accessibility,
  "dance-hiphop": Activity,
  "dance-popping": Sparkles,
  "hook-punch": Dumbbell,
  punching: Shield,
  "firing-gun": Target,
  "sword-swing": Swords,
  chopping: Axe,
  "spell-cast": WandSparkles,
  range: Target,
  death: Skull,
  talk: MessageCircle,
  squat: Accessibility,
  fishing: Fish,
  float: Bird,
  jump: ArrowUp,
  flip: ChevronsUp,
  crawling: Bone,
  fall: Cloud,
  run: Rabbit,
  walk: Footprints,
  idle: Leaf,
};

function getOverlayIcon(emoteId: string): LucideIcon {
  return EMOTE_ICONS[emoteId] ?? Sparkles;
}

export function GlobalEmoteOverlay() {
  const [activeEmote, setActiveEmote] = useState<{
    key: number;
    emoteId: string;
    Icon: LucideIcon;
  } | null>(null);
  const hideTimerRef = useRef<number | null>(null);
  const nextKeyRef = useRef(1);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<AppEmoteEventDetail>).detail;
      if (!detail.emoteId) return;
      if (detail.showOverlay === false) return;
      if (hideTimerRef.current != null) {
        window.clearTimeout(hideTimerRef.current);
      }
      const nextOverlay = {
        key: nextKeyRef.current,
        emoteId: detail.emoteId,
        Icon: getOverlayIcon(detail.emoteId),
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
              className="relative flex h-32 w-32 items-center justify-center rounded-full border border-white/18 bg-black/18 shadow-[0_20px_54px_rgba(0,0,0,0.24)] backdrop-blur-md"
              style={{
                animation:
                  "eliza-emote-burst 2400ms cubic-bezier(.2,.8,.2,1) forwards",
              }}
            >
              <activeEmote.Icon
                className="h-20 w-20 text-white drop-shadow-[0_10px_28px_rgba(0,0,0,0.35)]"
                aria-hidden
                strokeWidth={1.6}
              />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
