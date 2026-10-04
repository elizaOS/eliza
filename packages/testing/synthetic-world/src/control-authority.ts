/** Adapts the existing control protocol to real leased API mock worlds. */
import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type {
  SyntheticEnvironmentLeaseAuthority,
  SyntheticEnvironmentLeaseStore,
} from "@elizaos/contracts";
import { canonicalJson } from "../../evidence/canonical.ts";
import { assertJsonValue } from "../../src/synthetic-control/codec.ts";
import type {
  JsonValue,
  SyntheticControlAuthority,
  SyntheticControlCommand,
  SyntheticControlExecutionContext,
  SyntheticManifest,
  SyntheticResetReceipt,
} from "../../src/synthetic-control/types.ts";
import { SyntheticControlProtocolError } from "../../src/synthetic-control/types.ts";
import {
  parseSyntheticScenarioManifest,
  type SyntheticScenarioWorld,
  startSyntheticScenarioWorld,
} from "./scenario-world.ts";

export interface SyntheticWorldControlAuthority
  extends SyntheticControlAuthority {
  close(): Promise<void>;
}

/** One authority owns the lease; the mock world borrows it and never creates a parallel lease. */
export function createSyntheticWorldControlAuthority<T>(options: {
  namespace: string;
  leaseStore: SyntheticEnvironmentLeaseStore<T>;
}): SyntheticWorldControlAuthority {
  // Ephemeral worlds replay within this owner process only. Transactional
  // production commands use the durable journal, never this in-memory cache.
  const commands = new Map<
    string,
    {
      fingerprint: string;
      generation: number;
      result?: JsonValue;
      error?: unknown;
    }
  >();
  let authority: SyntheticEnvironmentLeaseAuthority | undefined;
  let world: SyntheticScenarioWorld | undefined;
  let manifest: SyntheticManifest | undefined;
  let receipt: SyntheticResetReceipt | undefined;
  let leaseDurationMs = 300_000;
  let tail: Promise<unknown> = Promise.resolve();
  const generation = async () =>
    (await options.leaseStore.read(options.namespace))?.generation ?? 0;
  const enqueue = <R>(run: () => Promise<R>): Promise<R> => {
    const result = tail.then(run);
    tail = result.catch(() => undefined);
    return result;
  };
  function fail(
    code: ConstructorParameters<
      typeof SyntheticControlProtocolError
    >[0]["code"],
    message: string,
  ): never {
    throw new SyntheticControlProtocolError({ code, message });
  }
  const closeWorld = async (verify: boolean) => {
    const active = world;
    if (!active) return;
    const failures: unknown[] = [];
    if (verify) {
      try {
        active.assertComplete();
      } catch (error) {
        // error-policy:J6 Proof failure cannot prevent owned server cleanup.
        failures.push(error);
      }
    }
    try {
      await active.close();
    } catch (error) {
      // error-policy:J6 Surface both incomplete evidence and cleanup failures.
      failures.push(error);
    }
    world = undefined;
    if (failures.length === 1) throw failures[0];
    if (failures.length)
      throw new AggregateError(failures, "World proof and cleanup failed");
  };
  const close = async () => {
    const failures: unknown[] = [];
    try {
      await closeWorld(false);
    } catch (error) {
      // error-policy:J6 World shutdown does not suppress authoritative lease release.
      failures.push(error);
    }
    world = undefined;
    if (authority) {
      try {
        await options.leaseStore.release(authority);
        authority = undefined;
      } catch (error) {
        // error-policy:J6 Preserve release failure for recovery instead of claiming a clean world.
        failures.push(error);
      }
    }
    if (failures.length)
      throw new AggregateError(failures, "Synthetic control teardown failed");
  };
  const execute = async (
    command: SyntheticControlCommand,
    context: SyntheticControlExecutionContext,
  ): Promise<JsonValue> => {
    context.signal.throwIfAborted();
    if (context.namespace !== options.namespace)
      fail("INVALID_REQUEST", "Control namespace does not match authority");
    const current = await generation();
    if (command.type === "health")
      return {
        status: "ready",
        capabilities: [
          "lease",
          "seed",
          "reset",
          "fault",
          "snapshot",
          "ledger",
          "teardown",
        ],
        unavailable: ["virtual-clock", "atomic-production-domain-command"],
      };
    if (context.expectedGeneration !== current)
      fail("STALE_GENERATION", "Control generation is stale");
    if (command.type === "lease.acquire") {
      leaseDurationMs = command.ttlMs;
      try {
        const acquired = await options.leaseStore.acquire({
          namespace: options.namespace,
          owner: {
            ownerId: `control-${createHash("sha256").update(command.owner).digest("hex")}`,
            processId: process.pid,
            host: hostname(),
          },
          leaseDurationMs,
        });
        authority = acquired.authority;
        return {
          leaseId: authority.leaseId,
          expiresAt: acquired.snapshot.expiresAt,
        };
      } catch (error) {
        // error-policy:J1 Map the lease store's explicit collision; other failures remain visible.
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "SYNTHETIC_LEASE_COLLISION"
        )
          fail("LEASE_CONFLICT", "World lease is already held");
        throw error;
      }
    }
    if (!authority || context.leaseId !== authority.leaseId)
      fail("LEASE_REQUIRED", "Active world lease is required");
    await options.leaseStore.withActiveGeneration(authority, () => undefined);
    if (command.type === "lease.release") {
      if (command.leaseId !== authority.leaseId)
        fail("LEASE_REQUIRED", "Lease release identity does not match");
      if (world)
        fail("COMMAND_FAILED", "Reset the world before releasing its lease");
      await options.leaseStore.release(authority);
      authority = undefined;
      return { released: true };
    }
    if (command.type === "seed") {
      if (command.manifest.namespace !== options.namespace)
        fail("INVALID_REQUEST", "Manifest namespace does not match authority");
      parseSyntheticScenarioManifest(command.manifest);
      if (world)
        fail("COMMAND_FAILED", "Reset the active world before reseeding");
      authority = (
        await options.leaseStore.rollover({ authority, leaseDurationMs })
      ).authority;
      try {
        world = await startSyntheticScenarioWorld({
          manifest: command.manifest,
          initializationSignal: context.signal,
          leaseStore: options.leaseStore,
          authority,
          leaseDurationMs,
        });
      } catch (error) {
        // error-policy:J6 The client has not received the rotated lease ID; release it here.
        try {
          await options.leaseStore.release(authority);
          authority = undefined;
        } catch (releaseError) {
          throw new AggregateError(
            [error, releaseError],
            "Synthetic seeding and lease rollback failed",
          );
        }
        throw error;
      }
      manifest = structuredClone(command.manifest);
      receipt = {
        version: 1,
        namespace: options.namespace,
        manifestId: manifest.manifestId,
        generation: authority.generation,
        receipt: randomUUID(),
      };
      return {
        receipt: { ...receipt },
        leaseId: authority.leaseId,
        settings: { ...world.settings },
        endpoints: { ...world.endpoints },
      };
    }
    if (command.type === "reset") {
      if (
        !receipt ||
        command.receipt.namespace !== receipt.namespace ||
        command.receipt.manifestId !== receipt.manifestId ||
        command.receipt.generation !== receipt.generation ||
        command.receipt.receipt !== receipt.receipt
      )
        fail("INVALID_REQUEST", "Reset receipt does not own this world");
      await closeWorld(true);
      manifest = undefined;
      receipt = undefined;
      authority = (
        await options.leaseStore.rollover({ authority, leaseDurationMs })
      ).authority;
      return { reset: true, leaseId: authority.leaseId };
    }
    if (command.type === "teardown") {
      await close();
      return { leaseReleased: true };
    }
    if (!world)
      fail("COMMAND_FAILED", "Seed a world before issuing domain commands");
    switch (command.type) {
      case "fault.install":
        await world.installFault(command.fault);
        return { installed: command.fault.id };
      case "fault.clear":
        await world.clearFaults(command.scope);
        return { cleared: true };
      case "snapshot":
        return { generation: authority.generation, state: world.snapshot() };
      case "ledger.query": {
        const entries = world.requestLedger();
        const start = command.afterSequence ?? 0;
        const pending = entries.filter(
          (entry) => (entry.sequence ?? 0) > start,
        );
        const selected =
          command.limit === undefined
            ? pending
            : pending.slice(0, command.limit);
        const data = {
          entries: selected,
          nextSequence: selected.at(-1)?.sequence ?? start,
          complete: selected.length === pending.length,
        };
        assertJsonValue(data, "world request ledger");
        return data;
      }
      case "time.advance":
        return fail(
          "UNSUPPORTED_COMMAND",
          "Virtual time is not implemented by these API mocks",
        );
    }
  };
  return {
    generation,
    execute: (command, context) =>
      enqueue(async () => {
        context.signal.throwIfAborted();
        const fingerprint = canonicalJson({
          namespace: context.namespace,
          leaseId: context.leaseId,
          expectedGeneration: context.expectedGeneration,
          command,
        });
        const existing = commands.get(context.commandId);
        if (existing) {
          if (existing.fingerprint !== fingerprint)
            fail(
              "INVALID_REQUEST",
              "Command ID was reused with different input",
            );
          if (existing.generation !== (await generation()))
            fail(
              "STALE_GENERATION",
              "Command belongs to an obsolete world generation",
            );
          if (authority)
            await options.leaseStore.withActiveGeneration(
              authority,
              () => undefined,
            );
          if ("error" in existing) throw existing.error;
          if (!("result" in existing))
            fail("COMMAND_FAILED", "Recorded command has no outcome");
          return structuredClone(existing.result as JsonValue);
        }
        try {
          const result = await execute(command, context);
          commands.set(context.commandId, {
            fingerprint,
            generation: await generation(),
            result: structuredClone(result),
          });
          return result;
        } catch (error) {
          // error-policy:J2 Remember ambiguous failures in this owner; never repeat a possibly applied mutation.
          commands.set(context.commandId, {
            fingerprint,
            generation: await generation(),
            error,
          });
          throw error;
        }
      }),
    close: () => enqueue(close),
  };
}
