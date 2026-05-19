import { BRAND_PATHS, LOGO_FILES } from "@elizaos/shared/brand";
import { useT } from "@/providers/I18nProvider";

interface ElizaLogoProps {
  className?: string;
}

export function ElizaLogo({ className }: ElizaLogoProps) {
  const t = useT();
  return (
    <img
      src={`${BRAND_PATHS.logos}/${LOGO_FILES.elizaLockupBlack}`}
      alt={t("homepage_eliza.common.brandAlt", { defaultValue: "Eliza" })}
      className={className}
      draggable={false}
    />
  );
}
