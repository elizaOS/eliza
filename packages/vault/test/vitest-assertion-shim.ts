import "vitest";
import type { MasterKeyResolver } from "../src/master-key.js";
import type { Vault } from "../src/vault-types.js";

declare module "vitest" {
  // biome-ignore lint/suspicious/noExplicitAny: must match Vitest's Assertion generic.
  interface Assertion<T = any> {
    readonly not: Assertion<T>;
  }
}

export interface RuntimeVaultCaller {
  set(key: unknown, value: unknown, opts?: unknown): Promise<void>;
  setReference(key: unknown, ref: unknown): Promise<void>;
}

export type RuntimePassphraseMasterKeyCaller = (opts: {
  readonly passphrase: unknown;
  readonly salt?: unknown;
  readonly cost?: unknown;
  readonly service?: unknown;
}) => MasterKeyResolver;

export function runtimeVaultCaller(vault: Vault): RuntimeVaultCaller {
  return vault as unknown as RuntimeVaultCaller;
}

export function runtimePassphraseMasterKeyCaller(
  passphraseMasterKey: (opts: {
    readonly passphrase: string;
    readonly salt?: string;
    readonly cost?: number;
    readonly service?: string;
  }) => MasterKeyResolver,
): RuntimePassphraseMasterKeyCaller {
  return passphraseMasterKey as unknown as RuntimePassphraseMasterKeyCaller;
}
