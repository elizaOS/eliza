"use client";

import { CardElement } from "@stripe/react-stripe-js";
import type { StripeCardElementChangeEvent } from "@stripe/stripe-js";
import { Label } from "../primitives";

interface StripeCardElementProps {
  onReady?: () => void;
  onChange?: (complete: boolean, error?: string) => void;
}

export function StripeCardElement({ onReady, onChange }: StripeCardElementProps) {
  const cardElementOptions = {
    style: {
      base: {
        fontSize: "16px",
        color: "#e1e1e1",
        fontFamily: "monospace",
        "::placeholder": {
          color: "#717171",
        },
        backgroundColor: "rgba(29,29,29,0.3)",
      },
      invalid: {
        color: "#dc2626",
        iconColor: "#dc2626",
      },
    },
    hidePostalCode: false,
  };

  return (
    <div className="flex flex-col gap-2 w-full">
      <Label className="text-base font-mono font-medium text-[#e1e1e1]">Card details</Label>
      <div className="backdrop-blur-sm bg-[rgba(29,29,29,0.3)] border border-[rgba(255,255,255,0.15)] p-3">
        <CardElement
          options={cardElementOptions}
          onReady={onReady}
          onChange={(event: StripeCardElementChangeEvent) => {
            if (onChange) {
              onChange(event.complete, event.error?.message);
            }
          }}
        />
      </div>
    </div>
  );
}
