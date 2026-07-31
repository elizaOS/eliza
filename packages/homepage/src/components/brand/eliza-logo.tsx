/** Brand wordmark used by the homepage navigation. */
import { useT } from "@/providers/I18nProvider";

interface ElizaLogoProps {
  className?: string;
}

export function ElizaLogo({ className }: ElizaLogoProps) {
  const t = useT();
  return (
    <img
      src="/eliza-logo.webp"
      alt={t("homepage_eliza.common.brandAlt", { defaultValue: "Eliza" })}
      className={className}
      draggable={false}
    />
  );
}
