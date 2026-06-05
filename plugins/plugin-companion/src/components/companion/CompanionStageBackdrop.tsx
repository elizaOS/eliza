import { memo } from "react";

/**
 * CompanionStageBackdrop — the aesthetic stage that lives *behind* the
 * transparent VRM canvas. When the avatar renders, the WebGL layer (cleared
 * to alpha 0) composites on top and this shows through as a soft backdrop +
 * floor glow. When the avatar is absent or still loading, this layer is the
 * visible centerpiece: a gradient stage plus a gradient-filled avatar
 * silhouette, so the companion is never an empty void.
 *
 * Pure presentation, theme-token driven (no hard-coded brand values beyond the
 * shared --accent / surface CSS vars). No business logic, no computation.
 */
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
      className="pointer-events-none absolute inset-0 overflow-hidden"
    >
      {/* Ambient stage wash — soft accent halo over a neutral vignette. */}
      <div
        className="absolute inset-0"
        style={{
          background: dark
            ? "radial-gradient(120% 90% at 50% 18%, rgba(255,88,0,0.10) 0%, rgba(255,88,0,0) 46%), radial-gradient(140% 120% at 50% 120%, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0) 55%), linear-gradient(180deg, #0a0810 0%, #0e0b16 48%, #060509 100%)"
            : "radial-gradient(120% 90% at 50% 16%, rgba(255,88,0,0.12) 0%, rgba(255,88,0,0) 46%), radial-gradient(140% 120% at 50% 122%, rgba(0,0,0,0.05) 0%, rgba(0,0,0,0) 55%), linear-gradient(180deg, #fafafa 0%, #f3f3f5 52%, #ececef 100%)",
        }}
      />

      {/* Centre spotlight that grounds the avatar. */}
      <div
        className="absolute left-1/2 top-1/2 h-[120%] w-[120%] -translate-x-1/2 -translate-y-1/2"
        style={{
          background: dark
            ? "radial-gradient(closest-side, rgba(255,88,0,0.07) 0%, rgba(255,88,0,0) 70%)"
            : "radial-gradient(closest-side, rgba(255,88,0,0.06) 0%, rgba(255,88,0,0) 70%)",
        }}
      />

      {showSilhouette && <CompanionAvatarSilhouette dark={dark} />}

      {/* Floor reflection ellipse so the figure feels planted. */}
      <div
        className="absolute left-1/2 bottom-[10%] h-[7%] w-[34%] -translate-x-1/2 rounded-[50%] blur-2xl"
        style={{
          background: dark
            ? "radial-gradient(50% 50% at 50% 50%, rgba(255,88,0,0.22) 0%, rgba(255,88,0,0) 72%)"
            : "radial-gradient(50% 50% at 50% 50%, rgba(255,88,0,0.16) 0%, rgba(255,88,0,0) 72%)",
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
      className="absolute left-1/2 top-[52%] h-[78%] -translate-x-1/2 -translate-y-1/2 opacity-90"
      style={{ aspectRatio: "3 / 5" }}
    >
      <svg
        viewBox="0 0 300 500"
        className="h-full w-full"
        style={{
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
