import { Badge } from "@elizaos/ui";
import { ShieldAlert, ShieldCheck, ShieldQuestion } from "lucide-react";

export type TrustBadgeVariant = "signed" | "unsigned" | "unknown";

interface TrustBadgeProps {
  variant: TrustBadgeVariant;
  publisher?: string;
  className?: string;
}

const COPY: Record<
  TrustBadgeVariant,
  { label: string; icon: typeof ShieldCheck; tone: string; title: string }
> = {
  signed: {
    label: "Signed",
    icon: ShieldCheck,
    tone: "border-green-500/40 bg-green-500/10 text-green-300",
    title:
      "Tarball signature verified against the publisher key chain. Safe to install.",
  },
  unsigned: {
    label: "Unsigned",
    icon: ShieldAlert,
    tone: "border-red-500/40 bg-red-500/10 text-red-300",
    title:
      "No valid signature. Eliza will refuse to install this plugin. Contact the publisher.",
  },
  unknown: {
    label: "Unknown",
    icon: ShieldQuestion,
    tone: "border-yellow-500/40 bg-yellow-500/10 text-yellow-300",
    title:
      "Signature could not be verified (publisher key not pinned in your trust store).",
  },
};

export function TrustBadge({ variant, publisher, className }: TrustBadgeProps) {
  const copy = COPY[variant];
  const Icon = copy.icon;
  const tooltip = publisher
    ? `${copy.title}\nPublisher: ${publisher}`
    : copy.title;
  return (
    <Badge
      variant="outline"
      className={`inline-flex items-center gap-1 ${copy.tone} ${className ?? ""}`}
      title={tooltip}
      data-testid={`trust-badge-${variant}`}
    >
      <Icon className="h-3 w-3" aria-hidden />
      <span>{copy.label}</span>
    </Badge>
  );
}
