/**
 * Runtime image shim for cloud-ui: a plain img wrapper standing in for the host framework's Image.
 */
import type { CSSProperties, ImgHTMLAttributes } from "react";

interface CloudImageProps
  extends Omit<ImgHTMLAttributes<HTMLImageElement>, "loading" | "src"> {
  src: string;
  width?: number | string;
  height?: number | string;
  alt: string;
  fill?: boolean;
  priority?: boolean;
  sizes?: string;
}

export default function CloudImage({
  src,
  width,
  height,
  alt,
  fill,
  priority,
  sizes,
  style,
  ...rest
}: CloudImageProps) {
  const finalStyle: CSSProperties | undefined = fill
    ? {
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        ...style,
      }
    : style;
  return (
    <img
      src={src}
      width={width}
      height={height}
      alt={alt}
      loading={priority ? "eager" : "lazy"}
      fetchPriority={priority ? "high" : undefined}
      sizes={sizes}
      style={finalStyle}
      {...rest}
    />
  );
}
