/**
 * Image component for displaying AI-generated images from base64 data.
 * Uses a plain `<img>` so it stays framework-agnostic.
 *
 * @param props.base64 - Base64 encoded image data
 * @param props.mediaType - MIME type of the image
 * @param props.alt - Alt text for accessibility
 */
import type { Experimental_GeneratedImage } from "ai";
export type ImageProps = Experimental_GeneratedImage & {
    className?: string;
    alt?: string;
};
export declare const Image: ({ base64, mediaType, ...props }: ImageProps) => import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=image.d.ts.map