/**
 * At-a-glance "who is answering this chat" chip for the composer. Settings can
 * state the full runtime × inference matrix, but the chat surface had no
 * provider indicator at all, so a user mid-conversation could not tell whether
 * a reply came from Eliza Cloud, an third-party provider, or the on-device model
 * (elizaOS/eliza#20045 U6).
 *
 * Reads the same reconciled axes as Settings rather than re-deriving serving
 * state from account flags, so the two surfaces cannot disagree. Renders
 * nothing until the serving source is known — an indicator that guesses is
 * worse than no indicator.
 */

import { Cloud, Cpu, Server } from "lucide-react";
import { useBranding } from "../../../config/branding";
import { cn } from "../../../lib/utils";
import { useAppSelectorShallow } from "../../../state";
import { useServingAxes } from "../../settings/useServingAxes";

export function ServingProviderChip({ className }: { className?: string }) {
  const { cloudOnly } = useBranding();
  if (cloudOnly) return null;

  return <ServingProviderChipContent className={className} />;
}

function ServingProviderChipContent({ className }: { className?: string }) {
  const { elizaCloudConnected, t } = useAppSelectorShallow((s) => ({
    elizaCloudConnected: s.elizaCloudConnected,
    t: s.t,
  }));
  // The chip only reports; it never drives routing, so it reads the serving
  // axes with the account state it can see and leaves selection to Settings.
  const axes = useServingAxes({
    elizaCloudConnected: Boolean(elizaCloudConnected),
    isCloudSelected: Boolean(elizaCloudConnected),
    cloudCallsDisabled: false,
  });

  if (axes.inference === "unknown") return null;

  const Icon =
    axes.inference === "cloud"
      ? Cloud
      : axes.inference === "external"
        ? Server
        : Cpu;
  const label =
    axes.inference === "cloud"
      ? t("chat.servingProviderCloud", { defaultValue: "Eliza Cloud" })
      : axes.inference === "external"
        ? (axes.activeChatProvider ??
          t("chat.servingProviderExternal", { defaultValue: "External" }))
        : t("chat.servingProviderLocal", { defaultValue: "On device" });

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] text-muted",
        className,
      )}
      data-testid="serving-provider-chip"
      title={t("chat.servingProviderTitle", {
        defaultValue: "Chat replies are computed by {{provider}}",
        provider: label,
      })}
    >
      <Icon className="h-3 w-3 shrink-0" aria-hidden />
      {label}
    </span>
  );
}
