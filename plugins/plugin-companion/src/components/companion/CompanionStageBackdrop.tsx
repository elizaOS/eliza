import { type CSSProperties, memo } from "react";

/**
 * CompanionStageBackdrop — the aesthetic stage that lives *behind* the
 * transparent VRM canvas. When the avatar renders, the WebGL layer (cleared
 * to alpha 0) composites on top and this shows through as a soft backdrop +
 * floor glow. When the avatar is absent or still loading, this layer is the
 * visible centerpiece: a gradient stage plus a gradient-filled avatar
 * silhouette, so the companion is never an empty void.
 *
 * Sizing/positioning use inline styles, NOT Tailwind arbitrary utilities: the
 * companion view ships as a standalone bundle with no compiled Tailwind CSS, so
 * arbitrary classes like `h-[120%]` / `w-[34%]` resolve to nothing and collapse
 * the layer to 0×0. Inline styles are self-contained and always paint.
 */
const fill: CSSProperties = {
  position: "absolute",
  inset: 0,
};

export const CompanionStageBackdrop = memo(function CompanionStageBackdrop({
  theme,
  showSilhouette,
}: {
  theme: "light" | "dark";
  showSilhouette: boolean;
}) {
  const dark = theme === "dark";
  return (
    <div
      data-testid="companion-stage-backdrop"
      aria-hidden
      style={{ position: "absolute", inset: 0, overflow: "hidden" }}
    >
      {/* Ambient stage wash — soft accent halo over a neutral vignette. */}
      <div
        style={{
          ...fill,
          background: dark
            ? "radial-gradient(120% 90% at 50% 18%, rgba(255,88,0,0.12) 0%, rgba(255,88,0,0) 46%), radial-gradient(140% 120% at 50% 120%, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0) 55%), linear-gradient(180deg, #0a0810 0%, #0e0b16 48%, #060509 100%)"
            : "radial-gradient(120% 90% at 50% 16%, rgba(255,88,0,0.14) 0%, rgba(255,88,0,0) 46%), radial-gradient(140% 120% at 50% 122%, rgba(0,0,0,0.05) 0%, rgba(0,0,0,0) 55%), linear-gradient(180deg, #fafafa 0%, #f3f3f5 52%, #ececef 100%)",
        }}
      />

      {/* Centre spotlight that grounds the avatar. */}
      <div
        style={{
          position: "absolute",
          left: "50%",
          top: "50%",
          width: "120%",
          height: "120%",
          transform: "translate(-50%, -50%)",
          background: dark
            ? "radial-gradient(closest-side, rgba(255,88,0,0.09) 0%, rgba(255,88,0,0) 70%)"
            : "radial-gradient(closest-side, rgba(255,88,0,0.08) 0%, rgba(255,88,0,0) 70%)",
        }}
      />

      {showSilhouette && <CompanionAvatarSilhouette dark={dark} />}

      {/* Floor reflection ellipse so the figure feels planted. */}
      <div
        style={{
          position: "absolute",
          left: "50%",
          bottom: "9%",
          width: "34%",
          height: "8%",
          transform: "translateX(-50%)",
          borderRadius: "50%",
          filter: "blur(40px)",
          background: dark
            ? "radial-gradient(50% 50% at 50% 50%, rgba(255,88,0,0.24) 0%, rgba(255,88,0,0) 72%)"
            : "radial-gradient(50% 50% at 50% 50%, rgba(255,88,0,0.18) 0%, rgba(255,88,0,0) 72%)",
        }}
      />
    </div>
  );
});

/**
 * Gradient-filled avatar silhouette — a calm, accent-tinted figure that reads
 * as "your companion lives here" without claiming a specific character. Shown
 * only while the live VRM has not painted yet.
 */
function CompanionAvatarSilhouette({ dark }: { dark: boolean }) {
  const stroke = dark ? "rgba(255,255,255,0.10)" : "rgba(0,0,0,0.08)";
  return (
    <div
      style={{
        position: "absolute",
        left: "50%",
        top: "50%",
        height: "74%",
        aspectRatio: "3 / 5",
        transform: "translate(-50%, -50%)",
        opacity: 0.95,
      }}
    >
      <svg
        viewBox="0 0 300 500"
        preserveAspectRatio="xMidYMid meet"
        style={{
          width: "100%",
          height: "100%",
          display: "block",
          filter: dark
            ? "drop-shadow(0 24px 60px rgba(255,88,0,0.22))"
            : "drop-shadow(0 24px 60px rgba(255,88,0,0.16))",
        }}
        role="img"
        aria-label="Companion avatar placeholder"
      >
        <defs>
          <linearGradient id="companion-figure" x1="0.5" y1="0" x2="0.5" y2="1">
            <stop offset="0%" stopColor="rgba(255,88,0,0.55)" />
            <stop offset="46%" stopColor="rgba(255,88,0,0.30)" />
            <stop
              offset="100%"
              stopColor={
                dark ? "rgba(120,40,255,0.18)" : "rgba(255,140,70,0.16)"
              }
            />
          </linearGradient>
          <radialGradient id="companion-halo" cx="0.5" cy="0.28" r="0.42">
            <stop offset="0%" stopColor="rgba(255,88,0,0.30)" />
            <stop offset="100%" stopColor="rgba(255,88,0,0)" />
          </radialGradient>
        </defs>

        {/* Soft halo behind the head/shoulders */}
        <ellipse
          cx="150"
          cy="150"
          rx="135"
          ry="170"
          fill="url(#companion-halo)"
        />

        {/* Head */}
        <circle
          cx="150"
          cy="96"
          r="48"
          fill="url(#companion-figure)"
          stroke={stroke}
          strokeWidth="1.5"
        />
        {/* Shoulders + torso, rounded bust silhouette */}
        <path
          d="M150 150
             C 96 150, 66 188, 58 246
             C 50 300, 64 360, 86 426
             C 100 466, 200 466, 214 426
             C 236 360, 250 300, 242 246
             C 234 188, 204 150, 150 150 Z"
          fill="url(#companion-figure)"
          stroke={stroke}
          strokeWidth="1.5"
        />
      </svg>
    </div>
  );
}
