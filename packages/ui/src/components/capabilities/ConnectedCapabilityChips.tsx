/**
 * Chip strip showing one connector account's capability grants (#19884).
 * Granted capabilities render as calm accent-subtle chips, missing declared
 * capabilities carry the incremental-scope "Grant" affordance, and an account
 * whose server never reported access renders a visibly distinct muted note
 * instead of an empty-healthy strip.
 */

import { Plus } from "lucide-react";
import { useTranslation } from "../../state/TranslationContext.hooks";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
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
        className="text-xs text-muted"
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
      <p data-testid="capability-access-empty" className="text-xs text-muted">
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
          <Badge
            key={chip.id}
            asChild
            variant={missing ? "capabilityMissing" : "capabilityGranted"}
          >
            <span
              data-testid={`capability-chip-${chip.id}`}
              data-state={chip.state}
              title={chip.description}
              className="inline-flex items-center gap-1 px-1.5 py-px text-2xs font-medium"
            >
              {chip.label}
              {missing && chip.action === "grant" && onGrantCapability ? (
                <Button
                  variant="link"
                  size="micro"
                  type="button"
                  disabled={busy}
                  onClick={() => onGrantCapability(chip.id)}
                  aria-label={t("connectoraccount.capabilities.grantAria", {
                    defaultValue: `Grant ${chip.label}`,
                    label: chip.label,
                  })}
                >
                  <Plus className="size-2.5" aria-hidden />
                  {busy
                    ? t("connectoraccount.capabilities.granting", {
                        defaultValue: "Granting...",
                      })
                    : t("connectoraccount.capabilities.grant", {
                        defaultValue: "Grant",
                      })}
                </Button>
              ) : null}
            </span>
          </Badge>
        );
      })}
    </div>
  );
}
