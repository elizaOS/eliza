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
  callSid: string;
  status: string;
  to: string;
}

interface CallStatusResponse extends StartCallResponse {
  answeredAt: string | null;
  terminalAt: string | null;
  hangupRequestedAt: string | null;
}

interface ActiveCall {
  callSid: string;
  status: string;
  to: string;
  hangupIdempotencyKey: string;
}

const TERMINAL_CALL_STATUSES = new Set([
  "completed",
  "busy",
  "failed",
  "no-answer",
  "canceled",
  "provider-error",
]);

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
  const [hangingUp, setHangingUp] = useState(false);
  const [phoneNumber, setPhoneNumber] = useState("");
  const [phoneVerified, setPhoneVerified] = useState(false);
  const [callIdempotencyKey, setCallIdempotencyKey] = useState("");
  const [activeCall, setActiveCall] = useState<ActiveCall | null>(null);
  const [statusError, setStatusError] = useState("");

  useEffect(() => setAvailable(isCallMeAvailable()), []);

  useEffect(() => {
    if (!activeCall || TERMINAL_CALL_STATUSES.has(activeCall.status)) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const result = await api<CallStatusResponse>(
          `/api/v1/twilio/voice/calls/${encodeURIComponent(activeCall.callSid)}`,
        );
        if (cancelled) return;
        setStatusError("");
        setActiveCall((current) =>
          current?.callSid === result.callSid
            ? { ...current, status: result.status, to: result.to }
            : current,
        );
      } catch (error) {
        // error-policy:J4 status polling failure is shown in the active-call
        // dialog while the explicit hangup control remains available.
        if (!cancelled) setStatusError(apiErrorMessage(error));
      }
    };
    const interval = window.setInterval(() => void refresh(), 2_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [activeCall]);

  const handleOpenChange = async (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) return;
    if (activeCall) return;
    setPhoneNumber("");
    setPhoneVerified(false);
    setCallIdempotencyKey(crypto.randomUUID());
    setStatusError("");
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
    if (
      submitting ||
      !phoneVerified ||
      !phoneNumber.trim() ||
      !callIdempotencyKey
    )
      return;
    setSubmitting(true);
    try {
      const result = await api<StartCallResponse>(
        "/api/v1/twilio/voice/calls",
        {
          method: "POST",
          headers: { "Idempotency-Key": callIdempotencyKey },
          json: { to: phoneNumber.trim() },
        },
      );
      toast.success(`Eliza is calling ${result.to}`);
      setActiveCall({
        callSid: result.callSid,
        status: result.status,
        to: result.to,
        hangupIdempotencyKey: crypto.randomUUID(),
      });
    } catch (error) {
      toast.error(apiErrorMessage(error));
    } finally {
      setSubmitting(false);
    }
  };

  const handleHangup = async () => {
    if (!activeCall || hangingUp) return;
    setHangingUp(true);
    try {
      const result = await api<CallStatusResponse>(
        `/api/v1/twilio/voice/calls/${encodeURIComponent(activeCall.callSid)}`,
        {
          method: "DELETE",
          headers: { "Idempotency-Key": activeCall.hangupIdempotencyKey },
        },
      );
      setActiveCall((current) =>
        current ? { ...current, status: result.status } : current,
      );
      toast.success("Hangup requested");
    } catch (error) {
      toast.error(apiErrorMessage(error));
    } finally {
      setHangingUp(false);
    }
  };

  const handleNewCall = () => {
    setActiveCall(null);
    setCallIdempotencyKey(crypto.randomUUID());
    setStatusError("");
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
              Eliza will call your verified account phone. When you answer,
              Eliza identifies itself as an AI assistant using an AI-generated
              voice.
            </DialogDescription>
          </DialogHeader>
          {activeCall ? (
            <>
              <div className="space-y-2" aria-live="polite">
                <p className="text-sm">Calling {activeCall.to}</p>
                <p className="text-sm text-muted">
                  Status: {activeCall.status}
                </p>
                {statusError ? (
                  <p className="text-sm text-danger">
                    Status unavailable: {statusError}
                  </p>
                ) : null}
              </div>
              <DialogFooter>
                {TERMINAL_CALL_STATUSES.has(activeCall.status) ? (
                  <Button onClick={handleNewCall}>Call again</Button>
                ) : (
                  <Button
                    variant="destructive"
                    onClick={() => void handleHangup()}
                    disabled={hangingUp}
                  >
                    {hangingUp ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : null}
                    Hang up
                  </Button>
                )}
                <Button variant="ghost" onClick={() => setOpen(false)}>
                  Close
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
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
                    For your security, the number must match your verified
                    account phone.
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
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
