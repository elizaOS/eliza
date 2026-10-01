/**
 * Decodes the dstack guest-v1 `Attest` payload: a MessagePack map produced by
 * `rmp_serde::to_vec_named` of `dstack-attest` `v1::Attestation`
 * (`{ version: 1, platform: { kind, data }, stack: { kind, data } }`). Only the
 * fields the agent binds are extracted: the raw TDX quote and the stack's
 * 64-byte report data. The legacy SCALE form (first byte 0x00) is never
 * produced by guest-v1 `Attest` and is rejected rather than guessed at.
 */
import { ElizaError } from "@elizaos/core";

const MAX_DEPTH = 32;

type MsgpackValue =
  | null
  | boolean
  | number
  | bigint
  | string
  | Uint8Array
  | MsgpackValue[]
  | { [key: string]: MsgpackValue };

function rejected(message: string): ElizaError {
  return new ElizaError(message, { code: "TEE_DSTACK_ATTESTATION_MALFORMED" });
}

class Reader {
  offset = 0;
  constructor(private readonly bytes: Buffer) {}
  private need(length: number): number {
    const start = this.offset;
    if (length < 0 || start + length > this.bytes.length)
      throw rejected("Attestation MessagePack is truncated");
    this.offset += length;
    return start;
  }
  u8(): number {
    return this.bytes.readUInt8(this.need(1));
  }
  u16(): number {
    return this.bytes.readUInt16BE(this.need(2));
  }
  u32(): number {
    return this.bytes.readUInt32BE(this.need(4));
  }
  u64(): bigint {
    return this.bytes.readBigUInt64BE(this.need(8));
  }
  take(length: number): Buffer {
    const start = this.need(length);
    return this.bytes.subarray(start, start + length);
  }
  /** Each element occupies at least one byte, bounding declared counts. */
  count(length: number): number {
    if (length > this.bytes.length - this.offset)
      throw rejected("Attestation MessagePack declares too many elements");
    return length;
  }
  value(depth: number): MsgpackValue {
    if (depth > MAX_DEPTH)
      throw rejected("Attestation MessagePack is too deep");
    const tag = this.u8();
    if (tag <= 0x7f) return tag;
    if (tag >= 0xe0) return tag - 0x100;
    if (tag >= 0x80 && tag <= 0x8f) return this.map(tag & 0x0f, depth);
    if (tag >= 0x90 && tag <= 0x9f) return this.array(tag & 0x0f, depth);
    if (tag >= 0xa0 && tag <= 0xbf) return this.string(tag & 0x1f);
    switch (tag) {
      case 0xc0:
        return null;
      case 0xc2:
        return false;
      case 0xc3:
        return true;
      case 0xc4:
        return new Uint8Array(this.take(this.u8()));
      case 0xc5:
        return new Uint8Array(this.take(this.u16()));
      case 0xc6:
        return new Uint8Array(this.take(this.u32()));
      case 0xcc:
        return this.u8();
      case 0xcd:
        return this.u16();
      case 0xce:
        return this.u32();
      case 0xcf: {
        const value = this.u64();
        return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
      }
      case 0xd0:
        return this.take(1).readInt8(0);
      case 0xd1:
        return this.take(2).readInt16BE(0);
      case 0xd2:
        return this.take(4).readInt32BE(0);
      case 0xd3: {
        const value = this.take(8).readBigInt64BE(0);
        return value >= BigInt(Number.MIN_SAFE_INTEGER) &&
          value <= BigInt(Number.MAX_SAFE_INTEGER)
          ? Number(value)
          : value;
      }
      case 0xd9:
        return this.string(this.u8());
      case 0xda:
        return this.string(this.u16());
      case 0xdb:
        return this.string(this.u32());
      case 0xdc:
        return this.array(this.u16(), depth);
      case 0xdd:
        return this.array(this.u32(), depth);
      case 0xde:
        return this.map(this.u16(), depth);
      case 0xdf:
        return this.map(this.u32(), depth);
      default:
        // Floats and extension types never occur in the attestation schema.
        throw rejected(`Unsupported MessagePack type 0x${tag.toString(16)}`);
    }
  }
  private string(length: number): string {
    return new TextDecoder("utf-8", { fatal: true }).decode(this.take(length));
  }
  private array(length: number, depth: number): MsgpackValue[] {
    const items: MsgpackValue[] = [];
    for (let index = this.count(length); index > 0; index -= 1)
      items.push(this.value(depth + 1));
    return items;
  }
  private map(length: number, depth: number): { [key: string]: MsgpackValue } {
    const entries: { [key: string]: MsgpackValue } = Object.create(null);
    for (let index = this.count(length); index > 0; index -= 1) {
      const key = this.value(depth + 1);
      if (typeof key !== "string")
        throw rejected("Attestation MessagePack map keys must be strings");
      if (Object.hasOwn(entries, key))
        throw rejected("Attestation MessagePack repeats a map key");
      entries[key] = this.value(depth + 1);
    }
    return entries;
  }
}

function record(
  value: MsgpackValue | undefined,
  name: string,
): { [key: string]: MsgpackValue } {
  if (
    value === null ||
    value === undefined ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value instanceof Uint8Array
  )
    throw rejected(`Attestation field ${name} must be a map`);
  return value;
}

/** serde `Vec<u8>` arrives as a MessagePack array of u8, or as bin. */
function bytes(value: MsgpackValue | undefined, name: string): Buffer {
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (!Array.isArray(value))
    throw rejected(`Attestation field ${name} must be bytes`);
  const out = Buffer.alloc(value.length);
  value.forEach((item, index) => {
    if (
      typeof item !== "number" ||
      !Number.isInteger(item) ||
      item < 0 ||
      item > 255
    )
      throw rejected(`Attestation field ${name} must be bytes`);
    out[index] = item;
  });
  return out;
}

function tagged(value: MsgpackValue | undefined, name: string) {
  const entry = record(value, name);
  const kind = entry.kind;
  if (typeof kind !== "string")
    throw rejected(`Attestation field ${name}.kind must be a string`);
  return { kind, data: record(entry.data, `${name}.data`) };
}

export type DstackAttestationPlatform =
  | "tdx"
  | "gcp-tdx"
  | "nitro-enclave"
  | "aws-nitro-tpm"
  | "sev-snp";

export type DecodedDstackAttestation = {
  version: 1;
  platform: DstackAttestationPlatform;
  /** Raw Intel TDX quote for `tdx` / `gcp-tdx` platforms. */
  tdxQuote?: Buffer;
  stack: "dstack" | "dstack-pod";
  /** The 64 bytes the guest agent was asked to attest. */
  stackReportData: Buffer;
};

const PLATFORMS = new Set<string>([
  "tdx",
  "gcp-tdx",
  "nitro-enclave",
  "aws-nitro-tpm",
  "sev-snp",
]);

/** Decode a hex guest-v1 `AttestResponse.attestation`. */
export function decodeDstackAttestation(
  attestationHex: string,
): DecodedDstackAttestation {
  if (!/^(?:[0-9a-f]{2})+$/i.test(attestationHex))
    throw rejected("Attestation must be hex encoded");
  const raw = Buffer.from(attestationHex, "hex");
  const first = raw[0] ?? 0;
  if (first === 0x00)
    throw rejected("Legacy SCALE attestations are not accepted from guest-v1");
  if (!((first >= 0x80 && first <= 0x8f) || first === 0xde || first === 0xdf))
    throw rejected("Attestation is not a MessagePack V1 map");
  const reader = new Reader(raw);
  const root = record(reader.value(0), "attestation");
  if (reader.offset !== raw.length)
    throw rejected("Attestation has trailing bytes");
  if (root.version !== 1) throw rejected("Unsupported attestation version");
  const platform = tagged(root.platform, "platform");
  if (!PLATFORMS.has(platform.kind))
    throw rejected("Unknown attestation platform");
  const stack = tagged(root.stack, "stack");
  if (stack.kind !== "dstack" && stack.kind !== "dstack-pod")
    throw rejected("Unknown attestation stack");
  const stackReportData = bytes(stack.data.report_data, "stack.report_data");
  if (stackReportData.length !== 64)
    throw rejected("Attestation stack report data must be 64 bytes");
  const hasQuote = platform.kind === "tdx" || platform.kind === "gcp-tdx";
  return {
    version: 1,
    platform: platform.kind as DstackAttestationPlatform,
    ...(hasQuote
      ? { tdxQuote: bytes(platform.data.quote, "platform.quote") }
      : {}),
    stack: stack.kind,
    stackReportData,
  };
}
