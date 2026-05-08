import {
  Button,
  Checkbox,
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
  Spinner,
} from "@elizaos/ui";
import { useId, useMemo, useState } from "react";
import type { ConnectorAccountPrivacy } from "../../api/client-agent";
import {
  CONNECTOR_ACCOUNT_PRIVACY_OPTIONS,
  CONNECTOR_PRIVACY_PUBLIC_CONFIRMATION,
  CONNECTOR_PRIVACY_TYPED_CONFIRMATION,
  getConnectorPrivacyConfirmationRequirement,
  getConnectorPrivacyOption,
  isConnectorPrivacyConfirmationSatisfied,
} from "./connector-account-options";

export interface ConnectorAccountPrivacySelectorProps {
  value?: ConnectorAccountPrivacy;
  onChange: (value: ConnectorAccountPrivacy) => Promise<void> | void;
  disabled?: boolean;
  id?: string;
  accountLabel?: string;
}

export function ConnectorAccountPrivacySelector({
  value,
  onChange,
  disabled = false,
  id,
  accountLabel,
}: ConnectorAccountPrivacySelectorProps) {
  const resolved = getConnectorPrivacyOption(value).value;
  const [pendingValue, setPendingValue] =
    useState<ConnectorAccountPrivacy | null>(null);
  const [typedValue, setTypedValue] = useState("");
  const [publicAcknowledged, setPublicAcknowledged] = useState(false);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const generatedId = useId();
  const confirmInputId = `${id ?? generatedId}-privacy-confirm`;

  const pendingRequirement = useMemo(
    () =>
      pendingValue
        ? getConnectorPrivacyConfirmationRequirement(resolved, pendingValue)
        : "none",
    [pendingValue, resolved],
  );
  const pendingOption = pendingValue
    ? getConnectorPrivacyOption(pendingValue)
    : null;
  const expectedPhrase =
    pendingRequirement === "public"
      ? CONNECTOR_PRIVACY_PUBLIC_CONFIRMATION
      : CONNECTOR_PRIVACY_TYPED_CONFIRMATION;
  const confirmEnabled = isConnectorPrivacyConfirmationSatisfied(
    pendingRequirement,
    typedValue,
    publicAcknowledged,
  );

  const closeDialog = () => {
    if (confirmBusy) return;
    setPendingValue(null);
    setTypedValue("");
    setPublicAcknowledged(false);
  };

  const handleValueChange = (next: string) => {
    const privacy = next as ConnectorAccountPrivacy;
    const requirement = getConnectorPrivacyConfirmationRequirement(
      resolved,
      privacy,
    );
    if (requirement === "none") {
      void onChange(privacy);
      return;
    }
    setTypedValue("");
    setPublicAcknowledged(false);
    setPendingValue(privacy);
  };

  const handleConfirm = async () => {
    if (!pendingValue || !confirmEnabled) return;
    setConfirmBusy(true);
    try {
      await onChange(pendingValue);
      setPendingValue(null);
      setTypedValue("");
      setPublicAcknowledged(false);
    } finally {
      setConfirmBusy(false);
    }
  };

  return (
    <>
      <div className="flex min-w-[210px] items-center gap-2">
        <span className="shrink-0 text-[10px] font-medium uppercase tracking-wider text-muted">
          Privacy
        </span>
        <Select
          value={resolved}
          disabled={disabled}
          onValueChange={handleValueChange}
        >
          <SelectTrigger
            id={id}
            className="h-8 w-[150px] rounded-lg border border-border bg-card text-xs"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CONNECTOR_ACCOUNT_PRIVACY_OPTIONS.map((option) => (
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
              {pendingRequirement === "public"
                ? "Make connector account public?"
                : "Share connector account access?"}
            </DialogTitle>
            <DialogDescription>
              {pendingRequirement === "public"
                ? "Public visibility can expose this account identity outside the owner and team."
                : "This changes the account from owner-only visibility to a shared visibility level."}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="rounded-lg border border-border/50 bg-bg-accent/40 px-3 py-2 text-xs text-muted">
              <span className="font-medium text-txt">
                {accountLabel ?? "Connector account"}
              </span>{" "}
              will be set to{" "}
              <span className="font-medium text-txt">
                {pendingOption?.label ?? pendingValue}
              </span>
              .
            </div>
            <div className="space-y-1.5">
              <label
                htmlFor={confirmInputId}
                className="text-xs font-medium text-txt"
              >
                Type {expectedPhrase} to confirm
              </label>
              <Input
                id={confirmInputId}
                value={typedValue}
                onChange={(event) => setTypedValue(event.target.value)}
                disabled={confirmBusy}
                className="h-9 text-sm"
              />
            </div>
            {pendingRequirement === "public" ? (
              <div className="flex items-start gap-2 text-xs text-muted">
                <Checkbox
                  checked={publicAcknowledged}
                  disabled={confirmBusy}
                  onCheckedChange={(checked) =>
                    setPublicAcknowledged(checked === true)
                  }
                  aria-label="Confirm public connector account visibility"
                />
                <span>
                  I understand this may reveal connector identity and account
                  presence publicly.
                </span>
              </div>
            ) : null}
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
              variant={
                pendingRequirement === "public" ? "destructive" : "default"
              }
              disabled={!confirmEnabled || confirmBusy}
              onClick={() => void handleConfirm()}
            >
              {confirmBusy ? <Spinner className="h-3 w-3" /> : "Confirm"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
