import type { CSSProperties, ReactNode } from "react";

type CloudSkyBackgroundProps = {
  children?: ReactNode;
  className?: string;
  contentClassName?: string;
  intensity?: "soft" | "hero";
};

const cloudStyles = `
@keyframes eliza-cloud-drift-a {
  from { transform: translate3d(-38vw, 0, 0) scale(var(--cloud-scale, 1)); }
  to { transform: translate3d(112vw, 0, 0) scale(var(--cloud-scale, 1)); }
}
@keyframes eliza-cloud-drift-b {
  from { transform: translate3d(-48vw, 0, 0) scale(var(--cloud-scale, 1)); }
  to { transform: translate3d(118vw, 0, 0) scale(var(--cloud-scale, 1)); }
}
@keyframes eliza-cloud-breathe {
  0%, 100% { opacity: .72; transform: scale(1); }
  50% { opacity: .92; transform: scale(1.035); }
}
@keyframes eliza-cloud-bank-drift {
  from { transform: translate3d(-6vw, 0, 0); }
  to { transform: translate3d(6vw, 0, 0); }
}
.eliza-sky-bg {
  position: relative;
  isolation: isolate;
  overflow: hidden;
  background:
    radial-gradient(ellipse at 74% 36%, rgba(92, 163, 255, .72), transparent 40%),
    radial-gradient(ellipse at 18% 18%, rgba(255,255,255,.34), transparent 22%),
    linear-gradient(180deg, #043cff 0%, #075cff 42%, #1aa7ff 100%);
}
.eliza-sky-bg::before {
  content: "";
  position: absolute;
  inset: -18%;
  z-index: -3;
  pointer-events: none;
  background:
    radial-gradient(ellipse at 8% 20%, rgba(255,255,255,.72), rgba(255,255,255,.28) 13%, transparent 28%),
    radial-gradient(ellipse at 84% 18%, rgba(255,255,255,.5), rgba(255,255,255,.18) 14%, transparent 30%),
    radial-gradient(ellipse at 52% 2%, rgba(255,255,255,.38), transparent 24%);
  animation: eliza-cloud-breathe 16s ease-in-out infinite;
}
.eliza-sky-bg::after {
  content: "";
  position: absolute;
  inset: auto -14% -22% -14%;
  z-index: -2;
  height: 48%;
  pointer-events: none;
  opacity: .96;
  filter: blur(1.5px) saturate(1.08);
  background:
    radial-gradient(ellipse at 6% 72%, rgba(255,255,255,.96) 0 11%, rgba(244,250,255,.84) 16%, transparent 30%),
    radial-gradient(ellipse at 19% 58%, rgba(255,255,255,.98) 0 13%, rgba(239,249,255,.86) 18%, transparent 34%),
    radial-gradient(ellipse at 34% 64%, rgba(255,255,255,.94) 0 12%, rgba(235,247,255,.76) 19%, transparent 35%),
    radial-gradient(ellipse at 52% 57%, rgba(255,255,255,.98) 0 15%, rgba(237,248,255,.84) 22%, transparent 39%),
    radial-gradient(ellipse at 70% 67%, rgba(255,255,255,.92) 0 13%, rgba(232,245,255,.74) 20%, transparent 38%),
    radial-gradient(ellipse at 88% 59%, rgba(255,255,255,.98) 0 12%, rgba(240,249,255,.86) 18%, transparent 34%),
    linear-gradient(180deg, transparent, rgba(255,255,255,.82) 58%, rgba(255,255,255,.92));
  animation: eliza-cloud-bank-drift 28s ease-in-out infinite alternate;
}
.eliza-sky-layer {
  position: absolute;
  inset: 0;
  z-index: -2;
  overflow: hidden;
  pointer-events: none;
}
.eliza-sky-cloud-field {
  position: absolute;
  left: -10%;
  right: -10%;
  pointer-events: none;
  mix-blend-mode: screen;
}
.eliza-sky-cloud-field.far {
  top: 8%;
  height: 34%;
  opacity: .7;
  filter: blur(7px);
  background:
    radial-gradient(ellipse at 8% 58%, rgba(255,255,255,.82) 0 7%, rgba(255,255,255,.34) 14%, transparent 30%),
    radial-gradient(ellipse at 18% 44%, rgba(255,255,255,.68) 0 6%, rgba(255,255,255,.26) 13%, transparent 29%),
    radial-gradient(ellipse at 34% 52%, rgba(255,255,255,.76) 0 8%, rgba(255,255,255,.3) 16%, transparent 32%),
    radial-gradient(ellipse at 58% 42%, rgba(255,255,255,.74) 0 7%, rgba(255,255,255,.28) 15%, transparent 31%),
    radial-gradient(ellipse at 78% 56%, rgba(255,255,255,.78) 0 8%, rgba(255,255,255,.3) 17%, transparent 34%),
    radial-gradient(ellipse at 92% 44%, rgba(255,255,255,.64) 0 6%, rgba(255,255,255,.24) 14%, transparent 30%);
}
.eliza-sky-cloud-field.near {
  bottom: -2%;
  height: 52%;
  opacity: .9;
  filter: blur(4px);
  background:
    radial-gradient(ellipse at 5% 78%, rgba(255,255,255,.95) 0 8%, rgba(246,252,255,.62) 15%, transparent 31%),
    radial-gradient(ellipse at 18% 62%, rgba(255,255,255,.9) 0 10%, rgba(245,251,255,.58) 18%, transparent 36%),
    radial-gradient(ellipse at 31% 75%, rgba(255,255,255,.88) 0 9%, rgba(241,249,255,.52) 18%, transparent 37%),
    radial-gradient(ellipse at 48% 58%, rgba(255,255,255,.92) 0 11%, rgba(244,251,255,.58) 20%, transparent 39%),
    radial-gradient(ellipse at 65% 72%, rgba(255,255,255,.86) 0 10%, rgba(240,248,255,.52) 19%, transparent 38%),
    radial-gradient(ellipse at 82% 60%, rgba(255,255,255,.9) 0 10%, rgba(245,251,255,.58) 18%, transparent 37%),
    radial-gradient(ellipse at 96% 76%, rgba(255,255,255,.88) 0 8%, rgba(242,250,255,.52) 16%, transparent 34%);
}
.eliza-sky-cloud-field.detail {
  top: 30%;
  height: 40%;
  opacity: .42;
  filter: blur(1.5px);
  background:
    radial-gradient(ellipse at 14% 46%, rgba(255,255,255,.74) 0 3%, transparent 12%),
    radial-gradient(ellipse at 26% 62%, rgba(255,255,255,.66) 0 4%, transparent 14%),
    radial-gradient(ellipse at 42% 44%, rgba(255,255,255,.68) 0 3%, transparent 12%),
    radial-gradient(ellipse at 58% 60%, rgba(255,255,255,.62) 0 4%, transparent 15%),
    radial-gradient(ellipse at 74% 48%, rgba(255,255,255,.68) 0 3%, transparent 13%),
    radial-gradient(ellipse at 88% 62%, rgba(255,255,255,.64) 0 4%, transparent 14%);
}
.eliza-sky-vignette {
  position: absolute;
  inset: 0;
  z-index: -1;
  pointer-events: none;
  background:
    linear-gradient(180deg, rgba(0, 19, 126, .16), transparent 34%),
    radial-gradient(ellipse at 50% 58%, transparent 0 54%, rgba(0, 26, 118, .3) 100%);
}
.eliza-sky-vignette::before {
  content: "";
  position: absolute;
  inset: -10% -8% 38% -8%;
  opacity: .64;
  filter: blur(18px);
  background:
    radial-gradient(ellipse at 10% 32%, rgba(255,255,255,.9) 0 6%, rgba(255,255,255,.45) 12%, transparent 26%),
    radial-gradient(ellipse at 28% 20%, rgba(255,255,255,.7) 0 8%, rgba(255,255,255,.35) 16%, transparent 32%),
    radial-gradient(ellipse at 66% 24%, rgba(255,255,255,.82) 0 7%, rgba(255,255,255,.38) 14%, transparent 31%),
    radial-gradient(ellipse at 84% 36%, rgba(255,255,255,.78) 0 7%, rgba(255,255,255,.34) 15%, transparent 30%);
}
.eliza-sky-vignette::after {
  content: "";
  position: absolute;
  inset: 20% -6% auto -6%;
  height: 32%;
  opacity: .32;
  filter: blur(10px);
  background:
    radial-gradient(ellipse at 22% 56%, rgba(255,255,255,.82) 0 8%, rgba(255,255,255,.28) 17%, transparent 34%),
    radial-gradient(ellipse at 48% 44%, rgba(255,255,255,.68) 0 7%, rgba(255,255,255,.24) 16%, transparent 34%),
    radial-gradient(ellipse at 72% 54%, rgba(255,255,255,.76) 0 8%, rgba(255,255,255,.25) 17%, transparent 36%);
}
.eliza-sky-noise {
  position: absolute;
  inset: 0;
  z-index: -1;
  pointer-events: none;
  opacity: .16;
  mix-blend-mode: overlay;
  background-image:
    url("data:image/svg+xml,%3Csvg viewBox='0 0 512 512' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.72' numOctaves='5' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='.72'/%3E%3C/svg%3E"),
    linear-gradient(115deg, rgba(255,255,255,.14), transparent 44%, rgba(255,255,255,.1));
}
.eliza-sky-cloud {
  position: absolute;
  top: var(--cloud-top);
  left: 0;
  width: 8rem;
  height: 8rem;
  opacity: var(--cloud-opacity, .78);
  transform: translate3d(-38vw, 0, 0) scale(var(--cloud-scale, 1));
  animation: eliza-cloud-drift-a var(--cloud-duration, 96s) linear infinite;
  animation-delay: var(--cloud-delay, 0s);
  will-change: transform;
}
.eliza-sky-cloud::before,
.eliza-sky-cloud::after {
  content: "";
  position: absolute;
  inset: -32% -42%;
  opacity: .46;
  filter: blur(12px);
  border-radius: 999px;
  background:
    radial-gradient(ellipse at 22% 60%, rgba(255,255,255,.8) 0 16%, transparent 39%),
    radial-gradient(ellipse at 48% 42%, rgba(255,255,255,.72) 0 18%, transparent 42%),
    radial-gradient(ellipse at 74% 64%, rgba(255,255,255,.66) 0 15%, transparent 38%);
}
.eliza-sky-cloud::after {
  opacity: .24;
  filter: blur(22px);
  transform: translate3d(2rem, .5rem, 0) scale(1.18);
}
.eliza-sky-cloud.is-slow {
  animation-name: eliza-cloud-drift-b;
}
.eliza-sky-cloud-part {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  transform: translate3d(-18rem, -18rem, 0);
}
.eliza-sky-cloud-part.back {
  filter: url("#eliza-cloud-filter-back");
  box-shadow:
    18rem 18rem 2rem -1.5rem rgba(255,255,255,.72),
    20.6rem 17.15rem 2.65rem -1.9rem rgba(255,255,255,.52),
    15.25rem 18.75rem 2.25rem -1.85rem rgba(255,255,255,.44),
    23.25rem 18.9rem 2.4rem -2rem rgba(232,246,255,.42),
    13.7rem 19.55rem 2.1rem -1.8rem rgba(255,255,255,.34);
}
.eliza-sky-cloud-part.mid {
  filter: url("#eliza-cloud-filter-mid");
  box-shadow:
    18rem 18rem 1.9rem -1.35rem rgba(255,255,255,.92),
    21.25rem 18.2rem 2.15rem -1.75rem rgba(255,255,255,.66),
    14.7rem 17.65rem 2.4rem -1.9rem rgba(255,255,255,.58),
    19.25rem 16.45rem 1.9rem -1.65rem rgba(248,252,255,.72),
    23.3rem 17.25rem 2.1rem -1.86rem rgba(246,251,255,.5);
}
.eliza-sky-cloud-part.front {
  filter: url("#eliza-cloud-filter-front");
  box-shadow:
    18rem 18rem 1.65rem -1.25rem rgba(255,255,255,.96),
    19.85rem 19.55rem 1.95rem -1.7rem rgba(255,255,255,.72),
    16.35rem 16.7rem 1.8rem -1.6rem rgba(255,255,255,.68),
    21.55rem 16.85rem 1.45rem -1.38rem rgba(255,255,255,.76),
    14.25rem 19.6rem 1.7rem -1.54rem rgba(242,249,255,.6);
}
@media (prefers-reduced-motion: reduce) {
  .eliza-sky-cloud,
  .eliza-sky-bg::after,
  .eliza-sky-bg::before {
    animation: none;
  }
}
`;

const clouds = [
  { top: "7%", scale: 1.5, opacity: 0.45, duration: "132s", delay: "-72s" },
  { top: "17%", scale: 1.05, opacity: 0.62, duration: "104s", delay: "-30s" },
  { top: "30%", scale: 1.8, opacity: 0.38, duration: "158s", delay: "-118s" },
  { top: "47%", scale: 1.28, opacity: 0.52, duration: "122s", delay: "-54s" },
  { top: "64%", scale: 2.05, opacity: 0.32, duration: "178s", delay: "-95s" },
] as const;

export function CloudSkyBackground({
  children,
  className = "",
  contentClassName = "",
  intensity = "soft",
}: CloudSkyBackgroundProps) {
  const density = intensity === "hero" ? clouds : clouds.slice(0, 4);

  return (
    <div className={`eliza-sky-bg ${className}`}>
      <style>{cloudStyles}</style>
      <svg aria-hidden="true" className="absolute h-0 w-0" focusable="false">
        <filter
          height="200%"
          id="eliza-cloud-filter-back"
          width="200%"
          x="-50%"
          y="-50%"
        >
          <feGaussianBlur in="SourceGraphic" stdDeviation="9" />
        </filter>
        <filter
          height="200%"
          id="eliza-cloud-filter-mid"
          width="200%"
          x="-50%"
          y="-50%"
        >
          <feGaussianBlur in="SourceGraphic" stdDeviation="6" />
        </filter>
        <filter
          height="200%"
          id="eliza-cloud-filter-front"
          width="200%"
          x="-50%"
          y="-50%"
        >
          <feGaussianBlur in="SourceGraphic" stdDeviation="3" />
        </filter>
      </svg>
      <div aria-hidden="true" className="eliza-sky-layer">
        <div className="eliza-sky-cloud-field far" />
        <div className="eliza-sky-cloud-field detail" />
        {density.map((cloud, index) => (
          <div
            className={`eliza-sky-cloud ${index % 2 === 0 ? "is-slow" : ""}`}
            key={`${cloud.top}-${cloud.duration}`}
            style={
              {
                "--cloud-top": cloud.top,
                "--cloud-scale": String(cloud.scale),
                "--cloud-opacity": String(cloud.opacity),
                "--cloud-duration": cloud.duration,
                "--cloud-delay": cloud.delay,
              } as CSSProperties
            }
          >
            <span className="eliza-sky-cloud-part back" />
            <span className="eliza-sky-cloud-part mid" />
            <span className="eliza-sky-cloud-part front" />
          </div>
        ))}
        <div className="eliza-sky-cloud-field near" />
      </div>
      <div aria-hidden="true" className="eliza-sky-vignette" />
      <div aria-hidden="true" className="eliza-sky-noise" />
      <div className={`relative z-10 ${contentClassName}`}>{children}</div>
    </div>
  );
}
