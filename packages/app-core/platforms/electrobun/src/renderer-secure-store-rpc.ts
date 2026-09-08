/** Owns the desktop renderer's four credential slots through the native transaction ledger, including legacy callers and conditional publication requests. */
import { mkdirSync } from "node:fs";
import type {
  RendererSecureTransactionRequest,
  RendererSecureTransactionResult,
} from "@elizaos/shared/types";
import type { PlatformSecureStore } from "../../../src/security/platform-secure-store";
import { RendererSecureStoreLedger } from "../../../src/security/renderer-secure-store-ledger";
import {
  type RendererSecureReceipt,
  type RendererSecureSlot,
  type RendererSecureSnapshot,
  RendererSecureStoreTransactions,
} from "../../../src/security/renderer-secure-store-transactions";

export type {
  RendererSecureTransactionRequest,
  RendererSecureTransactionResult,
} from "@elizaos/shared/types";

const kinds = new Set([
  "session.device_auth",
  "session.steward_token",
  "runtime.active_server",
  "runtime.agent_profiles",
]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function identity(input: unknown): string {
  if (typeof input !== "string" || !uuid.test(input))
    throw new Error("Native operation identity is invalid");
  return input;
}
function kind(value: unknown): RendererSecureSlot {
  if (typeof value !== "string" || !kinds.has(value))
    throw new Error("Native credential slot is not allowed");
  return value as RendererSecureSlot;
}
function value(input: unknown): string {
  if (
    typeof input !== "string" ||
    !input ||
    Buffer.byteLength(input, "utf8") > 256 * 1024
  )
    throw new Error("Native credential value is missing or too large");
  return input;
}
function object(input: unknown): input is Record<string, unknown> {
  return input !== null && typeof input === "object" && !Array.isArray(input);
}
function snapshot(input: unknown): RendererSecureSnapshot {
  if (
    !object(input) ||
    typeof input.revision !== "string" ||
    (input.value !== null && typeof input.value !== "string") ||
    !object(input.authority)
  )
    throw new Error("Native authority snapshot is invalid");
  const authority = input.authority;
  if (input.revision !== "legacy" && input.revision !== "absent")
    identity(input.revision);
  if (input.value !== null) value(input.value);
  if (Object.keys(authority).length !== kinds.size)
    throw new Error("Native authority snapshot is invalid");
  for (const key of kinds)
    if (
      typeof authority[key] !== "string" ||
      !/^[0-9a-f]{64}$/.test(authority[key])
    )
      throw new Error("Native authority snapshot is incomplete");
  return {
    revision: input.revision,
    value: input.value,
    authority: { ...authority } as RendererSecureSnapshot["authority"],
  };
}
function receipt(input: unknown): RendererSecureReceipt {
  if (
    !object(input) ||
    typeof input.operationId !== "string" ||
    typeof input.revision !== "string" ||
    !["pending", "committed", "sealed", "rolled-back"].includes(
      String(input.state),
    )
  )
    throw new Error("Native transaction receipt is invalid");
  return {
    operationId: identity(input.operationId),
    revision: identity(input.revision),
    state: input.state as RendererSecureReceipt["state"],
  };
}

/** Trusted composition inputs only; no renderer chooses a directory, vault or backend. */
export function createRendererSecureStoreRpc(options: {
  directory: string;
  vault: string;
  store: Pick<PlatformSecureStore, "get" | "set">;
}) {
  let host: Promise<RendererSecureStoreTransactions> | undefined;
  function load(): Promise<RendererSecureStoreTransactions> {
    if (!host) {
      const initialize = async () => {
        mkdirSync(options.directory, { recursive: true, mode: 0o700 });
        const ledger = new RendererSecureStoreLedger(
          options.directory,
          options.store,
        );
        await ledger.migrateLegacy(options.vault);
        return new RendererSecureStoreTransactions(ledger.store, ledger);
      };
      host = initialize().catch((error) => {
        // error-policy:J2 retry rechecks the protected migration anchor; no raw fallback.
        host = undefined;
        throw error;
      });
    }
    return host;
  }
  return {
    secureStoreGet: async (params: { kind: unknown }) => {
      const selected = kind(params?.kind);
      const current = await (await load()).read(options.vault, selected);
      return current.value === null
        ? { ok: false as const, reason: "not_found" as const }
        : { ok: true as const, value: current.value };
    },
    secureStoreSet: async (params: { kind: unknown; value: unknown }) => {
      const selected = kind(params?.kind),
        next = value(params?.value);
      await (await load()).write(options.vault, selected, next);
      return { ok: true as const };
    },
    secureStoreDelete: async (params: { kind: unknown }) => {
      const selected = kind(params?.kind);
      await (await load()).write(options.vault, selected, null);
      return { ok: true as const };
    },
    secureStoreTransaction: async (
      params: RendererSecureTransactionRequest,
    ): Promise<RendererSecureTransactionResult> => {
      if (!object(params))
        throw new Error("Native transaction request is invalid");
      const selected = kind(params.kind);
      // Validate and copy transport DTOs before loading/migrating any native state.
      switch (params.operation) {
        case "read":
          return {
            operation: "read",
            snapshot: await (await load()).read(options.vault, selected),
          };
        case "prepare": {
          const expected = snapshot(params.expected),
            next = params.value === null ? null : value(params.value);
          const operationId = identity(params.operationId);
          return {
            operation: "prepare",
            receipt: await (await load()).prepare(
              options.vault,
              selected,
              expected,
              next,
              operationId,
            ),
          };
        }
        case "lookup": {
          const operationId = identity(params.operationId);
          return {
            operation: "lookup",
            receipt: await (await load()).lookup(
              options.vault,
              selected,
              operationId,
            ),
          };
        }
        case "commit":
        case "seal":
        case "rollback": {
          const token = receipt(params.receipt),
            operation = params.operation;
          const protocol = await load();
          if (operation === "rollback") {
            await protocol.rollback(options.vault, selected, token);
            return { operation };
          }
          return {
            operation,
            snapshot: await protocol[operation](options.vault, selected, token),
          };
        }
        default:
          throw new Error("Native transaction operation is not allowed");
      }
    },
  };
}
