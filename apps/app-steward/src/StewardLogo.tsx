/**
 * Steward brand icon — renders the steward shield logo SVG.
 * Uses Vite's asset import for the detailed SVG file.
 */

import stewardLogoUrl from "./steward-logo.svg";

interface StewardLogoProps {
  className?: string;
  size?: number;
}

export function StewardLogo({ className, size = 20 }: StewardLogoProps) {
  return (
    <img
      src={stewardLogoUrl}
      alt=""
      width={size}
      height={size}
      className={className}
      aria-hidden="true"
      draggable={false}
    />
  );
}
