/** Boots the real control-plane mock subprocess with a deterministic test-only synthetic-state authority. */

import {
  type JsonValue,
  type SyntheticControlAuthority,
  type SyntheticControlCommand,
  type SyntheticControlExecutionContext,
  SyntheticControlProtocolError,
  type SyntheticFault,
  type SyntheticManifest,
  type SyntheticResetReceipt,
} from "@elizaos/shared/synthetic-control";
import { startControlPlaneMock } from "../../src/control-plane/index.js";

const token = process.env.SYNTHETIC_CONTROL_TOKEN;
if (!token) throw new Error("SYNTHETIC_CONTROL_TOKEN is required");
const namespace = process.env.SYNTHETIC_CONTROL_NAMESPACE;
if (!namespace) throw new Error("SYNTHETIC_CONTROL_NAMESPACE is required");

class FixtureAuthority implements SyntheticControlAuthority {
  private currentGeneration = 0;
  private lease: { id: string; owner: string; expiresAt: number } | null = null;
  private manifest: SyntheticManifest | null = null;
  private faults: SyntheticFault[] = [];
  private logicalTimeMs = 0;
  private sequence = 0;
  private readonly entries: JsonValue[] = [];
  onTeardown: (() => void) | null = null;

  generation(): number {
    return this.currentGeneration;
  }

  async execute(
    command: SyntheticControlCommand,
    context: SyntheticControlExecutionContext,
  ): Promise<JsonValue> {
    if (command.type === "health") {
      return {
        status: "ready",
        pid: process.pid,
        capabilities: [
          "lease",
          "seed",
          "reset",
          "time",
          "fault",
          "snapshot",
          "ledger",
          "teardown",
        ],
      };
    }
    this.assertGeneration(context.expectedGeneration);
    if (command.type === "lease.acquire") {
      const now = Date.now();
      if (this.lease && this.lease.expiresAt > now) {
        throw new SyntheticControlProtocolError({
          code: "LEASE_CONFLICT",
          message: `lease is held by ${this.lease.owner}`,
          retryable: true,
        });
      }
      this.lease = {
        id: `lease-${process.pid}-${++this.sequence}`,
        owner: command.owner,
        expiresAt: now + command.ttlMs,
      };
      this.currentGeneration += 1;
      this.append("lease.acquire", { owner: command.owner });
      return { leaseId: this.lease.id, expiresAt: this.lease.expiresAt };
    }
    this.assertLease(context.leaseId);
    if (command.type === "lease.release") {
      if (command.leaseId !== this.lease?.id) this.leaseFailure();
      this.lease = null;
      this.currentGeneration += 1;
      this.append("lease.release", {});
      return { released: true };
    }

    const startGeneration = this.currentGeneration;
    await this.applyDelayFault(command.type, context.signal);
    this.assertGeneration(startGeneration);

    switch (command.type) {
      case "seed": {
        this.manifest = structuredClone(command.manifest);
        this.currentGeneration += 1;
        const receipt: SyntheticResetReceipt = {
          version: 1,
          namespace: command.manifest.namespace,
          manifestId: command.manifest.manifestId,
          generation: this.currentGeneration,
          receipt: { authority: "fixture", pid: process.pid },
        };
        this.append("seed", { manifestId: command.manifest.manifestId });
        return { receipt } as unknown as JsonValue;
      }
      case "reset":
        this.assertReceipt(command.receipt);
        this.manifest = null;
        this.faults = [];
        this.logicalTimeMs = 0;
        this.currentGeneration += 1;
        this.append("reset", { manifestId: command.receipt.manifestId });
        return { reset: true };
      case "time.advance":
        this.logicalTimeMs += command.milliseconds;
        this.currentGeneration += 1;
        this.append("time.advance", { milliseconds: command.milliseconds });
        return { logicalTimeMs: this.logicalTimeMs };
      case "fault.install":
        this.faults.push(structuredClone(command.fault));
        this.currentGeneration += 1;
        this.append("fault.install", { faultId: command.fault.id });
        return { installed: command.fault.id };
      case "fault.clear":
        this.faults = command.scope
          ? this.faults.filter((fault) => fault.scope !== command.scope)
          : [];
        this.currentGeneration += 1;
        this.append("fault.clear", { scope: command.scope ?? null });
        return { cleared: true };
      case "snapshot":
        return {
          generation: this.currentGeneration,
          manifest: this.manifest,
          logicalTimeMs: this.logicalTimeMs,
          faultIds: this.faults.map((fault) => fault.id),
        } as unknown as JsonValue;
      case "ledger.query": {
        const after = command.afterSequence ?? 0;
        const limit = command.limit ?? 100;
        return {
          entries: this.entries.slice(after, after + limit),
          nextSequence: Math.min(this.entries.length, after + limit),
        };
      }
      case "teardown":
        this.lease = null;
        this.currentGeneration += 1;
        this.append("teardown", { reason: command.reason });
        setTimeout(() => this.onTeardown?.(), 10);
        return { accepted: true, leaseReleased: true };
      default:
        throw new SyntheticControlProtocolError({
          code: "UNSUPPORTED_COMMAND",
          message: "fixture received an unsupported command",
        });
    }
  }

  private assertGeneration(expected: number | undefined): void {
    if (expected !== this.currentGeneration) {
      throw new SyntheticControlProtocolError({
        code: "STALE_GENERATION",
        message: `expected generation ${String(expected)}, current ${this.currentGeneration}`,
        retryable: true,
      });
    }
  }

  private assertLease(leaseId: string | undefined): void {
    if (
      !this.lease ||
      this.lease.expiresAt <= Date.now() ||
      leaseId !== this.lease.id
    ) {
      this.leaseFailure();
    }
  }

  private leaseFailure(): never {
    throw new SyntheticControlProtocolError({
      code: "LEASE_REQUIRED",
      message: "the active lease is required",
      retryable: true,
    });
  }

  private assertReceipt(receipt: SyntheticResetReceipt): void {
    if (
      !this.manifest ||
      receipt.namespace !== this.manifest.namespace ||
      receipt.manifestId !== this.manifest.manifestId
    ) {
      throw new SyntheticControlProtocolError({
        code: "COMMAND_FAILED",
        message: "reset receipt does not match active manifest",
      });
    }
  }

  private async applyDelayFault(
    operation: string,
    signal: AbortSignal,
  ): Promise<void> {
    const fault = this.faults.find(
      (candidate) =>
        candidate.mode === "delay" &&
        candidate.scope === "control" &&
        candidate.operation === operation &&
        candidate.count > 0,
    );
    if (!fault) return;
    fault.count -= 1;
    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, fault.delayMs ?? 100);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private append(operation: string, data: JsonValue): void {
    this.entries.push({
      sequence: this.entries.length + 1,
      generation: this.currentGeneration,
      operation,
      data,
    });
  }
}

const authority = new FixtureAuthority();
const running = await startControlPlaneMock({
  port: 0,
  tickMs: 0,
  hetznerUrl: "http://127.0.0.1:1/v1",
  syntheticControl: { namespace, token, authority },
});
authority.onTeardown = () => {
  void running.stop().finally(() => process.exit(0));
};

process.stdout.write(
  `${JSON.stringify({ type: "ready", url: running.url, pid: process.pid })}\n`,
);

const stop = () => void running.stop().finally(() => process.exit(0));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
