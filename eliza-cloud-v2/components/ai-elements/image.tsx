/**
 * Image component for displaying AI-generated images from base64 data.
 * Wraps Next.js Image component with optimized rendering for generated images.
 *
 * @param props - Image props including base64 data and media type
 * @param props.base64 - Base64 encoded image data
 * @param props.mediaType - MIME type of the image
 * @param props.alt - Alt text for accessibility
 */
import NextImage from "next/image";
import { cn } from "@/lib/utils";
import type { Experimental_GeneratedImage } from "ai";

export type ImageProps = Experimental_GeneratedImage & {
  className?: string;
  alt?: string;
};

export const Image = ({ base64, mediaType, ...props }: ImageProps) => {
  return (
    <NextImage
      {...props}
      alt={props.alt || "Generated image"}
      className={cn(
        "h-auto max-w-full overflow-hidden rounded-md",
        props.className,
      )}
      src={`data:${mediaType};base64,${base64}`}
      width={800}
      height={600}
      unoptimized
    />
  );
};
