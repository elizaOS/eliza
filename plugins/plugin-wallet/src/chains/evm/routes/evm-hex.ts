/**
 * dApps send hex with a `0X` prefix. viem accepts only a lowercase `0x` prefix.
 * `0X4869` is the bytes for "Hi", not the text "0X4869".
 */

export function evmPersonalSignInput(
  message: string,
): { raw: `0x${string}` } | string {
  const trimmed = message.trim();
  if (!/^0x/i.test(trimmed)) return message;
  const hex = `0x${trimmed.slice(2)}` as `0x${string}`;
  if (!/^0x[0-9a-fA-F]*$/.test(hex)) return message;
  return { raw: hex };
}

/** Keep a 0x prefix and rewrite a 0X prefix. Bare hex gains a 0x prefix. */
export function prefixEvmHex(value: string): string {
  if (/^0x/i.test(value)) return `0x${value.slice(2)}`;
  return `0x${value}`;
}

export function normalizeEvmCalldata(
  data: string | undefined,
): `0x${string}` | undefined {
  if (typeof data !== "string") return undefined;
  if (/^0X[0-9a-fA-F]*$/.test(data)) return `0x${data.slice(2)}`;
  return data as `0x${string}`;
}

/** Decimal or 0x/0X hex chain id. Null when the value is not a chain id. */
export function parseEvmChainId(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return value;
  }
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (/^0x[0-9a-fA-F]+$/i.test(raw)) {
    const parsed = Number.parseInt(raw.slice(2), 16);
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
    return null;
  }
  if (/^[1-9]\d*$/.test(raw)) {
    const parsed = Number(raw);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return null;
}
