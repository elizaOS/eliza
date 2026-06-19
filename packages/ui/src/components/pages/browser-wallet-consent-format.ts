/**
 * Wallet consent dialog formatters.
 *
 * Read-only helpers used by `BrowserWorkspaceView`'s wallet host bridge
 * to build the consent modal body. Inputs come straight from the dApp via
 * EIP-1193 — these helpers just format for display, never interpret or
 * mutate. Pulled out of the React component file so they're unit-testable
 * without standing up a renderer.
 */

export function formatAddressForDisplay(address: string): string {
  if (!address) return "(unknown)";
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

const ONE_ETH_WEI = 1_000_000_000_000_000_000n;

export function formatWeiForDisplay(weiDecimalString: string): string {
  if (!weiDecimalString || weiDecimalString === "0") return "0 ETH";
  let wei: bigint;
  try {
    wei = BigInt(weiDecimalString);
  } catch {
    return `${weiDecimalString} wei`;
  }
  const whole = wei / ONE_ETH_WEI;
  const remainder = wei % ONE_ETH_WEI;
  if (remainder === 0n) return `${whole.toString()} ETH`;
  // 6-digit precision is plenty for a confirm dialog; the full hex
  // value goes through unchanged downstream.
  const fractional = (remainder * 1_000_000n) / ONE_ETH_WEI;
  const fractionalStr = fractional
    .toString()
    .padStart(6, "0")
    .replace(/0+$/, "");
  return `${whole.toString()}.${fractionalStr || "0"} ETH`;
}

/**
 * EIP-191 / personal_sign callers pass either a UTF-8 string or a
 * 0x-prefixed hex string of the bytes to sign. Show the decoded UTF-8
 * when possible so the user sees the actual prompt rather than hex.
 */
export function decodeSignableMessage(message: string): string {
  if (!message.startsWith("0x") || message.length < 4) return message;
  const hex = message.slice(2);
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) return message;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return message;
  }
}

export function decodeBase64ForPreview(base64: string): string {
  try {
    const bin = atob(base64);
    return decodeSignableMessage(
      `0x${[...bin].map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("")}`,
    );
  } catch {
    return "(unable to decode message)";
  }
}

export function truncateMessageForDisplay(message: string, max = 240): string {
  if (message.length <= max) return message;
  return `${message.slice(0, max)}… (${message.length - max} more chars)`;
}
