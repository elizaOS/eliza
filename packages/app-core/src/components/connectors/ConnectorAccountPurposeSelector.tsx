import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@elizaos/ui";
import { useId, useMemo, useState } from "react";
import type { ConnectorAccountRole } from "../../api/client-agent";
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
  const resolved = getConnectorPurposeOption(value).value;
  const [pendingValue, setPendingValue] =
    useState<ConnectorAccountRole | null>(null);
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
        <span className="shrink-0 text-[10px] font-medium uppercase tracking-wider text-muted">
          Acts as:
        </span>
        <Select
          value={resolved}
          disabled={disabled}
          onValueChange={handleValueChange}
        >
          <SelectTrigger
            id={id}
            className="h-8 w-[132px] rounded-lg border border-border bg-card text-xs"
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
            <DialogTitle>Assign OWNER role?</DialogTitle>
            <DialogDescription>
              OWNER accounts can access owner-gated connector data and perform
              owner-scoped connector actions.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="rounded-lg border border-border/50 bg-bg-accent/40 px-3 py-2 text-xs text-muted">
              <span className="font-medium text-txt">
                {accountLabel ?? "Connector account"}
              </span>{" "}
              will be promoted to{" "}
              <span className="font-medium text-txt">OWNER</span>.
            </div>
            <div className="space-y-1.5">
              <label
                htmlFor={confirmInputId}
                className="text-xs font-medium text-txt"
              >
                Type {CONNECTOR_OWNER_ROLE_CONFIRMATION} to confirm
              </label>
              <Input
                id={confirmInputId}
                value={typedValue}
                onChange={(event) => setTypedValue(event.target.value)}
                disabled={confirmBusy}
                className="h-9 text-sm"
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
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={!confirmEnabled || confirmBusy}
              onClick={() => void handleConfirm()}
            >
              {confirmBusy ? (
                <span className="h-3 w-3 animate-spin rounded-full border border-current border-t-transparent" />
              ) : (
                "Confirm"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
