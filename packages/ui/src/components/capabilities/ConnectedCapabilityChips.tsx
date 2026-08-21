/**
 * Chip strip showing one connector account's capability grants (#19884).
 * Granted capabilities render as calm accent-subtle chips, missing declared
 * capabilities carry the incremental-scope "Grant" affordance, and an account
 * whose server never reported access renders a visibly distinct muted note
 * instead of an empty-healthy strip.
 */

import { Plus } from "lucide-react";
import { cn } from "../../lib/utils";
import { useTranslation } from "../../state/TranslationContext.hooks";
import type { CapabilityChipModel } from "./connected-capability-presentation";

export interface ConnectedCapabilityChipsProps {
  /** `null` means access was never reported by the server. */
  chips: CapabilityChipModel[] | null;
  /** Busy capability id while a grant OAuth restart is in flight. */
  grantBusyCapabilityId?: string | null;
  onGrantCapability?: (capabilityId: string) => void;
}

export function ConnectedCapabilityChips({
  chips,
  grantBusyCapabilityId = null,
  onGrantCapability,
}: ConnectedCapabilityChipsProps) {
  const { t } = useTranslation();

  if (chips === null) {
    return (
      <p
        data-testid="capability-access-unreported"
        className="text-[10px] text-muted"
      >
        {t("connectoraccount.capabilities.unreported", {
          defaultValue:
            "Access not reported by the provider yet. Reconnect to refresh what this account can do.",
        })}
      </p>
    );
  }

  if (chips.length === 0) {
    return (
      <p
        data-testid="capability-access-empty"
        className="text-[10px] text-muted"
      >
        {t("connectoraccount.capabilities.none", {
          defaultValue: "No capabilities granted to this account.",
        })}
      </p>
    );
  }

  return (
    <div
      data-testid="capability-chips"
      className="flex flex-wrap items-center gap-1.5"
    >
      {chips.map((chip) => {
        const missing = chip.state === "missing";
        const busy = grantBusyCapabilityId === chip.id;
        return (
          <span
            key={chip.id}
            data-testid={`capability-chip-${chip.id}`}
            data-state={chip.state}
            title={chip.description}
            className={cn(
              "inline-flex items-center gap-1 rounded px-1.5 py-px text-[10px] font-medium",
              missing
                ? "border border-dashed border-border/60 text-muted"
                : "bg-accent-subtle text-accent-muted",
            )}
          >
            {chip.label}
            {missing && chip.action === "grant" && onGrantCapability ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => onGrantCapability(chip.id)}
                aria-label={t("connectoraccount.capabilities.grantAria", {
                  defaultValue: `Grant ${chip.label}`,
                  label: chip.label,
                })}
                className="inline-flex items-center gap-0.5 rounded px-1 text-[10px] font-semibold text-accent transition-colors hover:text-accent-muted disabled:opacity-50"
              >
                <Plus className="h-2.5 w-2.5" aria-hidden />
                {busy
                  ? t("connectoraccount.capabilities.granting", {
                      defaultValue: "Granting...",
                    })
                  : t("connectoraccount.capabilities.grant", {
                      defaultValue: "Grant",
                    })}
              </button>
            ) : null}
          </span>
        );
      })}
    </div>
  );
}
