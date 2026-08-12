/**
 * Shared deactivation confirmation for list and detail actions. Current-rate
 * copy comes only from the row DTO; unavailable pricing never becomes a client
 * estimate or a fabricated savings claim.
 */

"use client";

import { formatHourlyRate } from "@elizaos/cloud-shared/lib/constants/agent-pricing-display";
import type { AgentHostingCostDto } from "@elizaos/cloud-shared/lib/types/cloud-api";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@elizaos/ui/cloud-ui";
import { Loader2, Moon } from "lucide-react";
import { Button } from "../../../components/ui/button";
import { useT } from "../lib/i18n";

interface DeactivateAgentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hostingCost: AgentHostingCostDto;
  confirmDisabled: boolean;
  isConfirming: boolean;
  onConfirm: () => void;
}

export function DeactivateAgentDialog({
  open,
  onOpenChange,
  hostingCost,
  confirmDisabled,
  isConfirming,
  onConfirm,
}: DeactivateAgentDialogProps) {
  const t = useT();
  const billingCopy =
    hostingCost.pricingState === "known"
      ? t("cloud.containers.agentActions.deactivateBody1", {
          defaultValue:
            "Your agent stops running and stops consuming hourly credits (currently {{rate}} while running).",
          rate: formatHourlyRate(hostingCost.hourlyRateUsd),
        })
      : t("cloud.containers.agentActions.deactivateBodyPricingUnavailable", {
          defaultValue:
            "Your agent stops running and stops consuming hourly credits. Its current hosting price is unavailable, so no rate or savings estimate is shown.",
        });

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="bg-card border-border">
        <AlertDialogHeader>
          <AlertDialogTitle className="text-txt-strong">
            {t("cloud.containers.agentActions.deactivateTitle", {
              defaultValue: "Deactivate this agent?",
            })}
          </AlertDialogTitle>
          <AlertDialogDescription className="text-muted">
            <span className="block">{billingCopy}</span>
            <span className="block mt-2">
              {t("cloud.containers.agentActions.deactivateBody2", {
                defaultValue:
                  "Before deactivation, Eliza saves an encrypted backup. If the backup cannot be saved, the agent stays running and billing continues.",
              })}
            </span>
            <span className="block mt-2">
              {t("cloud.containers.agentActions.deactivateBody3", {
                defaultValue:
                  "Reactivation restores the backup and can take a few minutes; it requires available credits.",
              })}
            </span>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel className="border-border bg-transparent text-txt hover:bg-surface">
            {t("cloud.containers.agentActions.cancel", {
              defaultValue: "Cancel",
            })}
          </AlertDialogCancel>
          <Button type="button" disabled={confirmDisabled} onClick={onConfirm}>
            {isConfirming ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Moon className="h-4 w-4" />
            )}
            {t("cloud.containers.agentActions.deactivateConfirm", {
              defaultValue: "Yes, deactivate",
            })}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
