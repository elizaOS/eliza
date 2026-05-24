import { CLOUD_BACKGROUND_ASSETS } from "@elizaos/shared/brand";
import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";

export type CloudVideoSpeed = "1x" | "4x" | "8x";

type VideoSource = {
  src: string;
  type: string;
  media?: string;
};

export type CloudVideoBackgroundProps = {
  /** Static image shown immediately, before the video can play. */
  poster?: string;
  /** Public base path for the speed-based cloud loop assets. */
  basePath?: string;
  /** Cloud loop speed for synced `/clouds/clouds_<speed>_<size>.*` assets. */
  speed?: CloudVideoSpeed;
  /** Responsive poster candidates for the static image layer. */
  posterSrcSet?: string;
  /** Responsive poster sizes for the static image layer. */
  posterSizes?: string;
  /** Cloud loop video for desktop / wide viewports. */
  videoSrc?: string;
  /** Smaller cloud loop for narrow viewports (cellular friendly). */
  videoSrcMobile?: string;
  /** Max viewport width (px) that receives the mobile rendition. */
  mobileMaxWidth?: number;
  /** Add a high-priority preload hint for the poster image. */
  preloadPoster?: boolean;
  /** Whether to load and play the video layer at all. */
  animated?: boolean;
  /** Optional dark/light overlay scrim over the video (0–1). */
  scrim?: number;
  /** Scrim color. Default black. */
  scrimColor?: string;
  /** Extra content rendered above the video, beneath children. */
  overlay?: ReactNode;
  /** Foreground content. */
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
};

function joinAssetPath(basePath: string, filename: string): string {
  const base = basePath.replace(/\/+$/, "");
  const name = filename.replace(/^\/+/, "");
  return base ? `${base}/${name}` : `/${name}`;
}

function cloudLoopSources(
  basePath: string,
  speed: CloudVideoSpeed,
): VideoSource[] {
  const variants = [
    { size: "1080p", media: "(min-width: 1440px)" },
    { size: "720p", media: "(min-width: 768px)" },
    { size: "480p", media: "(min-width: 481px)" },
    { size: "360p", media: "(max-width: 480px)" },
  ] as const;

  return variants.flatMap(({ size, media }) => [
    {
      src: joinAssetPath(basePath, `clouds_${speed}_${size}.webm`),
      type: "video/webm",
      media,
    },
    {
      src: joinAssetPath(basePath, `clouds_${speed}_${size}.mp4`),
      type: "video/mp4",
      media,
    },
  ]);
}

/**
 * Full-bleed cloud background.
 *
 * Shows the poster image immediately, then — once the client has finished
 * loading everything else (document `complete`) — streams and plays the cloud
 * loop video, cross-fading it in over the poster. Respects
 * `prefers-reduced-motion` by skipping the video entirely.
 */
export function CloudVideoBackground({
  poster = CLOUD_BACKGROUND_ASSETS.poster,
  basePath,
  speed = "8x",
  posterSrcSet,
  posterSizes,
  videoSrc = CLOUD_BACKGROUND_ASSETS.source1080pMp4,
  videoSrcMobile = CLOUD_BACKGROUND_ASSETS.sourceMobile480pMp4,
  mobileMaxWidth = 640,
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
    document.head.appendChild(link);
    return () => {
      link.remove();
    };
  }, [poster, preloadPoster]);

  // Poster first, video second: hold the video layer back until the rest of
  // the client has finished loading, and pause on reduced-motion.
  useEffect(() => {
    if (!animated || typeof window === "undefined") {
      setLoadVideo(false);
      setVideoReady(false);
      return;
    }
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    let timer = 0;
    const start = () => {
      if (reduced.matches) {
        setLoadVideo(false);
        setVideoReady(false);
        videoRef.current?.pause();
        return;
      }
      // Defer a beat past `load` so first paint stays on the poster and the
      // video fetch never competes with the initial app load.
      timer = window.setTimeout(() => setLoadVideo(true), 120);
    };
    const onReady = () => start();
    reduced.addEventListener("change", start);
    if (document.readyState === "complete") {
      start();
    } else {
      window.addEventListener("load", onReady, { once: true });
    }
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("load", onReady);
      reduced.removeEventListener("change", start);
    };
  }, [animated]);

  useEffect(() => {
    const v = videoRef.current;
    if (!loadVideo || !v) return;
    try {
      v.load();
      const p = v.play();
      if (p && typeof (p as Promise<void>).catch === "function") {
        (p as Promise<void>).catch(() => {
          /* autoplay blocked; the poster image stays visible */
        });
      }
    } catch {
      /* jsdom and some browsers reject media playback synchronously. */
    }
  }, [loadVideo]);

  const fallbackBackground =
    "radial-gradient(circle at 18% 18%, rgba(255,255,255,0.95) 0 7rem, rgba(255,255,255,0.42) 7.1rem 12rem, transparent 12.1rem), radial-gradient(circle at 82% 24%, rgba(255,255,255,0.82) 0 5rem, rgba(255,255,255,0.34) 5.1rem 9rem, transparent 9.1rem), linear-gradient(180deg, #80caff 0%, #bde9ff 42%, #f7c38d 100%)";
  const sources = basePath
    ? cloudLoopSources(basePath, speed)
    : [
        ...(videoSrcMobile
          ? [
              {
                src: videoSrcMobile,
                type: "video/mp4",
                media: `(max-width: ${mobileMaxWidth}px)`,
              },
            ]
          : []),
        { src: videoSrc, type: "video/mp4" },
      ];

  return (
    <div
      className={className}
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        overflow: "hidden",
        background: fallbackBackground,
        ...style,
      }}
    >
      {poster ? (
        <img
          src={poster}
          srcSet={posterSrcSet}
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
          preload="metadata"
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
            opacity: loadVideo && videoReady ? 1 : 0,
            transition: "opacity 700ms ease",
            zIndex: 1,
          }}
        >
          {sources.map((source) => (
            <source
              key={`${source.type}:${source.media ?? "default"}:${source.src}`}
              src={source.src}
              type={source.type}
              media={source.media}
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
            zIndex: 2,
          }}
        />
      ) : null}
      {overlay ? (
        <div style={{ position: "absolute", inset: 0, zIndex: 3 }}>
          {overlay}
        </div>
      ) : null}
      <div
        style={{
          position: "relative",
          zIndex: 4,
          width: "100%",
          height: "100%",
          minHeight: "inherit",
        }}
      >
        {children}
      </div>
    </div>
  );
}
