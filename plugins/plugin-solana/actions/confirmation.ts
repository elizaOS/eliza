import type { ActionResult, HandlerCallback } from "@elizaos/core";

type ConfirmationValue =
  | string
  | number
  | boolean
  | null
  | ConfirmationValue[]
  | { [key: string]: ConfirmationValue };

export function isConfirmed(options?: Record<string, unknown>): boolean {
  return options?.confirmed === true;
}

function toConfirmationValue(value: unknown): ConfirmationValue {
  if (value === undefined) {
    return null;
  }
  if (value === null) {
    return null;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (Array.isArray(value)) {
    return value.map((item) => toConfirmationValue(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, toConfirmationValue(item)])
    ) as Record<string, ConfirmationValue>;
  }
  return String(value);
}

function toConfirmationRecord(record: object): Record<string, ConfirmationValue> {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, toConfirmationValue(value)])
  ) as Record<string, ConfirmationValue>;
}

export async function confirmationRequired(params: {
  actionName: string;
  preview: string;
  parameters: object;
  callback?: HandlerCallback;
}): Promise<ActionResult> {
  const confirmation = {
    actionName: params.actionName,
    confirmed: false,
    parameters: {
      ...toConfirmationRecord(params.parameters),
      confirmed: true,
    },
  };

  const content = {
    success: false,
    requiresConfirmation: true,
    preview: params.preview,
    confirmation,
  };

  await params.callback?.({
    text: params.preview,
    content,
  });

  return {
    success: false,
    text: params.preview,
    data: content,
  };
}
