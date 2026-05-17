import type { ImgHTMLAttributes } from "react";
interface CloudImageProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, "loading" | "src"> {
    src: string;
    width?: number | string;
    height?: number | string;
    alt: string;
    fill?: boolean;
    priority?: boolean;
    sizes?: string;
    placeholder?: string;
    blurDataURL?: string;
    quality?: number;
    loader?: never;
    unoptimized?: boolean;
}
export default function CloudImage({ src, width, height, alt, fill, priority: _priority, sizes: _sizes, placeholder: _placeholder, blurDataURL: _blurDataURL, quality: _quality, unoptimized: _unoptimized, style, ...rest }: CloudImageProps): import("react/jsx-runtime").JSX.Element;
export {};
//# sourceMappingURL=image.d.ts.map