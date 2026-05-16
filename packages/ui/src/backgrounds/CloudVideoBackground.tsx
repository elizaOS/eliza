import { type CSSProperties, type ReactNode, useEffect, useRef } from "react";

export type CloudVideoBackgroundProps = {
  /** Path prefix where the optimized cloud video files are hosted. */
  basePath?: string;
  /** Playback speed variant. Slower variants are perceived as more cinematic. */
  speed?: "1x" | "4x" | "8x";
  /** Static image shown before the video can play. */
  poster?: string;
  /** Optional dark/light overlay scrim over the video (0–1). */
  scrim?: number;
  /** Scrim color. Default black; switch to white over the blue/orange themes. */
  scrimColor?: string;
  /** Extra content rendered above the video, beneath children. */
  overlay?: ReactNode;
  /** Foreground content. */
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
};

const SOURCE_SETS = {
  "1x": [
    { src: "clouds_1x_1080p.webm", type: "video/webm", minWidth: 1280 },
    { src: "clouds_1x_1080p.mp4", type: "video/mp4", minWidth: 1280 },
    { src: "clouds_1x_720p.webm", type: "video/webm", minWidth: 768 },
    { src: "clouds_1x_720p.mp4", type: "video/mp4", minWidth: 768 },
    { src: "clouds_1x_480p.webm", type: "video/webm" },
    { src: "clouds_1x_480p.mp4", type: "video/mp4" },
  ],
  "4x": [
    { src: "clouds_4x_1080p.webm", type: "video/webm", minWidth: 1280 },
    { src: "clouds_4x_1080p.mp4", type: "video/mp4", minWidth: 1280 },
    { src: "clouds_4x_720p.webm", type: "video/webm", minWidth: 768 },
    { src: "clouds_4x_720p.mp4", type: "video/mp4", minWidth: 768 },
    { src: "clouds_4x_480p.webm", type: "video/webm" },
    { src: "clouds_4x_480p.mp4", type: "video/mp4" },
  ],
  "8x": [
    { src: "clouds_8x_1080p.webm", type: "video/webm", minWidth: 1280 },
    { src: "clouds_8x_1080p.mp4", type: "video/mp4", minWidth: 1280 },
    { src: "clouds_8x_720p.webm", type: "video/webm", minWidth: 768 },
    { src: "clouds_8x_720p.mp4", type: "video/mp4", minWidth: 768 },
    { src: "clouds_8x_480p.webm", type: "video/webm" },
    { src: "clouds_8x_480p.mp4", type: "video/mp4" },
  ],
} as const;

/**
 * Full-bleed background that plays the optimized cloud loop video.
 *
 * Assumes the optimized cloud video files have been deployed alongside the
 * site at `{basePath}/clouds_<speed>_<height>p.{mp4,webm}`. Mobile devices
 * receive smaller renditions through `<source media>` queries; respects
 * `prefers-reduced-motion` by pausing the video and falling back to the
 * poster image.
 */
export function CloudVideoBackground({
  basePath = "/clouds",
  speed = "4x",
  poster,
  scrim = 0,
  scrimColor = "rgba(0, 0, 0, 1)",
  overlay,
  children,
  className,
  style,
}: CloudVideoBackgroundProps) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => {
      if (reduced.matches) {
        v.pause();
      } else {
        const p = v.play();
        if (p && typeof (p as Promise<void>).catch === "function") {
          (p as Promise<void>).catch(() => {
            /* autoplay blocked; the poster will remain visible */
          });
        }
      }
    };
    apply();
    reduced.addEventListener("change", apply);
    return () => reduced.removeEventListener("change", apply);
  }, []);

  const sources = SOURCE_SETS[speed];
  const base = basePath.replace(/\/$/, "");

  return (
    <div
      className={className}
      style={{
        position: "relative",
        width: "100%",
        overflow: "hidden",
        ...style,
      }}
    >
      <video
        ref={videoRef}
        autoPlay
        loop
        muted
        playsInline
        preload="auto"
        poster={poster}
        aria-hidden="true"
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          objectFit: "cover",
          zIndex: 0,
        }}
      >
        {sources.map((s) => (
          <source
            key={`${s.src}-${s.type}`}
            src={`${base}/${s.src}`}
            type={s.type}
            media={
              "minWidth" in s
                ? `(min-width: ${(s as { minWidth: number }).minWidth}px)`
                : undefined
            }
          />
        ))}
      </video>
      {scrim > 0 ? (
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            inset: 0,
            background: scrimColor,
            opacity: scrim,
            zIndex: 1,
          }}
        />
      ) : null}
      {overlay ? (
        <div style={{ position: "absolute", inset: 0, zIndex: 2 }}>
          {overlay}
        </div>
      ) : null}
      <div style={{ position: "relative", zIndex: 3 }}>{children}</div>
    </div>
  );
}
