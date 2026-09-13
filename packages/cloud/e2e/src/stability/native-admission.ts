/**
 * Owns the Cloud run's independent native key pins and durable artifact handoff.
 * The generic process adapter receives only a public bootstrap and a terminal
 * reference; payload output cannot create or restore this verifier authority.
 */
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { ElizaError } from "@elizaos/core/errors";
import type { ScenarioStabilitySubprocessAdapterOptions } from "@elizaos/scenario-runner/stability-subprocess-adapter";
import { canonicalJsonString } from "@elizaos/shared/canonical-json";
import { NATIVE_STABILITY_TIMEOUT_MS } from "./linux-sandbox.ts";
import type { CloudStabilityManifest } from "./cloud-stability-runner.ts";
import {
  awaitNativeAttestation,
  type NativeExpectedContext,
  type NativeVerifierContext,
  nativeAdapterIdentity,
  verifyNativeArtifacts,
} from "./native-attestation-channel.ts";

function canonical(value: Parameters<typeof canonicalJsonString>[0]): string {
  return canonicalJsonString(value, {
    maxDepth: 16,
    maxNodes: 4096,
    maxOutputChars: 65536,
    sparseArrayHoles: "null",
    onUnbounded: () => {
      throw new Error("Native admission exceeds its protocol boundary");
    },
  });
}

class NativePersistenceCancelled extends Error {}

export function createCloudNativeAdmission(options: {
  manifest: CloudStabilityManifest;
  authority: NativeExpectedContext;
  nativeBundle: string;
  ownerScript: string;
  trusted: Map<string, NativeVerifierContext>;
}): NonNullable<ScenarioStabilitySubprocessAdapterOptions["nativeAdmission"]> {
  const authority = Object.freeze({ ...options.authority });
  const manifest = Object.freeze({ ...options.manifest });
  if (
    !Number.isInteger(manifest.timeoutMs) ||
    manifest.timeoutMs < 1 ||
    manifest.timeoutMs > NATIVE_STABILITY_TIMEOUT_MS
  ) {
    throw new ElizaError(
      "Native attempts support durations from 1 through 600000 milliseconds",
      {
        code: "STABILITY_NATIVE_DURATION_UNSUPPORTED",
        context: { timeoutMs: manifest.timeoutMs },
      },
    );
  }
  return {
    async prepare(input) {
      if (input.signal.aborted) throw input.signal.reason;
      const output = await open(
        input.outputDir,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      let disposal: Promise<void> | undefined;
      const cancellation = new AbortController();
      const abort = () => cancellation.abort(input.signal.reason);
      input.signal.addEventListener("abort", abort, { once: true });
      if (input.signal.aborted) abort();
      const nonce = randomBytes(16).toString("hex");
      const expected = {
        ...authority,
        attemptId: input.attemptId,
        runId: manifest.runId,
        scenarioFingerprint: manifest.scenarioFingerprint,
        worldFingerprint: manifest.worldFingerprint,
        timeoutMs: manifest.timeoutMs,
        maxInputTokens: manifest.maxInputTokens,
        maxOutputTokens: manifest.maxOutputTokens,
        maxModelRequests: manifest.maxModelRequests,
        maxToolCalls: manifest.maxToolCalls,
      };
      let retained: Parameters<typeof verifyNativeArtifacts>[2] | undefined;
      let persistenceSettlement: Promise<{ error?: unknown }> | undefined;
      const assertPersisting = () => {
        if (cancellation.signal.aborted)
          throw new NativePersistenceCancelled(
            "Native artifact persistence was cancelled",
          );
      };
      const channel = awaitNativeAttestation({
        nonce,
        expectedContext: expected,
        timeoutMs: input.budgets.timeoutMs,
        signal: cancellation.signal,
        onPinned(context) {
          if (options.trusted.has(input.attemptId))
            throw new Error("Native attempt already has a key pin");
          options.trusted.set(input.attemptId, context);
        },
        onArtifacts(artifacts, attestation) {
          assertPersisting();
          if (persistenceSettlement)
            throw new Error("Native persistence already started");
          const persistence = (async () => {
            assertPersisting();
            const outputInfo = await output.stat();
            assertPersisting();
            if (
              !outputInfo.isDirectory() ||
              outputInfo.uid !== process.getuid?.()
            )
              throw new Error("Native output directory ownership changed");
            const directoryPath = `/proc/self/fd/${output.fd}/native`;
            await mkdir(directoryPath, { mode: 0o700 });
            assertPersisting();
            const directory = await open(
              directoryPath,
              constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
            );
            let primary: unknown;
            try {
              assertPersisting();
              const info = await directory.stat();
              assertPersisting();
              if (
                !info.isDirectory() ||
                info.uid !== outputInfo.uid ||
                (info.mode & 0o777) !== 0o700
              )
                throw new Error(
                  "Native persistence directory is not owned authority",
                );
              const files = {
                "ledger.jsonl": artifacts.ledger,
                "journal.jsonl": artifacts.journal,
                "counters.json": artifacts.counters,
                "drain.json": artifacts.drain,
                "producer-ids.txt": artifacts.producerInventory,
                "monitor-ids.txt": artifacts.monitorInventory,
                "build.json": artifacts.build,
                "attestation.json": Buffer.from(canonical(attestation)),
              };
              for (const [name, bytes] of Object.entries(files)) {
                assertPersisting();
                const file = await open(
                  `/proc/self/fd/${directory.fd}/${name}`,
                  constants.O_WRONLY |
                    constants.O_CREAT |
                    constants.O_EXCL |
                    constants.O_NOFOLLOW,
                  0o600,
                );
                let writeFailure: unknown;
                try {
                  assertPersisting();
                  await file.writeFile(bytes);
                  assertPersisting();
                  await file.sync();
                } catch (error) {
                  // error-policy:J2 Preserve write failure if descriptor cleanup also fails.
                  writeFailure = error;
                }
                try {
                  await file.close();
                } catch (error) {
                  // error-policy:J2 Both persistence and descriptor cleanup failures reject handoff.
                  throw new AggregateError(
                    writeFailure === undefined
                      ? [error]
                      : [writeFailure, error],
                    "Native artifact write/close failed",
                  );
                }
                if (writeFailure !== undefined) throw writeFailure;
              }
              assertPersisting();
              await directory.sync();
              assertPersisting();
              await output.sync();
              assertPersisting();
              retained = artifacts;
            } catch (error) {
              // error-policy:J2 Cleanup cannot replace the artifact persistence failure.
              primary = error;
            }
            try {
              await directory.close();
            } catch (error) {
              // error-policy:J2 Failed directory closure rejects the acknowledgement.
              throw new AggregateError(
                primary === undefined ? [error] : [primary, error],
                "Native persistence directory cleanup failed",
              );
            }
            if (primary !== undefined) throw primary;
          })();
          persistenceSettlement = persistence.then(
            () => ({}),
            (error: unknown) => ({ error }),
          );
          return persistence;
        },
      });
      const completion = channel.then(({ context, attestation }) => {
        if (!retained)
          throw new Error("Native terminal omitted persisted artifacts");
        verifyNativeArtifacts(context, attestation, retained);
        return {
          schema: "eliza.stability.native-reference.v1" as const,
          attestationSha256: createHash("sha256")
            .update(canonical(attestation))
            .digest("hex"),
        };
      });
      // The adapter observes the original completion; teardown observes this settlement.
      const settlement = completion.then(
        (reference) => ({ reference }),
        (error: unknown) => ({ error }),
      );
      const dispose = (): Promise<void> => {
        disposal ??= (async () => {
          cancellation.abort();
          const completed = await settlement;
          const persisted = await persistenceSettlement;
          input.signal.removeEventListener("abort", abort);
          const failures: unknown[] = [];
          if ("error" in completed)
            failures.push(
              new ElizaError(
                "Native authority cleanup has no verified terminal",
                {
                  code: "STABILITY_NATIVE_CLEANUP_UNPROVEN",
                  cause: completed.error,
                  context: { attemptId: input.attemptId },
                },
              ),
            );
          if (
            persisted?.error !== undefined &&
            !(persisted.error instanceof NativePersistenceCancelled)
          )
            failures.push(persisted.error);
          try {
            await output.close();
          } catch (error) {
            // error-policy:J2 Descriptor cleanup remains observable after cancellation.
            failures.push(error);
          }
          if (failures.length)
            throw new AggregateError(
              failures,
              "Native admission teardown failed",
            );
        })();
        return disposal;
      };
      try {
        const adapterIdentity = await nativeAdapterIdentity();
        return {
          bootstrap: canonical({
            version: 1,
            nativeBundle: options.nativeBundle,
            ownerScript: options.ownerScript,
            request: { nonce, context: expected, adapterIdentity },
          }),
          completion,
          cancel: dispose,
        };
      } catch (cause) {
        // error-policy:J2 Preparation owns cleanup before a lease can be returned.
        try {
          await dispose();
        } catch (cleanupError) {
          // error-policy:J2 Preserve preparation and persistence teardown failures.
          throw new AggregateError(
            [cause, cleanupError],
            "Native preparation cleanup failed",
          );
        }
        throw cause;
      }
    },
  };
}
