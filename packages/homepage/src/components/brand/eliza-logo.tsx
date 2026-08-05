/** Brand wordmark used by the homepage navigation. */
import { useT } from "@/providers/I18nProvider";

interface ElizaLogoProps {
  className?: string;
  /**
   * Render the crisp SVG wordmark instead of the padded raster asset.
   * The raster (512x216 webp with baked-in transparent padding) is kept for
   * the landing nav, which sizes itself around that padding. New surfaces
   * should prefer the SVG: sharp at any DPI and aspect-correct.
   */
  variant?: "raster" | "svg";
}

export function ElizaLogo({ className, variant = "raster" }: ElizaLogoProps) {
  const t = useT();
  const alt = t("homepage_eliza.common.brandAlt", { defaultValue: "Eliza" });
  if (variant === "svg") {
    return (
      <img
        src="/brand/logos/eliza_text_black.svg"
        alt={alt}
        width={269}
        height={99}
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
