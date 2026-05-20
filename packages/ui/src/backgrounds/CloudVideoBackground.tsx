import {
  BRAND_PATHS,
  CLOUD_VIDEO_VARIANTS,
  type CloudVideoSpeed,
} from "@elizaos/shared/brand";
import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";

export type CloudVideoBackgroundProps = {
  /** Path prefix where the optimized cloud video files are hosted. */
  basePath?: string;
  /** Playback speed variant. Slower variants are perceived as more cinematic. */
  speed?: CloudVideoSpeed;
  /** Static image shown before the video can play. Prefer WebP. */
  poster?: string;
  /** Responsive poster candidates for the real image layer. */
  posterSrcSet?: string;
  /** Sizes descriptor for the poster image. */
  posterSizes?: string;
  /** Whether to add a high-priority image preload hint for the poster. */
  preloadPoster?: boolean;
  /** Whether to load and play the video layer. */
  animated?: boolean;
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
  poster = BRAND_PATHS.poster,
  posterSrcSet,
  posterSizes = "100vw",
  preloadPoster = true,
  animated = true,
  scrim = 0,
  scrimColor = "rgba(0, 0, 0, 1)",
  overlay,
  children,
  className,
  style,
}: CloudVideoBackgroundProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [loadVideo, setLoadVideo] = useState(false);
  const [videoReady, setVideoReady] = useState(false);
  const base = basePath.replace(/\/$/, "");
  const resolvedPosterSrcSet =
    posterSrcSet ?? `${base}/poster-640.jpg 640w, ${base}/poster-960.jpg 960w`;

  useEffect(() => {
    if (!preloadPoster || typeof document === "undefined" || !poster) return;
    const existing = document.head.querySelector<HTMLLinkElement>(
      `link[rel="preload"][as="image"][href="${poster}"]`,
    );
    if (existing) return;
    const link = document.createElement("link");
    link.rel = "preload";
    link.as = "image";
    link.href = poster;
    link.setAttribute("fetchpriority", "high");
    if (resolvedPosterSrcSet) {
      link.setAttribute("imagesrcset", resolvedPosterSrcSet);
    }
    if (posterSizes) {
      link.setAttribute("imagesizes", posterSizes);
    }
    document.head.appendChild(link);
    return () => {
      link.remove();
    };
  }, [poster, posterSizes, preloadPoster, resolvedPosterSrcSet]);

  useEffect(() => {
    if (!animated) {
      setLoadVideo(false);
      setVideoReady(false);
      videoRef.current?.pause();
      return;
    }
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0;
    const apply = () => {
      if (reduced.matches) {
        setLoadVideo(false);
        setVideoReady(false);
        videoRef.current?.pause();
      } else {
        frame = window.requestAnimationFrame(() => setLoadVideo(true));
      }
    };
    apply();
    reduced.addEventListener("change", apply);
    return () => {
      window.cancelAnimationFrame(frame);
      reduced.removeEventListener("change", apply);
    };
  }, [animated]);

  useEffect(() => {
    setVideoReady(false);
  }, []);

  useEffect(() => {
    const v = videoRef.current;
    if (!loadVideo || !v) return;
    try {
      const p = v.play();
      if (p && typeof (p as Promise<void>).catch === "function") {
        (p as Promise<void>).catch(() => {
          /* autoplay blocked; the poster image stays visible */
        });
      }
    } catch {
      /* jsdom and some browsers can reject media playback synchronously. */
    }
  }, [loadVideo]);

  const sources = CLOUD_VIDEO_VARIANTS[speed];
  const fallbackBackground =
    "radial-gradient(circle at 18% 18%, rgba(255,255,255,0.95) 0 7rem, rgba(255,255,255,0.42) 7.1rem 12rem, transparent 12.1rem), radial-gradient(circle at 82% 24%, rgba(255,255,255,0.82) 0 5rem, rgba(255,255,255,0.34) 5.1rem 9rem, transparent 9.1rem), linear-gradient(180deg, #80caff 0%, #bde9ff 42%, #f7c38d 100%)";

  return (
    <div
      className={className}
      style={{
        position: "relative",
        width: "100%",
        overflow: "hidden",
        background: fallbackBackground,
        ...style,
      }}
    >
      {poster ? (
        <img
          src={poster}
          srcSet={resolvedPosterSrcSet}
          sizes={posterSizes}
          alt=""
          aria-hidden="true"
          loading="eager"
          decoding="async"
          fetchPriority="high"
          draggable={false}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            objectFit: "cover",
            zIndex: 0,
          }}
        />
      ) : null}
      {animated ? (
        <video
          ref={videoRef}
          autoPlay
          loop
          muted
          playsInline
          preload={loadVideo ? "metadata" : "none"}
          poster={poster}
          disableRemotePlayback
          disablePictureInPicture
          onCanPlay={() => setVideoReady(true)}
          onLoadedData={() => setVideoReady(true)}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            objectFit: "cover",
            opacity: videoReady ? 1 : 0,
            transition: "opacity 700ms ease",
            zIndex: 1,
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
      ) : null}
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
      <div
        style={{
          position: "relative",
          zIndex: 3,
          minHeight: "inherit",
          height: "100%",
        }}
      >
        {children}
      </div>
    </div>
  );
}
