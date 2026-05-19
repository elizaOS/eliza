import { BRAND_PATHS, LOGO_FILES } from "@elizaos/shared-brand";

interface ElizaLogoProps {
  className?: string;
  style?: React.CSSProperties;
}

const src = `${BRAND_PATHS.logos}/${LOGO_FILES.elizaWhite}`;

export function ElizaLogo({ className, style }: ElizaLogoProps) {
  return (
    <img
      src={src}
      alt="Eliza"
      aria-hidden="true"
      className={className}
      style={style}
    />
  );
}
