import { createHash } from "node:crypto";

export function hexToUint8Array(hex: string): Uint8Array {
  const hexString = hex.trim().replace(/^0x/, "");
  if (!hexString) {
    throw new Error("Invalid hex string: empty after stripping prefix");
  }
  if (hexString.length % 2 !== 0) {
    throw new Error("Invalid hex string: odd number of characters");
  }

  const array = new Uint8Array(hexString.length / 2);
  for (let i = 0; i < hexString.length; i += 2) {
    const byte = Number.parseInt(hexString.slice(i, i + 2), 16);
    if (Number.isNaN(byte)) {
      throw new Error(`Invalid hex string: invalid byte at position ${i}`);
    }
    array[i / 2] = byte;
  }
  return array;
}

export function uint8ArrayToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function calculateSHA256(input: string): Buffer {
  const hash = createHash("sha256");
  hash.update(input);
  return hash.digest();
}

export function sha256Bytes(input: Uint8Array): Uint8Array {
  const hash = createHash("sha256");
  hash.update(input);
  return new Uint8Array(hash.digest());
}

export function getTeeEndpoint(mode: string): string | undefined {
  switch (mode.toUpperCase()) {
    case "LOCAL":
      return "http://localhost:8090";
    case "DOCKER":
      return "http://host.docker.internal:8090";
    case "PRODUCTION":
      return undefined;
    default:
      throw new Error(`Invalid TEE_MODE: ${mode}. Must be one of: LOCAL, DOCKER, PRODUCTION`);
  }
}

export async function uploadAttestationQuote(data: Uint8Array): Promise<{ checksum: string }> {
  const blob = new Blob([data as BlobPart], {
    type: "application/octet-stream",
  });
  const formData = new FormData();
  formData.append("file", blob, "quote.bin");

  const response = await fetch("https://proof.t16z.com/api/upload", {
    method: "POST",
    body: formData as BodyInit,
  });

  if (!response.ok) {
    throw new Error(`Failed to upload attestation quote: ${response.statusText}`);
  }

  return response.json() as Promise<{ checksum: string }>;
}
