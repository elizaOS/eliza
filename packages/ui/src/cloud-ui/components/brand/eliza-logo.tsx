/**
 * The Eliza logo mark, rendered from the shared brand paths.
 */

import type { CSSProperties } from "react";
import { BRAND_PATHS, LOGO_FILES } from "../../../brand/index.js";

interface ElizaLogoProps {
  className?: string;
  style?: CSSProperties;
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
