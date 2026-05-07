/**
 * Image component for displaying AI-generated images from base64 data.
 * Uses a plain `<img>` so it stays framework-agnostic.
 *
 * @param props - Image props including base64 data and media type
 * @param props.base64 - Base64 encoded image data
 * @param props.mediaType - MIME type of the image
 * @param props.alt - Alt text for accessibility
 */
// Native img used for framework agnosticism

import type { Experimental_GeneratedImage } from "ai";
import { cn } from "../../lib/utils";

export type ImageProps = Experimental_GeneratedImage & {
  className?: string;
  alt?: string;
};

export const Image = ({ base64, mediaType, ...props }: ImageProps) => {
  return (
    <img
      {...props}
      alt={props.alt || "Generated image"}
      className={cn("h-auto max-w-full overflow-hidden rounded-md", props.className)}
      src={`data:${mediaType};base64,${base64}`}
      width={800}
      height={600}
    />
  );
};
