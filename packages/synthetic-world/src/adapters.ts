/**
 * Carries one validated world contract across in-process, scenario-runner, and
 * Cloud sidecar boundaries without coupling the world to a transport server.
 */
import { canonicalJson, payloadHash } from "./canonical.ts";
import {
  type JsonValue,
  parseWorldManifest,
  type WorldManifest,
} from "./manifest.ts";
import { createWorkerNamespace } from "./namespace.ts";
import { SyntheticWorld, type WorldSnapshot } from "./world.ts";

export const SYNTHETIC_WORLD_BOOTSTRAP_VERSION = "1" as const;
export const SYNTHETIC_WORLD_BOOTSTRAP_ENV =
  "ELIZA_SYNTHETIC_WORLD_BOOTSTRAP" as const;

export type SyntheticWorldProfile =
  | "in-process"
  | "scenario-runner"
  | "cloud-e2e";

export interface ProcessBootstrap {
  readonly bootstrapVersion: typeof SYNTHETIC_WORLD_BOOTSTRAP_VERSION;
  readonly profile: SyntheticWorldProfile;
  readonly namespace: string;
  readonly manifest: WorldManifest;
  readonly manifestHash: string;
}

export interface BootWorldOptions {
  readonly namespace?: string;
  readonly workerId?: string;
  readonly runId?: string;
}

function resolveNamespace(
  manifest: WorldManifest,
  profile: SyntheticWorldProfile,
  options: BootWorldOptions,
): string {
  if (options.namespace) return options.namespace;
  return createWorkerNamespace(
    manifest.worldId,
    options.workerId ?? profile,
    options.runId ?? "default",
  );
}

export function bootInProcessWorld(
  manifestInput: WorldManifest,
  options: BootWorldOptions = {},
): SyntheticWorld {
  const manifest = parseWorldManifest(manifestInput);
  return new SyntheticWorld(
    manifest,
    resolveNamespace(manifest, "in-process", options),
  );
}

export function createProcessBootstrap(
  manifestInput: WorldManifest,
  profile: Exclude<SyntheticWorldProfile, "in-process">,
  options: BootWorldOptions = {},
): ProcessBootstrap {
  const manifest = parseWorldManifest(manifestInput);
  return {
    bootstrapVersion: SYNTHETIC_WORLD_BOOTSTRAP_VERSION,
    profile,
    namespace: resolveNamespace(manifest, profile, options),
    manifest,
    manifestHash: payloadHash(manifest as unknown as JsonValue),
  };
}

export function serializeProcessBootstrap(bootstrap: ProcessBootstrap): string {
  return Buffer.from(
    canonicalJson(bootstrap as unknown as JsonValue),
    "utf8",
  ).toString("base64url");
}

export function parseProcessBootstrap(encoded: string): ProcessBootstrap {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch (cause) {
    // error-policy:J3 Process input is rejected explicitly instead of producing a partial world.
    throw new Error("Invalid synthetic-world process bootstrap encoding", {
      cause,
    });
  }
  if (typeof value !== "object" || value === null)
    throw new Error("Synthetic-world bootstrap must be an object");
  const candidate = value as Record<string, unknown>;
  if (candidate.bootstrapVersion !== SYNTHETIC_WORLD_BOOTSTRAP_VERSION) {
    throw new Error(
      `Unsupported synthetic-world bootstrap version: ${String(candidate.bootstrapVersion)}`,
    );
  }
  if (
    candidate.profile !== "scenario-runner" &&
    candidate.profile !== "cloud-e2e"
  ) {
    throw new Error(
      `Unsupported synthetic-world profile: ${String(candidate.profile)}`,
    );
  }
  if (typeof candidate.namespace !== "string")
    throw new Error("Synthetic-world bootstrap namespace is required");
  const manifest = parseWorldManifest(candidate.manifest);
  const manifestHash = payloadHash(manifest as unknown as JsonValue);
  if (candidate.manifestHash !== manifestHash)
    throw new Error("Synthetic-world bootstrap manifest hash mismatch");
  return {
    bootstrapVersion: SYNTHETIC_WORLD_BOOTSTRAP_VERSION,
    profile: candidate.profile,
    namespace: candidate.namespace,
    manifest,
    manifestHash,
  };
}

export function bootWorldFromProcessBootstrap(
  input: string | ProcessBootstrap,
): SyntheticWorld {
  const bootstrap =
    typeof input === "string"
      ? parseProcessBootstrap(input)
      : parseProcessBootstrap(serializeProcessBootstrap(input));
  return new SyntheticWorld(bootstrap.manifest, bootstrap.namespace);
}

export function processBootstrapEnvironment(
  bootstrap: ProcessBootstrap,
): Readonly<Record<string, string>> {
  return {
    [SYNTHETIC_WORLD_BOOTSTRAP_ENV]: serializeProcessBootstrap(bootstrap),
  };
}

export function bootWorldFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): SyntheticWorld {
  const encoded = environment[SYNTHETIC_WORLD_BOOTSTRAP_ENV];
  if (!encoded) throw new Error(`${SYNTHETIC_WORLD_BOOTSTRAP_ENV} is required`);
  return bootWorldFromProcessBootstrap(encoded);
}

export type ControlRequest =
  | { readonly operation: "state" }
  | { readonly operation: "snapshot" }
  | { readonly operation: "restore"; readonly snapshot: WorldSnapshot }
  | { readonly operation: "reset" }
  | { readonly operation: "advanceBy"; readonly durationMs: number }
  | { readonly operation: "ledger" };

export type ControlResponse =
  | {
      readonly operation: "state";
      readonly stateHash: string;
      readonly now: string;
    }
  | { readonly operation: "snapshot"; readonly snapshot: WorldSnapshot }
  | { readonly operation: "restore" | "reset"; readonly stateHash: string }
  | {
      readonly operation: "advanceBy";
      readonly callbacks: number;
      readonly now: string;
    }
  | {
      readonly operation: "ledger";
      readonly entries: ReturnType<SyntheticWorld["ledger"]["all"]>;
    };

export interface SyntheticWorldControlBoundary {
  handle(request: ControlRequest): Promise<ControlResponse>;
}

export class SyntheticWorldControlAdapter
  implements SyntheticWorldControlBoundary
{
  public constructor(private readonly world: SyntheticWorld) {}

  public async handle(request: ControlRequest): Promise<ControlResponse> {
    switch (request.operation) {
      case "state":
        return {
          operation: "state",
          stateHash: this.world.stateHash,
          now: this.world.clock.nowIso(),
        };
      case "snapshot":
        return { operation: "snapshot", snapshot: this.world.snapshot() };
      case "restore":
        this.world.restore(request.snapshot);
        return { operation: "restore", stateHash: this.world.stateHash };
      case "reset":
        this.world.reset();
        return { operation: "reset", stateHash: this.world.stateHash };
      case "advanceBy": {
        const callbacks = await this.world.clock.advanceBy(request.durationMs);
        return {
          operation: "advanceBy",
          callbacks,
          now: this.world.clock.nowIso(),
        };
      }
      case "ledger":
        return { operation: "ledger", entries: this.world.ledger.all() };
    }
  }
}
