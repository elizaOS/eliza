import {
  CapacitorBarcodeScanner,
  CapacitorBarcodeScannerTypeHint,
} from "@capacitor/barcode-scanner";
import { Capacitor } from "@capacitor/core";
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

type Status =
  | { kind: "idle" }
  | { kind: "scanning" }
  | { kind: "error"; message: string };

export function Pairing({
  onPaired,
  onBack,
}: PairingViewProps): React.JSX.Element {
  const [code, setCode] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  const scan = useCallback(async () => {
    if (!Capacitor.isNativePlatform()) {
      setStatus({
        kind: "error",
        message:
          "Camera scan requires the iOS native runtime. Paste the code below.",
      });
      return;
    }
    setStatus({ kind: "scanning" });
    try {
      logger.info("[Pairing] scanBarcode start", {});
      const result = await CapacitorBarcodeScanner.scanBarcode({
        hint: CapacitorBarcodeScannerTypeHint.QR_CODE,
        scanInstructions: "Point the camera at the code on your Mac",
      });
      const payload = decodePairingPayload(result.ScanResult);
      logger.info("[Pairing] pairing payload decoded", {
        agentId: payload.agentId,
      });
      onPaired(payload);
      setStatus({ kind: "idle" });
    } catch (err) {
      logger.warn("[Pairing] scan or decode failed", {
        message: err instanceof Error ? err.message : String(err),
      });
      setStatus({
        kind: "error",
        message:
          err instanceof Error && err.message.length > 0
            ? err.message
            : "Could not read the QR code. Try again or enter the code below.",
      });
    }
  }, [onPaired]);

  const submitManual = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const trimmed = code.trim();
      if (trimmed.length === 0) {
        setStatus({
          kind: "error",
          message: "Paste the pairing payload shown on your Mac.",
        });
        return;
      }
      logger.info("[Pairing] manual payload submit", {
        length: trimmed.length,
      });
      try {
        const payload = decodePairingPayload(trimmed);
        await ElizaIntent.setPairingStatus({
          deviceId: payload.agentId,
          agentUrl: payload.ingressUrl,
        });
        onPaired(payload);
        setStatus({ kind: "idle" });
      } catch (err) {
        logger.warn("[Pairing] manual payload decode failed", {
          message: err instanceof Error ? err.message : String(err),
        });
        setStatus({
          kind: "error",
          message:
            err instanceof Error && err.message.length > 0
              ? err.message
              : "Could not read the pairing payload. Scan the QR code or paste the full payload.",
        });
      }
    },
    [code, onPaired],
  );

  return (
    <main style={styles.root}>
      <header style={styles.header}>
        <button type="button" onClick={onBack} style={styles.back}>
          Back
        </button>
        <h1 style={styles.title}>Pair with Eliza</h1>
      </header>

      <section style={styles.section}>
        <p style={styles.hint}>
          Scan the QR code shown in the Eliza desktop app, or paste its pairing
          payload manually.
        </p>
        <button
          type="button"
          onClick={scan}
          disabled={status.kind === "scanning"}
          style={styles.primary}
        >
          {status.kind === "scanning" ? "Scanning..." : "Scan QR code"}
        </button>
      </section>

      <section style={styles.section}>
        <form onSubmit={submitManual} style={styles.form}>
          <label htmlFor="pairing-code" style={styles.label}>
            Or paste payload
          </label>
          <input
            id="pairing-code"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            inputMode="text"
            autoComplete="off"
            placeholder="base64 pairing payload"
            style={styles.input}
          />
          <button type="submit" style={styles.secondary}>
            Pair device
          </button>
        </form>
      </section>

      {status.kind === "error" ? (
        <p style={styles.error}>{status.message}</p>
      ) : null}
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    padding: 20,
    gap: 24,
  },
  header: { display: "flex", flexDirection: "column", gap: 12 },
  back: {
    alignSelf: "flex-start",
    background: "transparent",
    border: "none",
    color: "#93c5fd",
    fontSize: 16,
    padding: 0,
  },
  title: { margin: 0, fontSize: 28, fontWeight: 600 },
  section: { display: "flex", flexDirection: "column", gap: 12 },
  hint: { margin: 0, opacity: 0.7 },
  primary: {
    padding: "14px 16px",
    background: "#4f46e5",
    color: "#fff",
    border: "none",
    borderRadius: 12,
    fontSize: 16,
    fontWeight: 600,
  },
  secondary: {
    padding: "12px 16px",
    background: "#1f2937",
    color: "#e5e7eb",
    border: "1px solid #374151",
    borderRadius: 12,
    fontSize: 16,
  },
  form: { display: "flex", flexDirection: "column", gap: 8 },
  label: { fontSize: 12, opacity: 0.7, textTransform: "uppercase" },
  input: {
    fontSize: 24,
    letterSpacing: "0.4em",
    textAlign: "center",
    padding: "12px 16px",
    background: "#111",
    border: "1px solid #333",
    borderRadius: 12,
    color: "#e5e7eb",
  },
  error: { color: "#fbbf24", margin: 0 },
};
