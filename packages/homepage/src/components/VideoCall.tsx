import { animated, useSpring } from "@react-spring/web";
import { X } from "lucide-react";
import type { ComponentType, HTMLAttributes } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { SpringAnimatedStyle } from "@/lib/spring-types";
import { useT } from "@/providers/I18nProvider";

type AnimatedDivProps = Omit<HTMLAttributes<HTMLDivElement>, "style"> & {
  style?: SpringAnimatedStyle;
};

const AnimatedDiv = animated.div as ComponentType<AnimatedDivProps>;

interface VideoCallProps {
  visible: boolean;
  onClose: () => void;
}

export default function VideoCall({ visible, onClose }: VideoCallProps) {
  const t = useT();
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [maxW, setMaxW] = useState(440);

  useEffect(() => {
    const update = () => setMaxW(Math.round(0.478 * window.innerHeight - 22));
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  const stopStream = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => {
        t.stop();
      });
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  }, []);

  useEffect(() => {
    if (!visible) {
      stopStream();
      return;
    }

    let cancelled = false;

    navigator.mediaDevices
      .getUserMedia({ video: true })
      .then((stream) => {
        if (cancelled) {
          stream.getTracks().forEach((t) => {
            t.stop();
          });
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }
      })
      .catch(() => {
        if (!cancelled) onClose();
      });

    return () => {
      cancelled = true;
      stopStream();
    };
  }, [visible, onClose, stopStream]);

  const spring = useSpring({
    opacity: visible ? 1 : 0,
    scale: visible ? 1 : 0.92,
    config: { mass: 1, tension: 260, friction: 24 },
  });

  return (
    <AnimatedDiv
      className="fixed bottom-3 left-1/2 -translate-x-1/2 z-40 w-full px-2"
      style={{
        maxWidth: maxW,
        opacity: spring.opacity,
        pointerEvents: visible ? "auto" : "none",
      }}
    >
      <AnimatedDiv
        style={{
          transform: spring.scale.to(
            (s) => `perspective(600px) rotateX(5deg) scale(${s})`,
          ),
          transformOrigin: "bottom center",
        }}
      >
        <div className="relative">
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className="w-full aspect-4/3 object-cover rounded-xs"
          />

          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex flex-col items-center gap-1.5">
            <button
              type="button"
              onClick={onClose}
              aria-label={t("homepage_eliza.video.endCallAria", {
                defaultValue: "End call",
              })}
              className="size-14 flex items-center justify-center rounded-xs bg-red-500 hover:bg-red-600 text-white transition-colors cursor-pointer"
            >
              <X className="size-8" strokeWidth={1.5} />
            </button>
            <span className="text-white text-xs font-medium">
              {t("homepage_eliza.video.endLabel", { defaultValue: "end" })}
            </span>
          </div>
        </div>
      </AnimatedDiv>
    </AnimatedDiv>
  );
}
