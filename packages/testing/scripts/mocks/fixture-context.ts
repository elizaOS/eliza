/** Per-world API fixture time and identity, without mutating process globals. */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";

interface FixtureContext {
  seed: string;
  sequence: number;
  now: number;
}
const context = new AsyncLocalStorage<FixtureContext>();

export function createFixtureScope(
  seed?: string,
): <T>(operation: () => T) => T {
  if (seed === undefined) return (operation) => operation();
  const state = {
    seed,
    sequence: 0,
    now: Date.parse("2026-01-01T00:00:00.000Z"),
  };
  return (operation) => context.run(state, operation);
}

export function fixtureNow(): number {
  return context.getStore()?.now ?? Date.now();
}

function nextBytes(): Buffer | undefined {
  const state = context.getStore();
  return state
    ? createHash("sha256")
        .update(`${state.seed}:${state.sequence++}`)
        .digest()
    : undefined;
}

export function fixtureUuid(): string {
  const bytes = nextBytes();
  if (!bytes) return randomUUID();
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function fixtureRandom(): number {
  const bytes = nextBytes();
  return bytes ? bytes.readUIntBE(0, 6) / 2 ** 48 : Math.random();
}
