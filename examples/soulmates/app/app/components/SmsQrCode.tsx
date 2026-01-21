"use client";

import QRCode from "qrcode";
import { useEffect, useState } from "react";

type QrStatus = "idle" | "loading" | "ready" | "error";

type SmsQrCodeProps = {
  value: string;
  disabledText: string;
};

export default function SmsQrCode({ value, disabledText }: SmsQrCodeProps) {
  const [dataUrl, setDataUrl] = useState("");
  const [status, setStatus] = useState<QrStatus>("idle");

  useEffect(() => {
    if (!value) {
      setStatus("idle");
      setDataUrl("");
      return;
    }

    let cancelled = false;
    setStatus("loading");

    QRCode.toDataURL(value, { margin: 1, width: 220 })
      .then((url) => {
        if (cancelled) return;
        setDataUrl(url);
        setStatus("ready");
      })
      .catch(() => {
        if (cancelled) return;
        setStatus("error");
      });

    return () => {
      cancelled = true;
    };
  }, [value]);

  if (!value) {
    return (
      <div className="text-center text-sm text-[var(--text-muted)]">
        {disabledText}
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="text-center text-sm text-[var(--text-muted)]">
        Unable to generate QR code.
      </div>
    );
  }

  if (status !== "ready") {
    return (
      <div className="text-center text-sm text-[var(--text-muted)]">
        Generating QR code...
      </div>
    );
  }

  return (
    // biome-ignore lint/performance/noImgElement: Data URL QR codes cannot benefit from Next.js Image optimization
    <img
      className="block h-auto w-full max-w-[220px]"
      src={dataUrl}
      alt="QR code linking to the message"
    />
  );
}
