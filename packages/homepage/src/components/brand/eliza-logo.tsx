import { BRAND_PATHS, LOGO_FILES } from "@elizaos/shared-brand";

interface ElizaLogoProps {
  className?: string;
}

export function ElizaLogo({ className }: ElizaLogoProps) {
  return (
    <img
      src={`${BRAND_PATHS.logos}/${LOGO_FILES.elizaLockupBlack}`}
      alt="Eliza"
      className={className}
      draggable={false}
    />
  );
}
