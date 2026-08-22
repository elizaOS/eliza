/** Coordinates one leased manifest lifecycle while preserving the authority's generation and reset receipt. */

import { randomUUID } from "node:crypto";
import type {
  SyntheticControlClient,
  SyntheticControlCommandOptions,
} from "./client.js";
import { assertJsonValue, parseSyntheticControlRequest } from "./codec.js";
import type {
  JsonValue,
  SyntheticManifest,
  SyntheticResetReceipt,
} from "./types.js";
import { SyntheticControlProtocolError } from "./types.js";

function resultObject(
  value: JsonValue,
  label: string,
): Record<string, JsonValue> {
  assertJsonValue(value, label);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, JsonValue>;
}

function resultString(value: JsonValue | undefined, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

export interface OpenSyntheticControlSessionOptions {
  client: SyntheticControlClient;
  manifest: SyntheticManifest;
  owner?: string;
  leaseTtlMs?: number;
}

/** A lifecycle command crossed an ambiguous boundary, so automated cleanup cannot claim a clean world. */
export class SyntheticControlDirtySessionError extends Error {
  constructor(
    readonly leaseId: string,
    readonly lastKnownGeneration: number,
    cause: unknown,
  ) {
    super(
      `synthetic session may have mutated generation ${lastKnownGeneration}; lease ${leaseId} remains held for authoritative recovery or expiry`,
      { cause },
    );
    this.name = "SyntheticControlDirtySessionError";
  }
}

export class SyntheticControlSession {
  private currentGeneration: number;
  private state: "active" | "closing" | "closed" | "dirty" = "active";
  private operationTail: Promise<void> = Promise.resolve();
  private closePromise: Promise<void> | null = null;
  private resetComplete = false;
  private dirtyError: SyntheticControlDirtySessionError | null = null;

  private constructor(
    readonly client: SyntheticControlClient,
    readonly leaseId: string,
    readonly manifest: SyntheticManifest,
    readonly resetReceipt: SyntheticResetReceipt,
    generation: number,
  ) {
    this.currentGeneration = generation;
  }

  static async open(
    options: OpenSyntheticControlSessionOptions,
  ): Promise<SyntheticControlSession> {
    if (options.client.namespace !== options.manifest.namespace) {
      throw new Error(
        "synthetic control client namespace must match the session manifest namespace",
      );
    }
    parseSyntheticControlRequest({
      version: 1,
      namespace: options.manifest.namespace,
      commandId: "session-seed-preflight",
      command: { type: "seed", manifest: options.manifest },
    });
    const health = await options.client.command({ type: "health" });
    let acquired: Awaited<ReturnType<SyntheticControlClient["command"]>>;
    try {
      acquired = await options.client.command(
        {
          type: "lease.acquire",
          owner: options.owner ?? `harness-${randomUUID()}`,
          ttlMs: options.leaseTtlMs ?? 300_000,
        },
        { expectedGeneration: health.generation },
      );
    } catch (error) {
      // error-policy:J2 An ambiguous lease acquisition is surfaced as dirty because its lease id may be lost.
      if (
        error instanceof SyntheticControlProtocolError &&
        error.generation === health.generation
      ) {
        throw error;
      }
      throw new SyntheticControlDirtySessionError(
        "unknown",
        error instanceof SyntheticControlProtocolError
          ? (error.generation ?? health.generation)
          : health.generation,
        error,
      );
    }
    let leaseId: string;
    try {
      const lease = resultObject(acquired.data, "lease.acquire data");
      leaseId = resultString(lease.leaseId, "lease.acquire data.leaseId");
    } catch (error) {
      // error-policy:J2 A successful acquisition with an invalid receipt cannot be safely released.
      throw new SyntheticControlDirtySessionError(
        "unknown",
        acquired.generation,
        error,
      );
    }
    let observedGeneration = acquired.generation;
    try {
      const seeded = await options.client.command(
        { type: "seed", manifest: options.manifest },
        { expectedGeneration: acquired.generation, leaseId },
      );
      observedGeneration = seeded.generation;
      const data = resultObject(seeded.data, "seed data");
      const receipt = resultObject(data.receipt, "seed data.receipt");
      if (
        receipt.version !== 1 ||
        receipt.namespace !== options.manifest.namespace ||
        receipt.manifestId !== options.manifest.manifestId ||
        receipt.generation !== seeded.generation ||
        !("receipt" in receipt)
      ) {
        throw new Error(
          "seed returned a receipt that is not bound to the requested manifest and generation",
        );
      }
      return new SyntheticControlSession(
        options.client,
        leaseId,
        options.manifest,
        receipt as unknown as SyntheticResetReceipt,
        seeded.generation,
      );
    } catch (error) {
      // error-policy:J2 Seed failures retain the lease whenever mutation cannot be ruled out.
      if (
        error instanceof SyntheticControlProtocolError &&
        error.generation === acquired.generation
      ) {
        try {
          await options.client.command(
            { type: "lease.release", leaseId },
            { expectedGeneration: acquired.generation, leaseId },
          );
        } catch (releaseError) {
          // error-policy:J2 Failed cleanup after a proven non-mutating seed failure leaves a dirty lease.
          throw new SyntheticControlDirtySessionError(
            leaseId,
            acquired.generation,
            releaseError,
          );
        }
        throw error;
      }
      const reportedGeneration =
        error instanceof SyntheticControlProtocolError
          ? error.generation
          : undefined;
      throw new SyntheticControlDirtySessionError(
        leaseId,
        reportedGeneration ?? observedGeneration,
        error,
      );
    }
  }

  get generation(): number {
    return this.currentGeneration;
  }

  async execute(
    command: Parameters<SyntheticControlClient["command"]>[0],
    options: Pick<SyntheticControlCommandOptions, "signal"> = {},
  ): Promise<JsonValue> {
    if (this.state !== "active") {
      throw this.unavailableError();
    }
    if (
      command.type === "health" ||
      command.type.startsWith("lease.") ||
      command.type === "seed" ||
      command.type === "reset" ||
      command.type === "teardown"
    ) {
      throw new Error(
        `session.execute does not accept lifecycle command ${command.type}`,
      );
    }
    parseSyntheticControlRequest({
      version: 1,
      namespace: this.manifest.namespace,
      commandId: "session-command-preflight",
      command,
    });
    return this.enqueue(async () => {
      if (this.state === "dirty") throw this.unavailableError();
      const expectedGeneration = this.currentGeneration;
      try {
        const result = await this.client.command(command, {
          ...options,
          expectedGeneration,
          leaseId: this.leaseId,
        });
        this.currentGeneration = result.generation;
        return result.data;
      } catch (error) {
        // error-policy:J2 Ambiguous command outcomes poison the session instead of permitting unsafe cleanup.
        throw this.normalizeCommandFailure(error, expectedGeneration);
      }
    });
  }

  async close(
    options: { teardown?: boolean; reason?: string } = {},
  ): Promise<void> {
    if (this.state === "closed") return;
    if (this.state === "dirty") throw this.unavailableError();
    if (this.state === "closing") {
      if (!this.closePromise) {
        throw new Error(
          "synthetic control session close state is inconsistent",
        );
      }
      return this.closePromise;
    }
    this.state = "closing";
    const closing = this.enqueue(async () => {
      if (this.state === "dirty") throw this.unavailableError();
      try {
        if (!this.resetComplete) {
          const expectedGeneration = this.currentGeneration;
          const reset = await this.client
            .command(
              { type: "reset", receipt: this.resetReceipt },
              {
                expectedGeneration,
                leaseId: this.leaseId,
              },
            )
            .catch((error: unknown) => {
              // error-policy:J2 Reset failures are classified against the last authoritative generation.
              throw this.normalizeCommandFailure(error, expectedGeneration);
            });
          this.currentGeneration = reset.generation;
          this.resetComplete = true;
        }

        const expectedGeneration = this.currentGeneration;
        if (options.teardown) {
          const teardown = await this.client
            .command(
              {
                type: "teardown",
                reason: options.reason ?? "synthetic session complete",
              },
              { expectedGeneration, leaseId: this.leaseId },
            )
            .catch((error: unknown) => {
              // error-policy:J2 Teardown failures cannot be retried after an ambiguous lease release.
              throw this.normalizeCommandFailure(error, expectedGeneration);
            });
          this.currentGeneration = teardown.generation;
          const data = resultObject(teardown.data, "teardown data");
          if (data.leaseReleased !== true) {
            throw this.markDirty(
              new Error("teardown did not prove atomic lease release"),
              teardown.generation,
            );
          }
        } else {
          const released = await this.client
            .command(
              { type: "lease.release", leaseId: this.leaseId },
              { expectedGeneration, leaseId: this.leaseId },
            )
            .catch((error: unknown) => {
              // error-policy:J2 Release failures cannot be retried when the authority outcome is ambiguous.
              throw this.normalizeCommandFailure(error, expectedGeneration);
            });
          this.currentGeneration = released.generation;
          const data = resultObject(released.data, "lease.release data");
          if (data.released !== true) {
            throw this.markDirty(
              new Error("lease.release did not prove lease release"),
              released.generation,
            );
          }
        }
        this.state = "closed";
      } catch (error) {
        // error-policy:J2 A proven non-mutating close failure remains retryable; ambiguous failures stay dirty.
        if (!this.dirtyError) this.state = "active";
        throw error;
      }
    });
    this.closePromise = closing;
    try {
      await closing;
    } finally {
      if (this.state !== "closing") this.closePromise = null;
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation);
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private normalizeCommandFailure(
    error: unknown,
    expectedGeneration: number,
  ): unknown {
    if (
      error instanceof SyntheticControlProtocolError &&
      error.generation === expectedGeneration
    ) {
      return error;
    }
    return this.markDirty(
      error,
      error instanceof SyntheticControlProtocolError
        ? (error.generation ?? expectedGeneration)
        : expectedGeneration,
    );
  }

  private markDirty(
    cause: unknown,
    generation: number,
  ): SyntheticControlDirtySessionError {
    if (!this.dirtyError) {
      this.dirtyError = new SyntheticControlDirtySessionError(
        this.leaseId,
        generation,
        cause,
      );
    }
    this.state = "dirty";
    return this.dirtyError;
  }

  private unavailableError(): Error {
    if (this.dirtyError) return this.dirtyError;
    return new Error(`synthetic control session is ${this.state}`);
  }
}
