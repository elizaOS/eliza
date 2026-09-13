/**
 * Pins the root guardian's native key before a contained attempt can start.
 * The private run context accepts evidence only after the same owned channel
 * confirms terminal cleanup and key disposal; artifact-provided keys confer no trust.
 */
import {
  createHash,
  createPublicKey,
  type KeyObject,
  verify,
} from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, readFile } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { performance } from "node:perf_hooks";
import { ElizaError } from "@elizaos/core/errors";
import { canonicalJsonString } from "@elizaos/shared/canonical-json";
import { validateNativeLedger } from "./native-ledger-evidence.ts";

export type NativeExpectedContext = Readonly<Record<string, string | number>>;

export interface NativeAdapterIdentity {
  pid: number;
  uid: number;
  startTicks: number;
}

export interface NativeSignedManifest {
  schema: "eliza.stability.native.v1";
  nonce: string;
  context: NativeExpectedContext;
  nativeLedgerQualified: true;
  cleanupVerified: true;
  ledgerSha256: string;
  journalSha256: string;
  countersSha256: string;
  drainSha256: string;
  producerInventorySha256: string;
  monitorInventorySha256: string;
  buildSha256: string;
  policySha256: string;
  btfSha256: string;
  guardianSha256: string;
  signerSha256: string;
  kernelRelease: string;
  ledgerBytes: number;
  ledgerRecords: number;
  producerQuiesced: true;
  collectorExitCode: 0;
  ownedBpfObjectsGone: true;
  completionProof: "source-enforced-v1";
}

export interface NativeAttestation {
  manifest: NativeSignedManifest;
  signature: string;
  fingerprint: string;
}

function fail(message: string, cause?: Error): ElizaError {
  return new ElizaError(message, {
    code: "STABILITY_NATIVE_ATTESTATION_INVALID",
    cause,
  });
}

/** Canonical input is structural evidence, never model-facing content. */
function canonical(value: object): string {
  return canonicalJsonString(value, {
    maxDepth: 16,
    maxNodes: 4096,
    maxOutputChars: 65536,
    sparseArrayHoles: "null",
    onUnbounded: () => {
      throw fail("Native structural evidence exceeds protocol limits");
    },
  });
}

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw fail("Native control message is not an object");
  return value as Record<string, unknown>;
}

/** Reads the actual outer adapter identity for the root peer admission. */
export async function nativeAdapterIdentity(): Promise<NativeAdapterIdentity> {
  if (process.platform !== "linux" || !process.getuid)
    throw fail("Native attestation requires Linux process identity");
  const text = await readFile(`/proc/${process.pid}/stat`, "utf8");
  const startTicks = Number(
    text.slice(text.lastIndexOf(")") + 2).split(" ")[19],
  );
  if (!Number.isSafeInteger(startTicks) || startTicks <= 0)
    throw fail("Native adapter start identity is invalid");
  return { pid: process.pid, uid: process.getuid(), startTicks };
}

const acceptNativeTerminal = Symbol("owned native terminal channel");
const prepareNativeArtifacts = Symbol("owned native artifact handoff");

/** Non-serializable trust is retained by the outer adapter, never reconstructed from a bundle. */
export class NativeVerifierContext {
  #key: KeyObject;
  #terminalDigest: string | undefined;
  #preparedDigest: string | undefined;
  readonly fingerprint: string;
  readonly nonce: string;
  readonly expected: NativeExpectedContext;

  constructor(
    nonce: string,
    expected: NativeExpectedContext,
    publicDer: Buffer,
  ) {
    this.nonce = nonce;
    this.expected = Object.freeze({ ...expected });
    this.#key = createPublicKey({
      key: publicDer,
      format: "der",
      type: "spki",
    });
    if (this.#key.asymmetricKeyType !== "ed25519")
      throw fail("Native key must be Ed25519");
    this.fingerprint = hash(publicDer);
  }

  #validate(value: unknown): NativeAttestation {
    const attestation = record(value);
    const manifest = record(attestation.manifest);
    if (
      attestation.fingerprint !== this.fingerprint ||
      typeof attestation.signature !== "string" ||
      !/^[a-f0-9]{128}$/.test(attestation.signature)
    )
      throw fail("Native signature identity is invalid");
    if (
      manifest.schema !== "eliza.stability.native.v1" ||
      manifest.nonce !== this.nonce ||
      canonical(record(manifest.context)) !== canonical(this.expected) ||
      manifest.nativeLedgerQualified !== true ||
      manifest.cleanupVerified !== true
    )
      throw fail(
        "Native attestation does not match admitted context and cleanup",
      );
    for (const field of [
      "ledgerSha256",
      "journalSha256",
      "countersSha256",
      "drainSha256",
      "producerInventorySha256",
      "monitorInventorySha256",
      "buildSha256",
      "policySha256",
      "btfSha256",
      "guardianSha256",
      "signerSha256",
    ])
      if (
        typeof manifest[field] !== "string" ||
        !/^[a-f0-9]{64}$/.test(manifest[field])
      )
        throw fail("Native artifact binding is invalid");
    // These identities originate in the outer adapter before PIN. A signed
    // artifact cannot select a different observer, kernel, or containment policy.
    for (const field of [
      "buildSha256",
      "policySha256",
      "btfSha256",
      "guardianSha256",
      "signerSha256",
      "kernelRelease",
    ])
      if (
        manifest[field] !== this.expected[field] ||
        typeof manifest[field] !== "string" ||
        manifest[field] === ""
      )
        throw fail("Native observer identity differs from trusted admission");
    for (const field of ["ledgerBytes", "ledgerRecords"])
      if (
        typeof manifest[field] !== "number" ||
        !Number.isSafeInteger(manifest[field]) ||
        manifest[field] <= 0
      )
        throw fail("Native ledger extent is invalid");
    if (
      manifest.producerQuiesced !== true ||
      manifest.collectorExitCode !== 0 ||
      manifest.ownedBpfObjectsGone !== true ||
      manifest.completionProof !== "source-enforced-v1"
    )
      throw fail("Native producer completion is missing");
    // Retirement and bootstrap invariants are enforced by the exact admitted
    // collector. This is not a claim that its internal maps were serialized.
    if (
      !verify(
        null,
        Buffer.from(canonical(manifest)),
        this.#key,
        Buffer.from(attestation.signature, "hex"),
      )
    )
      throw fail("Native signature verification failed");
    return attestation as unknown as NativeAttestation;
  }

  [prepareNativeArtifacts](value: unknown): NativeAttestation {
    if (this.#preparedDigest)
      throw fail("Native artifacts were already prepared");
    const result = this.#validate(value);
    this.#preparedDigest = hash(canonical(result));
    return result;
  }

  /** Only the owned channel invokes this after explicit terminal key disposal. */
  [acceptNativeTerminal](value: unknown): NativeAttestation {
    if (this.#terminalDigest)
      throw fail("Native terminal acceptance was already consumed");
    const terminal = record(value);
    if (
      terminal.type !== "native-terminal" ||
      terminal.nonce !== this.nonce ||
      terminal.keyDisposed !== true
    )
      throw fail("Native terminal disposal is missing");
    const attestation = this.#validate(terminal.attestation);
    const digest = hash(canonical(attestation));
    if (!this.#preparedDigest || this.#preparedDigest !== digest)
      throw fail("Native terminal differs from persisted artifact handoff");
    this.#terminalDigest = digest;
    return attestation;
  }

  /** A correct signature alone cannot restore terminal trust from exported artifacts. */
  verifyArtifact(value: unknown): NativeAttestation {
    const result = this.#validate(value);
    if (
      !this.#terminalDigest ||
      this.#terminalDigest !== hash(canonical(result))
    )
      throw fail("Native artifact lacks trusted terminal acceptance");
    return result;
  }
}

export interface NativeChannelOptions {
  nonce: string;
  expectedContext: NativeExpectedContext;
  timeoutMs: number;
  signal?: AbortSignal;
  onPinned: (context: NativeVerifierContext) => void | Promise<void>;
  onArtifacts?: (
    artifacts: NativeArtifactBytes,
    attestation: NativeAttestation,
  ) => void | Promise<void>;
}

/** Connects only to the root-owned endpoint and resolves after terminal acceptance. */
export async function awaitNativeAttestation(
  options: NativeChannelOptions,
): Promise<{ context: NativeVerifierContext; attestation: NativeAttestation }> {
  if (
    !/^[a-f0-9]{32}$/.test(options.nonce) ||
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs <= 0
  )
    throw fail("Native channel admission is invalid");
  const directory = `/run/eliza-native-adapter-${options.nonce}`;
  const endpoint = `${directory}/control.sock`;
  const deadline = performance.now() + options.timeoutMs;
  let socket: Socket | undefined;
  try {
    while (true) {
      if (options.signal?.aborted) throw fail("Native channel was cancelled");
      if (performance.now() >= deadline)
        throw fail("Native root rendezvous deadline expired");
      try {
        const [parent, child] = await Promise.all([
          lstat(directory),
          lstat(endpoint),
        ]);
        if (
          !parent.isDirectory() ||
          parent.uid !== 0 ||
          (parent.mode & 0o777) !== 0o711 ||
          !child.isSocket() ||
          child.uid !== 0 ||
          (child.mode & 0o777) !== 0o666
        )
          throw fail("Native rendezvous is not root-owned authority");
        break;
      } catch (error) {
        // error-policy:J4 Only absence means the root endpoint is still starting.
        if (
          !(error instanceof Error) ||
          !("code" in error) ||
          error.code !== "ENOENT"
        )
          throw error;
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
      }
    }
    socket = createConnection(endpoint);
    const connected = socket;
    return await new Promise((resolve, reject) => {
      let buffered = Buffer.alloc(0);
      let context: NativeVerifierContext | undefined;
      let settled = false;
      let pinAcknowledged = false;
      let artifactPending = false;
      let artifactsAcknowledged = false;
      const timer = setTimeout(
        () => finish(fail("Native channel terminal deadline expired")),
        Math.max(1, deadline - performance.now()),
      );
      const cancel = () => finish(fail("Native channel was cancelled"));
      const finish = (error?: Error, attestation?: NativeAttestation) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", cancel);
        connected.destroy();
        if (error) reject(error);
        else if (context && attestation) resolve({ context, attestation });
        else reject(fail("Native terminal result is incomplete"));
      };
      options.signal?.addEventListener("abort", cancel, { once: true });
      if (options.signal?.aborted) {
        cancel();
        return;
      }
      connected.on("error", (error) =>
        finish(fail("Native root channel failed", error)),
      );
      connected.on("end", () =>
        finish(fail("Native root channel ended before acceptance")),
      );
      connected.on("data", (piece: Buffer) => {
        if (settled) return;
        try {
          buffered = Buffer.concat([buffered, piece]);
          if (buffered.length > 65536)
            throw fail("Native channel message exceeds protocol limit");
          const end = buffered.indexOf(10);
          if (end < 0) return;
          if (end !== buffered.length - 1)
            throw fail("Native channel sent unexpected pipelined messages");
          const value: unknown = JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(
              buffered.subarray(0, end),
            ),
          );
          buffered = Buffer.alloc(0);
          const message = record(value);
          if (!context) {
            if (
              message.type !== "native-key" ||
              message.nonce !== options.nonce ||
              message.contextSha256 !==
                hash(canonical(options.expectedContext)) ||
              typeof message.publicKeyDer !== "string" ||
              !/^[a-f0-9]{88}$/.test(message.publicKeyDer)
            )
              throw fail("Native key admission does not match this attempt");
            context = new NativeVerifierContext(
              options.nonce,
              options.expectedContext,
              Buffer.from(message.publicKeyDer, "hex"),
            );
            if (message.fingerprint !== context.fingerprint)
              throw fail("Native key fingerprint is invalid");
            const acknowledgment = `${canonical({ type: "native-key-pinned", nonce: options.nonce, contextSha256: message.contextSha256, fingerprint: context.fingerprint })}\n`;
            Promise.resolve(options.onPinned(context)).then(
              () => {
                if (settled || options.signal?.aborted || connected.destroyed)
                  return;
                pinAcknowledged = true;
                connected.write(acknowledgment);
              },
              (error: unknown) => {
                // error-policy:J1 Failed trusted key persistence prevents admission.
                finish(
                  error instanceof Error
                    ? error
                    : fail("Native key pin failed"),
                );
              },
            );
          } else {
            if (!pinAcknowledged)
              throw fail(
                "Native terminal arrived before key pin acknowledgment",
              );
            if (message.type === "native-artifacts-ready") {
              if (
                artifactPending ||
                artifactsAcknowledged ||
                message.nonce !== options.nonce ||
                !options.onArtifacts
              )
                throw fail(
                  "Native artifact handoff is unexpected or lacks persistence",
                );
              artifactPending = true;
              const pinned = context;
              const persist = options.onArtifacts;
              void (async () => {
                const artifacts = await readRootNativeArtifacts(directory);
                if (settled || options.signal?.aborted || connected.destroyed)
                  return;
                const attestation = pinned[prepareNativeArtifacts](
                  message.attestation,
                );
                validateNativeArtifactBytes(attestation, artifacts);
                await persist(artifacts, attestation);
                if (settled || options.signal?.aborted || connected.destroyed)
                  return;
                artifactsAcknowledged = true;
                connected.write(
                  `${canonical({ type: "native-artifacts-persisted", nonce: options.nonce, attestationSha256: hash(canonical(attestation)) })}\n`,
                );
              })().catch((error: unknown) => {
                // error-policy:J1 Persistence rejection or cancellation cannot authorize terminal acceptance.
                finish(
                  error instanceof Error
                    ? error
                    : fail("Native artifact persistence failed"),
                );
              });
            } else {
              if (!artifactsAcknowledged)
                throw fail(
                  "Native terminal arrived before artifact persistence",
                );
              finish(undefined, context[acceptNativeTerminal](value));
            }
          }
        } catch (error) {
          // error-policy:J1 Invalid root protocol messages fail this owned attempt.
          finish(
            error instanceof Error ? error : fail("Native protocol failed"),
          );
        }
      });
    });
  } finally {
    socket?.destroy();
  }
}

export interface NativeArtifactBytes {
  ledger: Buffer;
  journal: Buffer;
  counters: Buffer;
  drain: Buffer;
  producerInventory: Buffer;
  monitorInventory: Buffer;
  build: Buffer;
}

/** Verifies supplied complete artifact bytes against separately retained terminal authority. */
export function verifyNativeArtifacts(
  context: NativeVerifierContext,
  value: unknown,
  artifacts: NativeArtifactBytes,
): NativeAttestation {
  const attestation = context.verifyArtifact(value);
  validateNativeArtifactBytes(attestation, artifacts);
  return attestation;
}

function validateNativeArtifactBytes(
  attestation: NativeAttestation,
  artifacts: NativeArtifactBytes,
): void {
  const manifest = attestation.manifest;
  const bindings = [
    [artifacts.ledger, manifest.ledgerSha256],
    [artifacts.journal, manifest.journalSha256],
    [artifacts.counters, manifest.countersSha256],
    [artifacts.drain, manifest.drainSha256],
    [artifacts.producerInventory, manifest.producerInventorySha256],
    [artifacts.monitorInventory, manifest.monitorInventorySha256],
    [artifacts.build, manifest.buildSha256],
  ] as const;
  for (const [bytes, digest] of bindings)
    if (hash(bytes) !== digest)
      throw fail("Native retained artifact bytes differ from signed evidence");
  const ledger = validateNativeLedger(artifacts.ledger, artifacts.counters);
  if (
    ledger.bytes !== manifest.ledgerBytes ||
    ledger.records !== manifest.ledgerRecords
  )
    throw fail("Native retained ledger extent differs from signed evidence");
  let drain: Record<string, unknown>;
  try {
    drain = record(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(artifacts.drain),
      ),
    );
  } catch (cause) {
    // error-policy:J3 A malformed drain receipt cannot stand in for collector completion.
    throw fail(
      "Native drain receipt is invalid",
      cause instanceof Error ? cause : undefined,
    );
  }
  if (
    drain.schema !== 1 ||
    drain.nativeManifestAuthenticated !== false ||
    drain.records !== ledger.records ||
    drain.bytes !== ledger.bytes ||
    drain.syscallEntries !== ledger.syscallEntries ||
    drain.syscallExits !== ledger.syscallExits
  )
    throw fail("Native drain receipt disagrees with complete kernel records");
}

async function readRootNativeArtifacts(
  rendezvous: string,
): Promise<NativeArtifactBytes> {
  const directory = await open(
    `${rendezvous}/evidence`,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
  );
  try {
    const metadata = await directory.stat();
    if (metadata.uid !== 0 || (metadata.mode & 0o777) !== 0o755)
      throw fail("Native evidence directory is not root-owned");
    const names = [
      "ledger.jsonl",
      "journal.jsonl",
      "counters.json",
      "drain.json",
      "producer-ids.txt",
      "monitor-ids.txt",
      "build.json",
    ];
    const result: Buffer[] = [];
    for (const name of names) {
      const file = await open(
        `/proc/self/fd/${directory.fd}/${name}`,
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
      );
      try {
        const before = await file.stat({ bigint: true });
        if (
          !before.isFile() ||
          before.uid !== 0n ||
          before.nlink !== 1n ||
          (before.mode & 0o777n) !== 0o644n ||
          before.size > 67108864n
        )
          throw fail(
            "Native evidence entry is not a supported immutable root file",
          );
        const bytes = Buffer.alloc(Number(before.size));
        let offset = 0;
        while (offset < bytes.length) {
          const read = await file.read(
            bytes,
            offset,
            bytes.length - offset,
            offset,
          );
          if (!read.bytesRead) throw fail("Native evidence file ended early");
          offset += read.bytesRead;
        }
        const extra = await file.read(Buffer.alloc(1), 0, 1, offset);
        const after = await file.stat({ bigint: true });
        if (
          extra.bytesRead ||
          before.dev !== after.dev ||
          before.ino !== after.ino ||
          before.size !== after.size ||
          before.mtimeNs !== after.mtimeNs ||
          before.ctimeNs !== after.ctimeNs
        )
          throw fail("Native evidence changed during handoff");
        result.push(bytes);
      } finally {
        await file.close();
      }
    }
    return {
      ledger: result[0],
      journal: result[1],
      counters: result[2],
      drain: result[3],
      producerInventory: result[4],
      monitorInventory: result[5],
      build: result[6],
    };
  } finally {
    await directory.close();
  }
}
