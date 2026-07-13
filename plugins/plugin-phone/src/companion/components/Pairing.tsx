/** Scan or paste the native iOS Phone Companion pairing payload. */
import {
  CapacitorBarcodeScanner,
  CapacitorBarcodeScannerTypeHint,
} from "@capacitor/barcode-scanner";
import { Capacitor } from "@capacitor/core";
import { Button } from "@elizaos/ui/components/ui/button";
import { Input } from "@elizaos/ui/components/ui/input";
import type React from "react";
import { useCallback, useState } from "react";
import {
  decodePairingPayload,
  ElizaIntent,
  logger,
  type PairingPayload,
} from "../services";

interface PairingViewProps {
  onPaired(payload: PairingPayload): void;
  onBack(): void;
}

interface PairingControlsProps {
  onPaired(payload: PairingPayload): void;
  /** Settings owns the page header and supporting copy in this form. */
  compact?: boolean;
}

type Status =
  | { kind: "idle" }
  | { kind: "scanning" }
  | { kind: "error"; message: string };

/** The native bridge that persists Phone Companion pairing only exists on iOS. */
export function isNativeIosPhonePairing(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === "ios";
}

/** Shared pairing controls used by the legacy companion route and Settings. */
export function PairingControls({
  onPaired,
  compact = false,
}: PairingControlsProps): React.JSX.Element {
  const [code, setCode] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  const completePairing = useCallback(
    async (payload: PairingPayload) => {
      await ElizaIntent.setPairingStatus({
        deviceId: payload.agentId,
        agentUrl: payload.ingressUrl,
      });
      onPaired(payload);
    },
    [onPaired],
  );

  const scan = useCallback(async () => {
    if (!isNativeIosPhonePairing()) return;
    setStatus({ kind: "scanning" });
    try {
      const result = await CapacitorBarcodeScanner.scanBarcode({
        hint: CapacitorBarcodeScannerTypeHint.QR_CODE,
        scanInstructions: "Point the camera at the code on your computer",
      });
      const payload = decodePairingPayload(result.ScanResult);
      await completePairing(payload);
      setStatus({ kind: "idle" });
    } catch (error) {
      logger.warn("[Pairing] scan or decode failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      setStatus({
        kind: "error",
        message:
          error instanceof Error && error.message.length > 0
            ? error.message
            : "Could not read that pairing code.",
      });
    }
  }, [completePairing]);

  const submitManual = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!isNativeIosPhonePairing()) return;
      const trimmed = code.trim();
      if (!trimmed) {
        setStatus({ kind: "error", message: "Paste a pairing code first." });
        return;
      }
      try {
        const payload = decodePairingPayload(trimmed);
        await completePairing(payload);
        setCode("");
        setStatus({ kind: "idle" });
      } catch (error) {
        logger.warn("[Pairing] manual payload failed", {
          message: error instanceof Error ? error.message : String(error),
        });
        setStatus({
          kind: "error",
          message:
            error instanceof Error && error.message.length > 0
              ? error.message
              : "Could not read that pairing code.",
        });
      }
    },
    [code, completePairing],
  );

  if (!isNativeIosPhonePairing()) {
    return (
      <p className="text-sm text-muted" data-testid="phone-pairing-unavailable">
        Phone pairing is available in the Eliza iOS app.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3" data-testid="phone-pairing-controls">
      {!compact ? (
        <p className="text-sm text-muted">
          Scan the code on your computer or paste it below.
        </p>
      ) : null}
      <Button
        type="button"
        variant="surface"
        onClick={scan}
        disabled={status.kind === "scanning"}
      >
        {status.kind === "scanning" ? "Scanning…" : "Scan code"}
      </Button>
      <form onSubmit={submitManual} className="flex flex-col gap-2 sm:flex-row">
        <label htmlFor="phone-pairing-code" className="sr-only">
          Pairing code
        </label>
        <Input
          id="phone-pairing-code"
          value={code}
          onChange={(event) => setCode(event.target.value)}
          inputMode="text"
          autoComplete="off"
          placeholder="Paste pairing code"
          className="min-w-0 flex-1 font-mono"
        />
        <Button type="submit" variant="surfaceAccent">
          Pair
        </Button>
      </form>
      {status.kind === "error" ? (
        <p role="alert" className="text-sm text-danger">
          {status.message}
        </p>
      ) : null}
    </div>
  );
}

/** Compatibility shell retained for the legacy `/phone-companion` route. */
export function Pairing({
  onPaired,
  onBack,
}: PairingViewProps): React.JSX.Element {
  return (
    <main className="flex h-full flex-col gap-5 p-5">
      <header className="flex flex-col gap-3">
        <Button
          type="button"
          variant="ghost"
          onClick={onBack}
          className="self-start"
        >
          Back
        </Button>
        <h1 className="text-2xl font-semibold">Pair with Eliza</h1>
      </header>
      <PairingControls onPaired={onPaired} />
    </main>
  );
}
