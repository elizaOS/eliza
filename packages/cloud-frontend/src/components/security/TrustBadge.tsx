import { Badge } from "@elizaos/ui";
import { ShieldAlert, ShieldCheck, ShieldQuestion } from "lucide-react";
import { useT } from "@/providers/I18nProvider";

export type TrustBadgeVariant = "signed" | "unsigned" | "unknown";

interface TrustBadgeProps {
  variant: TrustBadgeVariant;
  publisher?: string;
  className?: string;
}

const COPY: Record<
  TrustBadgeVariant,
  {
    labelKey: string;
    defaultLabel: string;
    icon: typeof ShieldCheck;
    tone: string;
    titleKey: string;
    defaultTitle: string;
  }
> = {
  signed: {
    labelKey: "cloud.trustBadge.signed",
    defaultLabel: "Signed",
    icon: ShieldCheck,
    tone: "border-green-500/40 bg-green-500/10 text-green-300",
    titleKey: "cloud.trustBadge.signedTitle",
    defaultTitle:
      "Tarball signature verified against the publisher key chain. Safe to install.",
  },
  unsigned: {
    labelKey: "cloud.trustBadge.unsigned",
    defaultLabel: "Unsigned",
    icon: ShieldAlert,
    tone: "border-red-500/40 bg-red-500/10 text-red-300",
    titleKey: "cloud.trustBadge.unsignedTitle",
    defaultTitle:
      "No valid signature. Eliza will refuse to install this plugin. Contact the publisher.",
  },
  unknown: {
    labelKey: "cloud.trustBadge.unknown",
    defaultLabel: "Unknown",
    icon: ShieldQuestion,
    tone: "border-yellow-500/40 bg-yellow-500/10 text-yellow-300",
    titleKey: "cloud.trustBadge.unknownTitle",
    defaultTitle:
      "Signature could not be verified (publisher key not pinned in your trust store).",
  },
};

export function TrustBadge({ variant, publisher, className }: TrustBadgeProps) {
  const t = useT();
  const copy = COPY[variant];
  const Icon = copy.icon;
  const title = t(copy.titleKey, { defaultValue: copy.defaultTitle });
  const tooltip = publisher
    ? t("cloud.trustBadge.tooltipWithPublisher", {
        title,
        publisher,
        defaultValue: "{{title}}\nPublisher: {{publisher}}",
      })
    : title;
  return (
    <Badge
      variant="outline"
      className={`inline-flex items-center gap-1 ${copy.tone} ${className ?? ""}`}
      title={tooltip}
      data-testid={`trust-badge-${variant}`}
    >
      <Icon className="h-3 w-3" aria-hidden />
      <span>{t(copy.labelKey, { defaultValue: copy.defaultLabel })}</span>
    </Badge>
  );
}
