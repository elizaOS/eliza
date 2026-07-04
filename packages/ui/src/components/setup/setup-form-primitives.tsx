/**
 * `SetupField` — the labeled form-field wrapper for first-run / setup steps.
 * Wraps the base `Field` primitive with setup-specific label/helper styling and
 * wires up description/message ids so the control (supplied via render-prop) gets
 * the right `aria-describedby` and invalid state. Danger messages are announced
 * assertively.
 */
import type * as React from "react";
import { cn } from "../../lib/utils";
import { Field, FieldDescription, FieldLabel, FieldMessage } from "../ui/field";
import {
  setupFieldLabelClassName,
  setupHelperTextClassName,
} from "./setup-classes";

interface SetupFieldProps {
  align?: "left" | "center";
  children: (controlProps: {
    describedBy?: string;
    invalid: boolean;
  }) => React.ReactNode;
  className?: string;
  controlId?: string;
  description?: React.ReactNode;
  descriptionClassName?: string;
  label?: React.ReactNode;
  labelClassName?: string;
  message?: React.ReactNode;
  messageClassName?: string;
  messageTone?: "default" | "danger" | "success";
}

export function SetupField({
  align = "left",
  children,
  className,
  controlId,
  description,
  descriptionClassName,
  label,
  labelClassName,
  message,
  messageClassName,
  messageTone = "default",
}: SetupFieldProps) {
  const descriptionId =
    controlId && description ? `${controlId}-description` : undefined;
  const messageId = controlId && message ? `${controlId}-message` : undefined;
  const describedBy =
    [descriptionId, messageId].filter(Boolean).join(" ") || undefined;
  const isInvalid = Boolean(message) && messageTone === "danger";

  return (
    <Field
      className={cn(
        "w-full gap-2.5",
        align === "center" ? "items-center text-center" : "text-left",
        className,
      )}
    >
      {label ? (
        <FieldLabel
          htmlFor={controlId}
          className={cn(
            setupFieldLabelClassName,
            align === "center" && "text-center",
            labelClassName,
          )}
        >
          {label}
        </FieldLabel>
      ) : null}
      {children({ describedBy, invalid: isInvalid })}
      {description ? (
        <FieldDescription
          id={descriptionId}
          className={cn(
            setupHelperTextClassName,
            align === "center" && "text-center",
            descriptionClassName,
          )}
        >
          {description}
        </FieldDescription>
      ) : null}
      {message ? (
        <FieldMessage
          id={messageId}
          tone={messageTone}
          aria-live={messageTone === "danger" ? "assertive" : "polite"}
          className={cn(
            "leading-relaxed",
            align === "center" && "text-center",
            messageClassName,
          )}
        >
          {message}
        </FieldMessage>
      ) : null}
    </Field>
  );
}
