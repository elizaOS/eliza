/**
 * Hardware-free dstack TDX harness. The only doubles are EXTERNAL hardware
 * boundaries: a fake dstack guest agent on a temporary Unix socket (guest-v1
 * `/v1/Attest` MessagePack attestations with synthetic, ECDSA-P256-signed TDX
 * quotes, and `/v1/GetKey` with the real v1 KDF and signature chain) and a stub
 * `dstack-verifier` executable whose bytes and configuration are pinned by
 * SHA-256 exactly as production pins the real verifier. The stub models quote
 * authenticity as "signed by an attestation key in its trusted set".
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  hkdfSync,
  type KeyObject,
  randomBytes,
  sign,
} from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";

// ---------------------------------------------------------------------------
// MessagePack encoding (rmp_serde::to_vec_named shape; Vec<u8> as u8 arrays).
// ---------------------------------------------------------------------------

export type Packable =
  | null
  | boolean
  | number
  | string
  | Buffer
  | { bin: Buffer }
  | Packable[]
  | { [key: string]: Packable };

function header(small: number, fix: number, sizes: number[], length: number) {
  if (length < small) return Buffer.from([fix | length]);
  const [one, two, four] = sizes as [number, number, number];
  if (length < 0x100 && one) return Buffer.from([one, length]);
  if (length < 0x10000) {
    const out = Buffer.alloc(3);
    out[0] = two;
    out.writeUInt16BE(length, 1);
    return out;
  }
  const out = Buffer.alloc(5);
  out[0] = four;
  out.writeUInt32BE(length, 1);
  return out;
}

function packUint(value: number): Buffer {
  if (value < 0x80) return Buffer.from([value]);
  if (value < 0x100) return Buffer.from([0xcc, value]);
  if (value < 0x10000) {
    const out = Buffer.alloc(3);
    out[0] = 0xcd;
    out.writeUInt16BE(value, 1);
    return out;
  }
  const out = Buffer.alloc(5);
  out[0] = 0xce;
  out.writeUInt32BE(value, 1);
  return out;
}

export function packMsgpack(value: Packable): Buffer {
  if (value === null) return Buffer.from([0xc0]);
  if (value === true) return Buffer.from([0xc3]);
  if (value === false) return Buffer.from([0xc2]);
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff)
      throw new Error("harness packs only u32 integers");
    return packUint(value);
  }
  if (typeof value === "string") {
    const bytes = Buffer.from(value, "utf8");
    return Buffer.concat([
      header(32, 0xa0, [0xd9, 0xda, 0xdb], bytes.length),
      bytes,
    ]);
  }
  if (Buffer.isBuffer(value)) return packMsgpack([...value] as Packable[]);
  if (Array.isArray(value))
    return Buffer.concat([
      header(16, 0x90, [0, 0xdc, 0xdd], value.length),
      ...value.map(packMsgpack),
    ]);
  if ("bin" in value && Buffer.isBuffer(value.bin)) {
    return Buffer.concat([
      header(0, 0, [0xc4, 0xc5, 0xc6], value.bin.length),
      value.bin,
    ]);
  }
  const entries = Object.entries(value as { [key: string]: Packable });
  return Buffer.concat([
    header(16, 0x80, [0, 0xde, 0xdf], entries.length),
    ...entries.flatMap(([key, item]) => [packMsgpack(key), packMsgpack(item)]),
  ]);
}

// ---------------------------------------------------------------------------
// Synthetic Intel TDX quotes (v4, or v5 with TD 1.0 / TD 1.5 bodies).
// ---------------------------------------------------------------------------

export type QuoteOptions = {
  reportData: Buffer;
  attestationKey: KeyObject;
  version?: 4 | 5;
  body?: "td10" | "td15";
  debug?: boolean;
  mrTd?: Buffer;
  rtmrs?: [Buffer, Buffer, Buffer, Buffer];
  teeType?: number;
  attestationKeyType?: number;
};

export function rawP256(publicKey: KeyObject): Buffer {
  const jwk = publicKey.export({ format: "jwk" });
  return Buffer.concat([
    Buffer.from(String(jwk.x), "base64url"),
    Buffer.from(String(jwk.y), "base64url"),
  ]);
}

export function fill(byte: number, length = 48): Buffer {
  return Buffer.alloc(length, byte);
}

export const QUOTE_REGISTERS = {
  mrTd: fill(0x11),
  rtmrs: [fill(0x20), fill(0x21), fill(0x22), fill(0x23)] as [
    Buffer,
    Buffer,
    Buffer,
    Buffer,
  ],
};

export function buildTdxQuote(options: QuoteOptions): Buffer {
  const version = options.version ?? 4;
  const kind = options.body ?? "td10";
  const head = Buffer.alloc(48);
  head.writeUInt16LE(version, 0);
  head.writeUInt16LE(options.attestationKeyType ?? 2, 2);
  head.writeUInt32LE(options.teeType ?? 0x81, 4);
  fill(0x93, 16).copy(head, 12); // QE vendor id
  const body = Buffer.alloc(kind === "td15" ? 648 : 584);
  fill(0x01, 16).copy(body, 0);
  fill(0x02).copy(body, 16);
  // TDATTRIBUTES: SEPT_VE_DISABLE (bit 28) as on real dstack TDs, DEBUG bit 0.
  body.writeUInt32LE(0x10000000 | (options.debug ? 1 : 0), 120);
  (options.mrTd ?? QUOTE_REGISTERS.mrTd).copy(body, 136);
  (options.rtmrs ?? QUOTE_REGISTERS.rtmrs).forEach((register, index) => {
    register.copy(body, 328 + index * 48);
  });
  if (options.reportData.length !== 64)
    throw new Error("quote report data must be 64 bytes");
  options.reportData.copy(body, 520);
  const descriptor = Buffer.alloc(version === 5 ? 6 : 0);
  if (version === 5) {
    descriptor.writeUInt16LE(kind === "td15" ? 3 : 2, 0);
    descriptor.writeUInt32LE(body.length, 2);
  }
  const signed = Buffer.concat([head, descriptor, body]);
  const signature = sign("sha256", signed, {
    key: options.attestationKey,
    dsaEncoding: "ieee-p1363",
  });
  // Certification data: type 6 (QE report) with opaque content; its PCK chain
  // is the external verifier's concern.
  const certification = Buffer.alloc(6 + 32);
  certification.writeUInt16LE(6, 0);
  certification.writeUInt32LE(32, 2);
  const signatureData = Buffer.concat([
    signature,
    rawP256(createPublicKey(options.attestationKey)),
    certification,
  ]);
  const length = Buffer.alloc(4);
  length.writeUInt32LE(signatureData.length);
  return Buffer.concat([signed, length, signatureData]);
}

// ---------------------------------------------------------------------------
// Fake dstack guest agent.
// ---------------------------------------------------------------------------

export type GuestMode = {
  /** Set TDATTRIBUTES.DEBUG in the quote. */
  debug?: boolean;
  /** Quote REPORTDATA differs from the request (quote still validly signed). */
  wrongQuoteReportData?: boolean;
  /** Stack report_data differs from the request. */
  wrongStackReportData?: boolean;
  /** dstack simulator behaviour: patch report data into a pre-signed quote. */
  simulatorPatchedQuote?: boolean;
  /** Re-sign quotes with an attestation key the verifier does not trust. */
  untrustedAttestationKey?: boolean;
  /** Return the legacy SCALE form (first byte 0x00). */
  legacyScale?: boolean;
  quoteVersion?: 4 | 5;
  quoteBody?: "td10" | "td15";
  /** Sign GetKey link 1 with a KMS key other than the pinned root. */
  foreignKms?: boolean;
  /** Encode bytes as MessagePack bin instead of serde u8 arrays. */
  binBytes?: boolean;
};

export type FakeDstackGuest = {
  socketPath: string;
  mode: GuestMode;
  attestationKeys: { trusted: KeyObject; untrusted: KeyObject };
  appRootKey: Uint8Array;
  kmsRootKey: Uint8Array;
  kmsRootPublicKeyHex: string;
  requests: string[];
  close(): Promise<void>;
};

function lengthPrefixed(...fields: Uint8Array[]): Buffer {
  return Buffer.concat(
    fields.flatMap((field) => {
      const length = Buffer.alloc(4);
      length.writeUInt32BE(field.length);
      return [length, Buffer.from(field)];
    }),
  );
}

/** dstack signs r || s || v; noble's "recovered" format is v || r || s. */
function recoverableSign(digest: Uint8Array, key: Uint8Array): Buffer {
  const signature = secp256k1.sign(digest, key, {
    prehash: false,
    format: "recovered",
  });
  return Buffer.concat([
    Buffer.from(signature.subarray(1)),
    Buffer.from(signature.subarray(0, 1)),
  ]);
}

/** guest-api-v1 KDF: HKDF-SHA256(salt "dstack-guest-v1", app root key, info). */
export function dstackV1DeriveKey(
  appRootKey: Uint8Array,
  algorithm: "ed25519" | "secp256k1",
  domain: string,
): Buffer {
  return Buffer.from(
    hkdfSync(
      "sha256",
      appRootKey,
      Buffer.from("dstack-guest-v1"),
      lengthPrefixed(
        Buffer.from("dstack-guest-v1-key"),
        Buffer.from(algorithm),
        Buffer.from(domain, "utf8"),
      ),
      32,
    ),
  );
}

function ed25519Public(seed: Buffer): Buffer {
  const key = createPrivateKey({
    key: Buffer.concat([
      Buffer.from("302e020100300506032b657004220420", "hex"),
      seed,
    ]),
    format: "der",
    type: "pkcs8",
  });
  return Buffer.from(
    String(createPublicKey(key).export({ format: "jwk" }).x),
    "base64url",
  );
}

async function readBody(request: import("node:http").IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
    string,
    unknown
  >;
}

export async function startFakeDstackGuest(
  directory: string,
  appIdHex: string,
): Promise<FakeDstackGuest> {
  const socketPath = path.join(directory, "dstack.sock");
  const trusted = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
  const untrusted = generateKeyPairSync("ec", {
    namedCurve: "P-256",
  }).privateKey;
  const appRootKey = secp256k1.utils.randomSecretKey();
  const kmsRootKey = secp256k1.utils.randomSecretKey();
  const foreignKmsKey = secp256k1.utils.randomSecretKey();
  const mode: GuestMode = {};
  const requests: string[] = [];
  // A captured quote with zero report data, as the dstack simulator ships.
  const captured = buildTdxQuote({
    reportData: Buffer.alloc(64),
    attestationKey: trusted,
  });

  function attest(reportData: Buffer): string {
    let quote: Buffer;
    if (mode.simulatorPatchedQuote) {
      quote = Buffer.from(captured);
      reportData.copy(quote, 568);
    } else {
      quote = buildTdxQuote({
        reportData: mode.wrongQuoteReportData ? randomBytes(64) : reportData,
        attestationKey: mode.untrustedAttestationKey ? untrusted : trusted,
        debug: mode.debug === true,
        version: mode.quoteVersion ?? 4,
        body: mode.quoteBody ?? "td10",
      });
    }
    const stackReportData = mode.wrongStackReportData
      ? randomBytes(64)
      : reportData;
    if (mode.legacyScale)
      return Buffer.concat([Buffer.from([0, 0]), quote]).toString("hex");
    const bytes = (value: Buffer): Packable =>
      mode.binBytes ? { bin: value } : value;
    return packMsgpack({
      version: 1,
      platform: {
        kind: "tdx",
        data: { quote: bytes(quote), event_log: [] },
      },
      stack: {
        kind: "dstack",
        data: {
          report_data: bytes(stackReportData),
          runtime_events: [],
          config: "{}",
        },
      },
    }).toString("hex");
  }

  function getKey(domain: string, algorithm: string) {
    if (algorithm !== "ed25519" && algorithm !== "secp256k1")
      throw new Error("unsupported algorithm");
    const seed = dstackV1DeriveKey(appRootKey, algorithm, domain);
    const publicKey =
      algorithm === "ed25519"
        ? ed25519Public(seed)
        : Buffer.from(secp256k1.getPublicKey(seed, true));
    const link0 = recoverableSign(
      keccak_256(
        lengthPrefixed(
          Buffer.from("dstack-guest-v1-key-claim"),
          Buffer.from(algorithm),
          Buffer.from(domain, "utf8"),
          publicKey,
        ),
      ),
      appRootKey,
    );
    const link1 = recoverableSign(
      keccak_256(
        Buffer.concat([
          Buffer.from("dstack-kms-issued:"),
          Buffer.from(appIdHex, "hex"),
          secp256k1.getPublicKey(appRootKey, true),
        ]),
      ),
      mode.foreignKms ? foreignKmsKey : kmsRootKey,
    );
    return {
      key: seed.toString("hex"),
      public_key: publicKey.toString("hex"),
      signature_chain: [link0.toString("hex"), link1.toString("hex")],
    };
  }

  const server: Server = createServer((request, response) => {
    void (async () => {
      try {
        requests.push(request.url ?? "");
        const body = await readBody(request);
        let payload: unknown;
        if (request.method === "POST" && request.url === "/v1/Attest") {
          const reportData = Buffer.from(String(body.report_data), "hex");
          if (reportData.length > 64) throw new Error("report_data > 64 bytes");
          const padded = Buffer.alloc(64);
          reportData.copy(padded);
          payload = { attestation: attest(padded) };
        } else if (request.method === "POST" && request.url === "/v1/GetKey") {
          payload = getKey(String(body.domain), String(body.algorithm));
        } else {
          response.writeHead(404).end();
          return;
        }
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify(payload));
      } catch (error) {
        response
          .writeHead(400, { "content-type": "application/json" })
          .end(JSON.stringify({ error: String(error) }));
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return {
    socketPath,
    mode,
    attestationKeys: { trusted, untrusted },
    appRootKey,
    kmsRootKey,
    kmsRootPublicKeyHex: Buffer.from(
      secp256k1.getPublicKey(kmsRootKey, true),
    ).toString("hex"),
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// ---------------------------------------------------------------------------
// Stub dstack-verifier executable, pinned by SHA-256.
// ---------------------------------------------------------------------------

const STUB_VERIFIER_SOURCE = `
import { readFileSync } from "node:fs";
import { createPublicKey, verify } from "node:crypto";
const args = process.argv.slice(2);
const config = JSON.parse(readFileSync(args[args.indexOf("--config") + 1], "utf8"));
const input = JSON.parse(readFileSync(args[args.indexOf("--verify") + 1], "utf8"));
const raw = Buffer.from(input.attestation, "hex");
let at = 0;
const u = (n) => { const v = raw.readUIntBE(at, n); at += n; return v; };
function read() {
  const t = u(1);
  if (t <= 0x7f) return t;
  if (t >= 0x80 && t <= 0x8f) return map(t & 15);
  if (t >= 0x90 && t <= 0x9f) return arr(t & 15);
  if (t >= 0xa0 && t <= 0xbf) return str(t & 31);
  switch (t) {
    case 0xc0: return null;
    case 0xc2: return false;
    case 0xc3: return true;
    case 0xc4: return bin(u(1));
    case 0xc5: return bin(u(2));
    case 0xc6: return bin(u(4));
    case 0xcc: return u(1);
    case 0xcd: return u(2);
    case 0xce: return u(4);
    case 0xd9: return str(u(1));
    case 0xda: return str(u(2));
    case 0xdc: return arr(u(2));
    case 0xdd: return arr(u(4));
    case 0xde: return map(u(2));
    default: throw new Error("unsupported msgpack " + t);
  }
}
function bin(n) { const b = raw.subarray(at, at + n); at += n; return b; }
function str(n) { return bin(n).toString("utf8"); }
function arr(n) { const a = []; for (let i = 0; i < n; i++) a.push(read()); return a; }
function map(n) { const m = {}; for (let i = 0; i < n; i++) { const k = read(); m[k] = read(); } return m; }
const bytes = (v) => Buffer.isBuffer(v) ? v : Buffer.from(v);
function fail(reason) {
  process.stdout.write(JSON.stringify({ is_valid: false, details: {}, reason }));
  process.exit(1);
}
if (raw[0] === 0) fail("legacy attestation fixture has no trusted quote");
const doc = read();
const quote = bytes(doc.platform.data.quote);
const version = quote.readUInt16LE(0);
const bodyOffset = version === 5 ? 54 : 48;
const bodyLength = version === 5 ? quote.readUInt32LE(50) : 584;
const signedEnd = bodyOffset + bodyLength;
const sig = quote.subarray(signedEnd + 4, signedEnd + 68);
const ak = quote.subarray(signedEnd + 68, signedEnd + 132);
if (!config.trustedAttestationKeys.includes(ak.toString("hex")))
  fail("attestation key does not chain to the trusted root");
const key = createPublicKey({ key: { kty: "EC", crv: "P-256",
  x: ak.subarray(0, 32).toString("base64url"), y: ak.subarray(32).toString("base64url") }, format: "jwk" });
if (!verify("sha256", quote.subarray(0, signedEnd), { key, dsaEncoding: "ieee-p1363" }, sig))
  fail("quote signature invalid");
const body = quote.subarray(bodyOffset, signedEnd);
const h = (o, n) => body.subarray(o, o + n).toString("hex");
const details = {
  quote_verified: true,
  event_log_verified: true,
  os_image_hash_verified: true,
  tee_variant: "dstack-tdx",
  report_data: bytes(doc.stack.data.report_data).toString("hex"),
  tcb_status: "UpToDate",
  advisory_ids: [],
  os_image_is_dev: false,
  acpi_tables_verified: true,
  ...config.details,
  app_info: {
    ...config.appInfo,
    mrtd: h(136, 48), rtmr0: h(328, 48), rtmr1: h(376, 48), rtmr2: h(424, 48), rtmr3: h(472, 48),
    ...config.appInfoOverrides,
  },
};
process.stdout.write(JSON.stringify({ is_valid: true, details, reason: null }));
`;

export type StubVerifierConfig = {
  trustedAttestationKeys: string[];
  appInfo: {
    app_id: string;
    compose_hash: string;
    os_image_hash: string;
    mr_aggregated: string;
  };
  details?: Record<string, unknown>;
  appInfoOverrides?: Record<string, unknown>;
};

export type PinnedVerifier = {
  verifierPath: string;
  verifierSha256: string;
  verifierConfigPath: string;
  verifierConfigSha256: string;
};

function sha256(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Write the stub verifier plus one configuration and pin both by digest. */
export async function writePinnedStubVerifier(
  directory: string,
  config: StubVerifierConfig,
): Promise<PinnedVerifier> {
  const verifierPath = path.join(directory, "dstack-verifier.mjs");
  const source = `#!${process.execPath}\n${STUB_VERIFIER_SOURCE}`;
  await writeFile(verifierPath, source, { mode: 0o755 });
  await chmod(verifierPath, 0o755);
  const verifierConfigPath = path.join(
    directory,
    `verifier-${randomBytes(6).toString("hex")}.json`,
  );
  const configText = JSON.stringify(config);
  await writeFile(verifierConfigPath, configText, { mode: 0o600 });
  return {
    verifierPath,
    verifierSha256: sha256(source),
    verifierConfigPath,
    verifierConfigSha256: sha256(configText),
  };
}

// ---------------------------------------------------------------------------
// Signed release identity (Ed25519 release authority).
// ---------------------------------------------------------------------------

export type ReleaseIdentity = {
  appId: string;
  composeHash: string;
  osImageHash: string;
  variant?: "dstack-tdx" | "dstack-nitro-enclave";
  notBefore?: string;
  expiresAt?: string;
};

export function signReleaseIdentity(identity: ReleaseIdentity): {
  policyJson: string;
  publicKeyPem: string;
} {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const payload = Buffer.from(
    JSON.stringify({
      appId: identity.appId,
      composeHash: identity.composeHash,
      osImageHash: identity.osImageHash,
      variant: identity.variant ?? "dstack-tdx",
      schemaVersion: 1,
      notBefore:
        identity.notBefore ?? new Date(Date.now() - 60_000).toISOString(),
      expiresAt:
        identity.expiresAt ?? new Date(Date.now() + 3_600_000).toISOString(),
    }),
  );
  const signature = sign(
    null,
    Buffer.concat([Buffer.from("eliza-dstack-release-v1\0"), payload]),
    privateKey,
  );
  return {
    policyJson: JSON.stringify({
      payload: payload.toString("base64"),
      signature: signature.toString("base64"),
    }),
    publicKeyPem: String(publicKey.export({ type: "spki", format: "pem" })),
  };
}

// ---------------------------------------------------------------------------
// Complete deployment fixture.
// ---------------------------------------------------------------------------

export const DEPLOYMENT = {
  appId: "e631a04a5d068c0e5ffd8ca60d6574ac99a18bda",
  composeHash: "c".repeat(64),
  osImageHash: "d".repeat(64),
  mrAggregated: "e".repeat(64),
};

export type DstackHarness = {
  directory: string;
  guest: FakeDstackGuest;
  /** Build a protected dstack-cpu admission environment for one scenario. */
  environment(options?: {
    verifier?: Partial<StubVerifierConfig>;
    release?: Partial<ReleaseIdentity>;
    pin?: Partial<PinnedVerifier>;
    kmsRootPublicKey?: string;
    /** `gpu` block of the dstack evidence configuration. */
    gpu?: Record<string, unknown>;
  }): Promise<Record<string, string>>;
  close(): Promise<void>;
};

export async function startDstackHarness(): Promise<DstackHarness> {
  const directory = await mkdtemp(path.join(tmpdir(), "dsk-"));
  const guest = await startFakeDstackGuest(directory, DEPLOYMENT.appId);
  return {
    directory,
    guest,
    async environment(options = {}) {
      const pinned = await writePinnedStubVerifier(directory, {
        trustedAttestationKeys: [
          rawP256(createPublicKey(guest.attestationKeys.trusted)).toString(
            "hex",
          ),
        ],
        appInfo: {
          app_id: DEPLOYMENT.appId,
          compose_hash: DEPLOYMENT.composeHash,
          os_image_hash: DEPLOYMENT.osImageHash,
          mr_aggregated: DEPLOYMENT.mrAggregated,
        },
        ...options.verifier,
      });
      const release = signReleaseIdentity({
        appId: DEPLOYMENT.appId,
        composeHash: DEPLOYMENT.composeHash,
        osImageHash: DEPLOYMENT.osImageHash,
        ...options.release,
      });
      return {
        ELIZA_TEE_PRODUCTION_PROFILE: "dstack-cpu",
        ELIZA_DSTACK_EVIDENCE_CONFIG_JSON: JSON.stringify({
          socketPath: guest.socketPath,
          ...pinned,
          ...options.pin,
          variant: "dstack-tdx",
          kmsRootPublicKey:
            options.kmsRootPublicKey ?? guest.kmsRootPublicKeyHex,
          timeoutMs: 30_000,
          ...(options.gpu ? { gpu: options.gpu } : {}),
        }),
        ELIZA_DSTACK_RELEASE_POLICY_JSON: release.policyJson,
        ELIZA_DSTACK_RELEASE_PUBKEY: release.publicKeyPem,
      };
    },
    async close() {
      await guest.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

/** Flatten an error and its causes into one searchable string. */
export function causeChain(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current !== undefined && depth < 12; depth += 1) {
    if (current instanceof Error) {
      parts.push(
        `${(current as { code?: string }).code ?? ""}:${current.message}`,
      );
      current = current.cause;
    } else {
      parts.push(String(current));
      break;
    }
  }
  return parts.join(" <- ");
}
