import { animated, useSpring } from "@react-spring/web";
import type { ComponentType, HTMLAttributes } from "react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { SpringAnimatedStyle } from "@/lib/spring-types";

type AnimatedDivProps = Omit<HTMLAttributes<HTMLDivElement>, "style"> & {
  style?: SpringAnimatedStyle;
};

const AnimatedDiv = animated.div as ComponentType<AnimatedDivProps>;

import QRCode from "@/components/QRCode";

interface BlobButtonProps {
  children: ReactNode;
  href?: string;
  /** Pass your own QR code element (e.g. <img>, <svg>, or any component) */
  qrCode?: ReactNode;
  /** Controls the initial appear animation of the glass pill */
  show?: boolean;
  /** Optional click handler */
  onClick?: (e: React.MouseEvent<HTMLAnchorElement>) => void;
}

export default function BlobButton({
  children,
  href = "#",
  show = true,
  onClick,
}: BlobButtonProps) {
  const [hovered, setHovered] = useState(false);
  const btnRef = useRef<HTMLAnchorElement>(null);
  const [btnW, setBtnW] = useState(130);
  const [btnH, setBtnH] = useState(40);

  useEffect(() => {
    if (btnRef.current) {
      setBtnW(btnRef.current.offsetWidth);
      setBtnH(btnRef.current.offsetHeight);
    }
  }, []);

  const PANEL_W = 185;
  const PANEL_H = 195;
  const GAP = 5;
  const R = btnH / 2; // matches rounded-full on the pill

  const { t } = useSpring({
    t: hovered ? 1 : 0,
    config: { mass: 1, tension: 260, friction: 22 },
  });

  const appearSpring = useSpring({
    reveal: show ? 120 : -20,
    delay: show ? 300 : 0,
    config: { tension: 60, friction: 30 },
  });

  return (
    <div
      className="relative z-30 inline-flex items-center"
      role="group"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setHovered(true)}
      onBlur={() => setHovered(false)}
    >
      {/* Single glass shape: starts as the pill, morphs into pill+panel */}
      <AnimatedDiv
        className="absolute top-0 right-0 backdrop-blur-md border border-white/60 overflow-hidden"
        style={{
          width: t.to((v) => btnW + (PANEL_W - btnW) * v),
          height: t.to((v) => btnH + (GAP + PANEL_H) * v),
          borderRadius: R,
          background: t.to((v) => `rgba(255,255,255,${0.3 + 0.2 * v})`),
          WebkitMaskImage: appearSpring.reveal.to(
            (v) =>
              `linear-gradient(to bottom left, rgba(0,0,0,1) ${v - 20}%, rgba(0,0,0,0) ${v + 20}%)`,
          ),
          maskImage: appearSpring.reveal.to(
            (v) =>
              `linear-gradient(to bottom left, rgba(0,0,0,1) ${v - 20}%, rgba(0,0,0,0) ${v + 20}%)`,
          ),
        }}
      >
        {/* Panel content — fixed at final size, pinned to right edge, revealed by overflow:hidden */}
        <div
          className="absolute right-0 flex flex-col items-center "
          style={{ top: btnH + GAP, width: PANEL_W }}
        >
          <p className="text-black/70 text-xs text-center leading-tight">
            On desktop?
          </p>
          <p className="text-black/70 text-xs font-medium text-center mb-1 leading-tight">
            Open on your phone
          </p>

          <QRCode className="size-36" />
        </div>
      </AnimatedDiv>

      {/* Button label — no background, sits on top of the glass shape */}
      <a
        ref={btnRef}
        href={href}
        onClick={onClick}
        className="relative z-10 inline-flex items-center justify-center text-[15px] font-medium text-black rounded-full px-5 py-2"
      >
        {children}
      </a>
    </div>
  );
}
