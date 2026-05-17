import { type CSSProperties, type ReactNode } from "react";
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
/**
 * Full-bleed background that plays the optimized cloud loop video.
 *
 * Assumes the optimized cloud video files have been deployed alongside the
 * site at `{basePath}/clouds_<speed>_<height>p.{mp4,webm}`. Mobile devices
 * receive smaller renditions through `<source media>` queries; respects
 * `prefers-reduced-motion` by pausing the video and falling back to the
 * poster image.
 */
export declare function CloudVideoBackground({ basePath, speed, poster, scrim, scrimColor, overlay, children, className, style, }: CloudVideoBackgroundProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=CloudVideoBackground.d.ts.map