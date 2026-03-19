import { AlertTriangle, CircleDollarSign } from "lucide-react";
import { useApp } from "../../state";

export function CloudCreditsChip() {
  const {
    elizaCloudEnabled,
    elizaCloudConnected,
    elizaCloudCredits,
    elizaCloudCreditsCritical,
    elizaCloudCreditsLow,
    setState,
    setTab,
    t,
  } = useApp();

  const showChip = elizaCloudEnabled || elizaCloudConnected;
  if (!showChip) return null;

  const openBilling = () => {
    setState("cloudDashboardView", "billing");
    setTab("settings");
  };

  if (!elizaCloudConnected) {
    return (
      <span
        data-testid="milady-bar-cloud-disconnected"
        className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-danger text-danger bg-danger/10 text-[11px] font-mono"
      >
        <AlertTriangle className="w-3 h-3" />
        {t("header.Cloud")}
      </span>
    );
  }

  const creditColor = elizaCloudCreditsCritical
    ? "border-danger text-danger bg-danger/10"
    : elizaCloudCreditsLow
      ? "border-warn text-warn bg-warn/10"
      : "border-ok text-ok bg-ok/10";

  const display =
    elizaCloudCredits === null
      ? t("header.elizaCloudConnected")
      : `$${elizaCloudCredits.toFixed(2)}`;

  return (
    <button
      type="button"
      data-testid="milady-bar-cloud-credits"
      className={`inline-flex items-center gap-1 px-2 py-1 rounded-md border font-mono text-[11px] transition-all hover:opacity-80 cursor-pointer ${
        elizaCloudCredits === null ? "border-muted text-muted" : creditColor
      }`}
      title={t("header.CloudCreditsBalanc")}
      onClick={openBilling}
    >
      <CircleDollarSign className="w-3 h-3" />
      {display}
    </button>
  );
}
