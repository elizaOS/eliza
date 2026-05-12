/// <reference types="bun-types" />
import { existsSync } from "node:fs";
import path from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import type { FeatureResult, IPermissionsRegistry } from "@elizaos/shared";

export const NATIVE_APPLE_REMINDER_METADATA_KEY = "nativeAppleReminder";
const PERMISSIONS_REGISTRY_SERVICE = "eliza_permissions_registry";

export type NativeAppleReminderLikeKind = "alarm" | "reminder";

type NativeAppleReminderMetadata = {
  kind: NativeAppleReminderLikeKind;
  provider: "apple_reminders";
  reminderId?: string | null;
  source: "heuristic" | "llm";
};

export function buildNativeAppleReminderMetadata(args: {
  kind: NativeAppleReminderLikeKind;
  reminderId?: string | null;
  source: "heuristic" | "llm";
}): Record<string, unknown> {
  return {
    [NATIVE_APPLE_REMINDER_METADATA_KEY]: {
      kind: args.kind,
      provider: "apple_reminders",
      reminderId:
        typeof args.reminderId === "string" && args.reminderId.trim().length > 0
          ? args.reminderId.trim()
          : null,
      source: args.source,
    } satisfies NativeAppleReminderMetadata,
  };
}

export function readNativeAppleReminderMetadata(
  metadata: unknown,
): NativeAppleReminderMetadata | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }
  const value = (metadata as Record<string, unknown>)[
    NATIVE_APPLE_REMINDER_METADATA_KEY
  ];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const kind =
    record.kind === "alarm" || record.kind === "reminder" ? record.kind : null;
  const source =
    record.source === "llm" || record.source === "heuristic"
      ? record.source
      : null;
  if (kind === null || source === null) {
    return null;
  }
  const reminderId =
    typeof record.reminderId === "string" && record.reminderId.trim().length > 0
      ? record.reminderId.trim()
      : null;
  return {
    kind,
    provider: "apple_reminders",
    reminderId,
    source,
  };
}

function reminderEpochSeconds(dueAt: string): number | null {
  const date = new Date(dueAt);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.getTime() / 1000;
}

function buildReminderNotes(args: {
  kind: NativeAppleReminderLikeKind;
  notes?: string | null;
  originalIntent?: string | null;
}): string {
  const parts = [
    args.notes?.trim() ?? "",
    args.originalIntent?.trim()
      ? `Eliza request: ${args.originalIntent.trim()}`
      : "",
  ].filter((value) => value.length > 0);
  if (parts.length > 0) {
    return parts.join("\n\n");
  }
  return args.kind === "alarm"
    ? "Created by Eliza as an alarm-like reminder."
    : "Created by Eliza.";
}

function appleReminderPriority(kind: NativeAppleReminderLikeKind): number {
  return kind === "alarm" ? 1 : 5;
}

type NativeReminderPayload = {
  error?: string;
  message?: string;
  ok: boolean;
  reminderId?: string | null;
};

type NativeReminderBridge = {
  create(args: {
    dueAtSeconds: number;
    notes: string;
    priority: number;
    title: string;
  }): string | null;
  delete(reminderId: string): string | null;
  update(args: {
    dueAtSeconds: number;
    notes: string;
    priority: number;
    reminderId: string;
    title: string;
  }): string | null;
};

let nativeReminderBridge: NativeReminderBridge | null | undefined;
let nativeReminderBridgeOverride: NativeReminderBridge | null | undefined;

const NATIVE_DYLIB_CANDIDATES = [
  process.env.MILADY_NATIVE_PERMISSIONS_DYLIB ?? "",
  "../../../../packages/app-core/platforms/electrobun/src/libMacWindowEffects.dylib",
].filter(Boolean);

function cStringBuffer(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  const buffer = Buffer.alloc(bytes.byteLength + 1);
  bytes.copy(buffer);
  return buffer;
}

async function loadNativeReminderBridge(): Promise<NativeReminderBridge | null> {
  if (nativeReminderBridgeOverride !== undefined) {
    return nativeReminderBridgeOverride;
  }
  if (nativeReminderBridge !== undefined) return nativeReminderBridge;
  nativeReminderBridge = null;
  if (process.platform !== "darwin") return null;

  for (const candidate of NATIVE_DYLIB_CANDIDATES) {
    const dylibPath = path.isAbsolute(candidate)
      ? candidate
      : path.resolve(import.meta.dir, candidate);
    if (!existsSync(dylibPath)) continue;
    try {
      const { CString, FFIType, dlopen, ptr } = await import("bun:ffi");
      const lib = dlopen(dylibPath, {
        createAppleReminderJson: {
          args: [FFIType.ptr, FFIType.ptr, FFIType.f64, FFIType.i32],
          returns: FFIType.ptr,
        },
        updateAppleReminderJson: {
          args: [
            FFIType.ptr,
            FFIType.ptr,
            FFIType.ptr,
            FFIType.f64,
            FFIType.i32,
          ],
          returns: FFIType.ptr,
        },
        deleteAppleReminderJson: {
          args: [FFIType.ptr],
          returns: FFIType.ptr,
        },
        freeNativeCString: { args: [FFIType.ptr], returns: FFIType.void },
      });

      const takeNativeString = (value: unknown): string | null => {
        if (!value) return null;
        try {
          return new CString(value as never).toString();
        } finally {
          lib.symbols.freeNativeCString(value as never);
        }
      };

      nativeReminderBridge = {
        create(args) {
          const title = cStringBuffer(args.title);
          const notes = cStringBuffer(args.notes);
          return takeNativeString(
            lib.symbols.createAppleReminderJson(
              ptr(title),
              ptr(notes),
              args.dueAtSeconds,
              args.priority,
            ),
          );
        },
        update(args) {
          const reminderId = cStringBuffer(args.reminderId);
          const title = cStringBuffer(args.title);
          const notes = cStringBuffer(args.notes);
          return takeNativeString(
            lib.symbols.updateAppleReminderJson(
              ptr(reminderId),
              ptr(title),
              ptr(notes),
              args.dueAtSeconds,
              args.priority,
            ),
          );
        },
        delete(reminderId) {
          const id = cStringBuffer(reminderId);
          return takeNativeString(lib.symbols.deleteAppleReminderJson(ptr(id)));
        },
      };
      return nativeReminderBridge;
    } catch {
      // Try the next dylib candidate.
    }
  }
  return null;
}

function parseNativeReminderPayload(raw: string | null): NativeReminderPayload {
  if (!raw) {
    return {
      ok: false,
      error: "native_error",
      message: "Native Apple Reminders bridge returned no response.",
    };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<NativeReminderPayload>;
    return {
      ok: parsed.ok === true,
      error: typeof parsed.error === "string" ? parsed.error : undefined,
      message: typeof parsed.message === "string" ? parsed.message : undefined,
      reminderId:
        typeof parsed.reminderId === "string" ? parsed.reminderId : null,
    };
  } catch {
    return {
      ok: false,
      error: "native_error",
      message: "Native Apple Reminders bridge returned invalid JSON.",
    };
  }
}

function getRegistryFromRuntime(
  runtime: IAgentRuntime | null | undefined,
): IPermissionsRegistry | null {
  if (!runtime) return null;
  const service = runtime.getService(PERMISSIONS_REGISTRY_SERVICE);
  if (!service) return null;
  // The registry is registered under its serviceType. The Service base type
  // doesn't carry the IPermissionsRegistry shape, so cast through unknown.
  return service as unknown as IPermissionsRegistry;
}

function buildPermissionFailure(
  runtime: IAgentRuntime | null | undefined,
  action: string,
): Extract<FeatureResult<never>, { reason: "permission" }> {
  const registry = getRegistryFromRuntime(runtime);
  let canRequest = true;
  if (registry) {
    registry.recordBlock("reminders", { app: "lifeops", action });
    const state = registry.get("reminders");
    canRequest = state.canRequest;
  }
  return {
    ok: false,
    reason: "permission",
    permission: "reminders",
    canRequest,
  };
}

export type NativeAppleReminderSuccess = {
  provider: "apple_reminders";
  reminderId: string | null;
};

export type NativeAppleReminderDeleteSuccess = {
  provider: "apple_reminders";
};

export async function createNativeAppleReminderLikeItem(args: {
  kind: NativeAppleReminderLikeKind;
  title: string;
  dueAt: string;
  notes?: string | null;
  originalIntent?: string | null;
  runtime?: IAgentRuntime | null;
}): Promise<FeatureResult<NativeAppleReminderSuccess>> {
  if (process.platform !== "darwin") {
    return {
      ok: false,
      reason: "not_supported",
      platform: process.platform,
    };
  }

  const title = args.title.trim();
  if (!title) {
    return {
      ok: false,
      reason: "native_error",
      message: "Reminder title is required.",
    };
  }

  const dueAtSeconds = reminderEpochSeconds(args.dueAt);
  if (dueAtSeconds === null) {
    return {
      ok: false,
      reason: "native_error",
      message: `Invalid dueAt for native Apple reminder: ${args.dueAt}`,
    };
  }

  const bridge = await loadNativeReminderBridge();
  if (!bridge) {
    return {
      ok: false,
      reason: "native_error",
      message: "Native Apple Reminders bridge is unavailable.",
    };
  }

  const payload = parseNativeReminderPayload(
    bridge.create({
      dueAtSeconds,
      notes: buildReminderNotes(args),
      priority: appleReminderPriority(args.kind),
      title,
    }),
  );
  if (payload.ok) {
    return {
      ok: true,
      data: {
        provider: "apple_reminders",
        reminderId: payload.reminderId || null,
      },
    };
  }
  if (payload.error === "permission") {
    return buildPermissionFailure(args.runtime, "reminders.create");
  }
  return {
    ok: false,
    reason: "native_error",
    message: payload.message || "Failed to create native Apple reminder.",
  };
}

export async function updateNativeAppleReminderLikeItem(args: {
  reminderId: string;
  kind: NativeAppleReminderLikeKind;
  title: string;
  dueAt: string;
  notes?: string | null;
  originalIntent?: string | null;
  runtime?: IAgentRuntime | null;
}): Promise<FeatureResult<NativeAppleReminderSuccess>> {
  if (process.platform !== "darwin") {
    return {
      ok: false,
      reason: "not_supported",
      platform: process.platform,
    };
  }

  const reminderId = args.reminderId.trim();
  if (!reminderId) {
    return {
      ok: false,
      reason: "native_error",
      message: "Native Apple reminder id is required.",
    };
  }

  const title = args.title.trim();
  if (!title) {
    return {
      ok: false,
      reason: "native_error",
      message: "Reminder title is required.",
    };
  }

  const dueAtSeconds = reminderEpochSeconds(args.dueAt);
  if (dueAtSeconds === null) {
    return {
      ok: false,
      reason: "native_error",
      message: `Invalid dueAt for native Apple reminder: ${args.dueAt}`,
    };
  }

  const bridge = await loadNativeReminderBridge();
  if (!bridge) {
    return {
      ok: false,
      reason: "native_error",
      message: "Native Apple Reminders bridge is unavailable.",
    };
  }

  const payload = parseNativeReminderPayload(
    bridge.update({
      dueAtSeconds,
      notes: buildReminderNotes(args),
      priority: appleReminderPriority(args.kind),
      reminderId,
      title,
    }),
  );
  if (payload.ok) {
    return {
      ok: true,
      data: {
        provider: "apple_reminders",
        reminderId: payload.reminderId || reminderId,
      },
    };
  }
  if (payload.error === "permission") {
    return buildPermissionFailure(args.runtime, "reminders.update");
  }
  return {
    ok: false,
    reason: "native_error",
    message: payload.message || "Failed to update native Apple reminder.",
  };
}

export async function deleteNativeAppleReminderLikeItem(
  reminderId: string,
  options?: { runtime?: IAgentRuntime | null },
): Promise<FeatureResult<NativeAppleReminderDeleteSuccess>> {
  if (process.platform !== "darwin") {
    return {
      ok: false,
      reason: "not_supported",
      platform: process.platform,
    };
  }

  const normalizedReminderId = reminderId.trim();
  if (!normalizedReminderId) {
    return {
      ok: false,
      reason: "native_error",
      message: "Native Apple reminder id is required.",
    };
  }

  const bridge = await loadNativeReminderBridge();
  if (!bridge) {
    return {
      ok: false,
      reason: "native_error",
      message: "Native Apple Reminders bridge is unavailable.",
    };
  }

  const payload = parseNativeReminderPayload(
    bridge.delete(normalizedReminderId),
  );
  if (payload.ok) {
    return {
      ok: true,
      data: {
        provider: "apple_reminders",
      },
    };
  }
  if (payload.error === "permission") {
    return buildPermissionFailure(options?.runtime, "reminders.delete");
  }
  return {
    ok: false,
    reason: "native_error",
    message: payload.message || "Failed to delete native Apple reminder.",
  };
}

// Internal helpers exposed for unit testing.
export const __testing = {
  setNativeReminderBridgeForTest(bridge: NativeReminderBridge | null): void {
    nativeReminderBridgeOverride = bridge;
  },
};
