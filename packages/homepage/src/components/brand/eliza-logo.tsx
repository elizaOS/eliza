/** Brand wordmark used by the homepage navigation. */
import { useT } from "@/providers/I18nProvider";

interface ElizaLogoProps {
  className?: string;
  /**
   * Render the crisp SVG wordmark instead of the padded raster asset.
   * Both variants share the exact same 512x216 padded geometry (the SVG is
   * a vector trace of the canonical eliza-logo.webp), so identical CSS
   * sizing renders an identical mark on every surface. New surfaces should
   * prefer the SVG: sharp at any DPI.
   */
  variant?: "raster" | "svg";
  /** Wordmark color for the SVG variant. */
  tone?: "black" | "white";
}

export function ElizaLogo({
  className,
  variant = "raster",
  tone = "black",
}: ElizaLogoProps) {
  const t = useT();
  const alt = t("homepage_eliza.common.brandAlt", { defaultValue: "Eliza" });
  if (variant === "svg") {
    return (
      <img
        src={`/brand/logos/eliza_wordmark_${tone}.svg`}
        alt={alt}
        width={512}
        height={216}
        className={className}
        draggable={false}
      />
    );
  }
  return (
    <img
      src="/eliza-logo.webp"
      alt={alt}
      width={512}
      height={216}
      className={className}
      draggable={false}
    />
  );
}
