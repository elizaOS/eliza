/**
 * Role/purpose selector for a connector account. Promoting an account to the
 * OWNER role opens a confirmation dialog whose requirement comes from
 * `connector-account-options`, keeping the owner-escalation guard centralized.
 */

import { useId, useMemo, useState } from "react";
import type { ConnectorAccountRole } from "../../api/client-agent";
import { useTranslation } from "../../state/TranslationContext.hooks";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { Spinner } from "../ui/spinner";
import {
  CONNECTOR_ACCOUNT_PURPOSE_OPTIONS,
  CONNECTOR_OWNER_ROLE_CONFIRMATION,
  getConnectorPurposeOption,
  getConnectorRoleConfirmationRequirement,
  isConnectorRoleConfirmationSatisfied,
} from "./connector-account-options";

export interface ConnectorAccountPurposeSelectorProps {
  value?: ConnectorAccountRole;
  onChange: (
    value: ConnectorAccountRole,
    confirmation?: { role?: string },
  ) => Promise<void> | void;
  disabled?: boolean;
  id?: string;
  accountLabel?: string;
}

export function ConnectorAccountPurposeSelector({
  value,
  onChange,
  disabled = false,
  id,
  accountLabel,
}: ConnectorAccountPurposeSelectorProps) {
  const { t } = useTranslation();
  const resolved = getConnectorPurposeOption(value).value;
  const [pendingValue, setPendingValue] = useState<ConnectorAccountRole | null>(
    null,
  );
  const [typedValue, setTypedValue] = useState("");
  const [confirmBusy, setConfirmBusy] = useState(false);
  const generatedId = useId();
  const confirmInputId = `${id ?? generatedId}-role-confirm`;
  const pendingRequirement = useMemo(
    () =>
      pendingValue
        ? getConnectorRoleConfirmationRequirement(resolved, pendingValue)
        : "none",
    [pendingValue, resolved],
  );
  const confirmEnabled = isConnectorRoleConfirmationSatisfied(
    pendingRequirement,
    typedValue,
  );

  const closeDialog = () => {
    if (confirmBusy) return;
    setPendingValue(null);
    setTypedValue("");
  };

  const handleValueChange = (next: string) => {
    const role = next as ConnectorAccountRole;
    if (role === resolved) return;
    const requirement = getConnectorRoleConfirmationRequirement(resolved, role);
    if (requirement === "none") {
      void onChange(role);
      return;
    }
    setTypedValue("");
    setPendingValue(role);
  };

  const handleConfirm = async () => {
    if (!pendingValue || !confirmEnabled) return;
    setConfirmBusy(true);
    try {
      await onChange(pendingValue, { role: CONNECTOR_OWNER_ROLE_CONFIRMATION });
      setPendingValue(null);
      setTypedValue("");
    } finally {
      setConfirmBusy(false);
    }
  };

  return (
    <>
      <div className="flex min-w-[180px] items-center gap-2">
        <span className="shrink-0 text-2xs font-medium uppercase tracking-wider text-muted">
          {t("connectorpurpose.actsAs", { defaultValue: "Acts as:" })}
        </span>
        <Select
          value={resolved}
          disabled={disabled}
          onValueChange={handleValueChange}
        >
          <SelectTrigger
            aria-label={
              accountLabel
                ? `Role for ${accountLabel}`
                : t("connectorpurpose.actsAs", { defaultValue: "Acts as" })
            }
            id={id}
            variant="connectorCompact"
            className="w-[132px]"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CONNECTOR_ACCOUNT_PURPOSE_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                <div className="flex flex-col gap-0.5 py-0.5">
                  <span className="text-sm font-medium text-txt">
                    {option.label}
                  </span>
                  <span className="text-xs text-muted">
                    {option.description}
                  </span>
                </div>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Dialog
        open={pendingValue !== null}
        onOpenChange={(open) => {
          if (!open) closeDialog();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t("connectorpurpose.assignTitle", {
                defaultValue: "Assign OWNER role?",
              })}
            </DialogTitle>
            <DialogDescription>
              {t("connectorpurpose.assignDescription", {
                defaultValue:
                  "OWNER accounts can access owner-gated connector data and perform owner-scoped connector actions.",
              })}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <Card variant="connectorInset">
              <span className="font-medium text-txt">
                {accountLabel ??
                  t("connectorpurpose.defaultLabel", {
                    defaultValue: "Connector account",
                  })}
              </span>{" "}
              {t("connectorpurpose.promotedTo", {
                defaultValue: "will be promoted to",
              })}{" "}
              <span className="font-medium text-txt">OWNER</span>.
            </Card>
            <div className="space-y-1.5">
              <label
                htmlFor={confirmInputId}
                className="text-xs font-medium text-txt"
              >
                {t("connectorpurpose.typeToConfirm", {
                  value: CONNECTOR_OWNER_ROLE_CONFIRMATION,
                  defaultValue: "Type {{value}} to confirm",
                })}
              </label>
              <Input
                id={confirmInputId}
                value={typedValue}
                density="compact"
                onChange={(event) => setTypedValue(event.target.value)}
                disabled={confirmBusy}
              />
            </div>
          </div>

          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="ghost"
              disabled={confirmBusy}
              onClick={closeDialog}
            >
              {t("connectorpurpose.cancel", { defaultValue: "Cancel" })}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={!confirmEnabled || confirmBusy}
              onClick={() => void handleConfirm()}
            >
              {confirmBusy ? (
                <Spinner className="size-3" />
              ) : (
                t("connectorpurpose.confirm", { defaultValue: "Confirm" })
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
