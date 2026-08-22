/** Coordinates one leased manifest lifecycle while preserving the authority's generation and reset receipt. */

import { randomUUID } from "node:crypto";
import type { SyntheticControlClient } from "./client.js";
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

/** Seed crossed an ambiguous boundary, so automated release/reset cannot safely claim a clean world. */
export class SyntheticControlDirtySessionError extends Error {
  constructor(
    readonly leaseId: string,
    readonly lastKnownGeneration: number,
    cause: unknown,
  ) {
    super(
      `synthetic seed may have mutated generation ${lastKnownGeneration}; lease ${leaseId} remains held for authoritative recovery or expiry`,
      { cause },
    );
    this.name = "SyntheticControlDirtySessionError";
  }
}

export class SyntheticControlSession {
  private currentGeneration: number;
  private closed = false;

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
    parseSyntheticControlRequest({
      version: 1,
      commandId: "session-seed-preflight",
      command: { type: "seed", manifest: options.manifest },
    });
    const health = await options.client.command({ type: "health" });
    const acquired = await options.client.command(
      {
        type: "lease.acquire",
        owner: options.owner ?? `harness-${randomUUID()}`,
        ttlMs: options.leaseTtlMs ?? 60_000,
      },
      { expectedGeneration: health.generation },
    );
    const lease = resultObject(acquired.data, "lease.acquire data");
    const leaseId = resultString(lease.leaseId, "lease.acquire data.leaseId");
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
  ): Promise<JsonValue> {
    if (this.closed) throw new Error("synthetic control session is closed");
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
    const result = await this.client.command(command, {
      expectedGeneration: this.currentGeneration,
      leaseId: this.leaseId,
    });
    this.currentGeneration = result.generation;
    return result.data;
  }

  async close(
    options: { teardown?: boolean; reason?: string } = {},
  ): Promise<void> {
    if (this.closed) return;
    const reset = await this.client.command(
      { type: "reset", receipt: this.resetReceipt },
      { expectedGeneration: this.currentGeneration, leaseId: this.leaseId },
    );
    this.currentGeneration = reset.generation;
    if (options.teardown) {
      const teardown = await this.client.command(
        {
          type: "teardown",
          reason: options.reason ?? "synthetic session complete",
        },
        { expectedGeneration: this.currentGeneration, leaseId: this.leaseId },
      );
      const data = resultObject(teardown.data, "teardown data");
      if (data.leaseReleased !== true) {
        throw new SyntheticControlDirtySessionError(
          this.leaseId,
          teardown.generation,
          new Error("teardown did not prove atomic lease release"),
        );
      }
      this.currentGeneration = teardown.generation;
    } else {
      const released = await this.client.command(
        { type: "lease.release", leaseId: this.leaseId },
        { expectedGeneration: this.currentGeneration, leaseId: this.leaseId },
      );
      this.currentGeneration = released.generation;
    }
    this.closed = true;
  }
}
