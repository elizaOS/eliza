/**
 * Steward brand icon.
 * Keep this inline so package builds do not depend on app-only SVG loaders.
 */

interface StewardLogoProps {
  className?: string;
  size?: number;
}

export function StewardLogo({ className, size = 20 }: StewardLogoProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      aria-hidden="true"
      focusable="false"
      fill="none"
    >
      <path
        d="M12 2.25 19.25 5v5.82c0 5.25-3.53 9.92-7.25 10.93-3.72-1.01-7.25-5.68-7.25-10.93V5L12 2.25Z"
        fill="#8B6539"
      />
      <path
        d="M12 5.25 16.25 6.86v3.62c0 3.47-2.12 6.55-4.25 7.37-2.13-.82-4.25-3.9-4.25-7.37V6.86L12 5.25Z"
        fill="#D9BE8E"
      />
      <path d="m12 8.2 2.4 2.65L12 15.75l-2.4-4.9L12 8.2Z" fill="#F7E7C8" />
    </svg>
  );
}
