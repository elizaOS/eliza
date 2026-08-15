/** Lets signed-in Eliza Cloud users request a realtime call to their verified phone. */

import { Loader2, PhoneCall } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ApiError, api } from "../../../cloud/lib/api-client";
import { ELIZA_CLOUD_CONTROL_PLANE_HOSTS } from "../../../utils/cloud-agent-base";
import { Button } from "../../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../ui/dialog";
import { Input } from "../../ui/input";
import { Label } from "../../ui/label";

interface CurrentUserResponse {
  phone_number?: string | null;
  phone_verified?: boolean | null;
}

interface StartCallResponse {
  success: boolean;
  status: string;
  to: string;
}

function apiErrorMessage(error: unknown): string {
  if (
    error instanceof ApiError &&
    error.body &&
    typeof error.body === "object"
  ) {
    const message = (error.body as { error?: unknown }).error;
    if (typeof message === "string" && message) return message;
  }
  return error instanceof Error ? error.message : "Unable to start the call";
}

function isCallMeAvailable(): boolean {
  if (typeof window === "undefined") return false;
  return (
    ELIZA_CLOUD_CONTROL_PLANE_HOSTS.has(
      window.location.hostname.toLowerCase(),
    ) || window.location.hostname === "localhost"
  );
}

export function PstnCallButton({ disabled = false }: { disabled?: boolean }) {
  const [available, setAvailable] = useState(false);
  const [open, setOpen] = useState(false);
  const [loadingProfile, setLoadingProfile] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [phoneNumber, setPhoneNumber] = useState("");
  const [phoneVerified, setPhoneVerified] = useState(false);

  useEffect(() => setAvailable(isCallMeAvailable()), []);

  const handleOpenChange = async (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) return;
    setPhoneNumber("");
    setPhoneVerified(false);
    setLoadingProfile(true);
    try {
      const user = await api<CurrentUserResponse>("/api/v1/user");
      setPhoneNumber(user.phone_number ?? "");
      setPhoneVerified(user.phone_verified === true);
    } catch (error) {
      toast.error(apiErrorMessage(error));
    } finally {
      setLoadingProfile(false);
    }
  };

  const handleCall = async () => {
    if (submitting || !phoneVerified || !phoneNumber.trim()) return;
    setSubmitting(true);
    try {
      const result = await api<StartCallResponse>(
        "/api/v1/twilio/voice/calls",
        {
          method: "POST",
          headers: { "Idempotency-Key": crypto.randomUUID() },
          json: { to: phoneNumber.trim() },
        },
      );
      toast.success(`Eliza is calling ${result.to}`);
      setOpen(false);
    } catch (error) {
      toast.error(apiErrorMessage(error));
    } finally {
      setSubmitting(false);
    }
  };

  if (!available) return null;

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="h-[38px] w-9 shrink-0 border-0 bg-transparent p-0 text-muted shadow-none hover:bg-transparent hover:text-txt pointer-coarse:min-h-touch pointer-coarse:min-w-touch"
        onClick={() => void handleOpenChange(true)}
        disabled={disabled}
        title="Have Eliza call me"
        aria-label="Have Eliza call me"
        data-testid="chat-composer-phone-call"
      >
        <PhoneCall className="h-5 w-5" />
      </Button>
      <Dialog open={open} onOpenChange={(next) => void handleOpenChange(next)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Call me</DialogTitle>
            <DialogDescription>
              Eliza will call your verified account phone.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="eliza-call-me-number">Phone number</Label>
            <Input
              id="eliza-call-me-number"
              inputMode="tel"
              autoComplete="tel"
              placeholder="+1 415 555 0100"
              value={phoneNumber}
              readOnly
              disabled={loadingProfile || submitting}
            />
            {!loadingProfile && !phoneVerified ? (
              <p className="text-sm text-danger">
                Add and verify this phone number in account settings before
                requesting a call.
              </p>
            ) : (
              <p className="text-sm text-muted">
                For your security, the number must match your verified account
                phone.
              </p>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setOpen(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button
              onClick={() => void handleCall()}
              disabled={
                loadingProfile ||
                submitting ||
                !phoneVerified ||
                !phoneNumber.trim()
              }
            >
              {submitting ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : null}
              Call me
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
