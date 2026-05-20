import type { JsonValue } from "@elizaos/electrobun-carrots";
import { DynamicViewError } from "./errors";
import type { DynamicViewRegistry } from "./registry";
import type { DynamicViewSessionManager } from "./session-manager";
import {
  DYNAMIC_VIEW_PLACEMENTS,
  DYNAMIC_VIEW_SOURCES,
  type DynamicViewEventSubscription,
  type DynamicViewManifest,
  type DynamicViewMetadata,
  type DynamicViewPlacement,
  type DynamicViewSession,
  type DynamicViewSource,
} from "./types";

type JsonRecord = { readonly [key: string]: JsonValue };

export interface DynamicViewHost {
  register(params: JsonValue | undefined): Promise<JsonValue>;
  unregister(params: JsonValue | undefined): Promise<JsonValue>;
  list(): Promise<JsonValue>;
  open(params: JsonValue | undefined): Promise<JsonValue>;
  close(params: JsonValue | undefined): Promise<JsonValue>;
  push(params: JsonValue | undefined): Promise<JsonValue>;
  sessions(): Promise<JsonValue>;
}

function isJsonRecord(value: JsonValue | undefined): value is JsonRecord {
  return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireRecord(
  value: JsonValue | undefined,
  method: string,
): JsonRecord {
  if (!isJsonRecord(value)) {
    throw new DynamicViewError(
      "DYNAMIC_VIEW_INVALID_MANIFEST",
      `${method}: expected params object.`,
    );
  }
  return value;
}

function readString(record: JsonRecord, key: string, method: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new DynamicViewError(
      "DYNAMIC_VIEW_INVALID_MANIFEST",
      `${method}: ${key} must be a non-empty string.`,
    );
  }
  return value;
}

function readOptionalString(
  record: JsonRecord,
  key: string,
  method: string,
): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new DynamicViewError(
      "DYNAMIC_VIEW_INVALID_MANIFEST",
      `${method}: ${key} must be a non-empty string.`,
    );
  }
  return value;
}

function readOptionalBoolean(record: JsonRecord, key: string): boolean {
  return record[key] === true;
}

function isDynamicViewSource(value: string): value is DynamicViewSource {
  return DYNAMIC_VIEW_SOURCES.some((source) => source === value);
}

function isDynamicViewPlacement(value: string): value is DynamicViewPlacement {
  return DYNAMIC_VIEW_PLACEMENTS.some((placement) => placement === value);
}

function readStringList(
  record: JsonRecord,
  key: string,
  method: string,
): string[] | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new DynamicViewError(
      "DYNAMIC_VIEW_INVALID_MANIFEST",
      `${method}: ${key} must be an array.`,
    );
  }
  return value.map((entry) => {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new DynamicViewError(
        "DYNAMIC_VIEW_INVALID_MANIFEST",
        `${method}: ${key} must contain only non-empty strings.`,
      );
    }
    return entry;
  });
}

function readSource(value: string, method: string): DynamicViewSource {
  if (!isDynamicViewSource(value)) {
    throw new DynamicViewError(
      "DYNAMIC_VIEW_INVALID_MANIFEST",
      `${method}: unsupported source ${value}.`,
    );
  }
  return value;
}

function readPlacement(value: string, method: string): DynamicViewPlacement {
  if (!isDynamicViewPlacement(value)) {
    throw new DynamicViewError(
      "DYNAMIC_VIEW_INVALID_MANIFEST",
      `${method}: unsupported placement ${value}.`,
    );
  }
  return value;
}

function readMetadata(
  record: JsonRecord,
  key: string,
  method: string,
): DynamicViewMetadata | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (!isJsonRecord(value)) {
    throw new DynamicViewError(
      "DYNAMIC_VIEW_INVALID_MANIFEST",
      `${method}: ${key} must be an object.`,
    );
  }
  const metadata: DynamicViewMetadata = {};
  for (const [metadataKey, metadataValue] of Object.entries(value)) {
    metadata[metadataKey] = metadataValue;
  }
  return metadata;
}

function readSubscriptions(
  record: JsonRecord,
  method: string,
): DynamicViewEventSubscription[] | undefined {
  const value = record.eventSubscriptions;
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new DynamicViewError(
      "DYNAMIC_VIEW_INVALID_MANIFEST",
      `${method}: eventSubscriptions must be an array.`,
    );
  }
  return value.map((entry) => {
    const subscription = requireRecord(entry, method);
    return {
      satelliteId: readString(subscription, "satelliteId", method),
      events: readStringList(subscription, "events", method),
    };
  });
}

function readManifest(params: JsonValue | undefined): {
  manifest: DynamicViewManifest;
  update: boolean;
} {
  const record = requireRecord(params, "dynamic-view-register");
  const manifestRecord = requireRecord(record.manifest, "dynamic-view-register");
  return {
    manifest: {
      id: readString(manifestRecord, "id", "dynamic-view-register"),
      title: readString(manifestRecord, "title", "dynamic-view-register"),
      description: readOptionalString(
        manifestRecord,
        "description",
        "dynamic-view-register",
      ),
      source: readSource(
        readString(manifestRecord, "source", "dynamic-view-register"),
        "dynamic-view-register",
      ),
      entrypoint: readString(
        manifestRecord,
        "entrypoint",
        "dynamic-view-register",
      ),
      placement: readPlacement(
        readString(manifestRecord, "placement", "dynamic-view-register"),
        "dynamic-view-register",
      ),
      permissions: readStringList(
        manifestRecord,
        "permissions",
        "dynamic-view-register",
      ),
      requiredSatellites: readStringList(
        manifestRecord,
        "requiredSatellites",
        "dynamic-view-register",
      ),
      eventSubscriptions: readSubscriptions(
        manifestRecord,
        "dynamic-view-register",
      ),
      invokeTargets: readStringList(
        manifestRecord,
        "invokeTargets",
        "dynamic-view-register",
      ),
      metadata: readMetadata(
        manifestRecord,
        "metadata",
        "dynamic-view-register",
      ),
    },
    update: readOptionalBoolean(record, "update"),
  };
}

function manifestToJson(manifest: DynamicViewManifest): JsonValue {
  const output: DynamicViewMetadata = {
    id: manifest.id,
    title: manifest.title,
    source: manifest.source,
    entrypoint: manifest.entrypoint,
    placement: manifest.placement,
    description: manifest.description ?? null,
    permissions: manifest.permissions ?? [],
    requiredSatellites: manifest.requiredSatellites ?? [],
    eventSubscriptions: (manifest.eventSubscriptions ?? []).map(
      (subscription) => ({
        satelliteId: subscription.satelliteId,
        events: subscription.events ?? [],
      }),
    ),
    invokeTargets: manifest.invokeTargets ?? [],
    metadata: manifest.metadata ?? null,
  };
  return output;
}

function sessionToJson(session: DynamicViewSession): JsonValue {
  const output: DynamicViewMetadata = {
    sessionId: session.sessionId,
    viewId: session.viewId,
    title: session.title,
    placement: session.placement,
    status: session.status,
    canvasWindowId: session.canvasWindowId ?? null,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    closedAt: session.closedAt ?? null,
    error: session.error ?? null,
    metadata: session.metadata ?? null,
  };
  return output;
}

export function createDynamicViewHost({
  registry,
  sessions,
}: {
  registry: DynamicViewRegistry;
  sessions: DynamicViewSessionManager;
}): DynamicViewHost {
  return {
    register: async (params) => {
      const request = readManifest(params);
      return manifestToJson(
        registry.register(request.manifest, { update: request.update }),
      );
    },
    unregister: async (params) => {
      const record = requireRecord(params, "dynamic-view-unregister");
      return {
        removed: registry.unregister(
          readString(record, "viewId", "dynamic-view-unregister"),
        ),
      };
    },
    list: async () => ({ views: registry.list().map(manifestToJson) }),
    open: async (params) => {
      const record = requireRecord(params, "dynamic-view-open");
      return sessionToJson(
        await sessions.open({
          viewId: readString(record, "viewId", "dynamic-view-open"),
          title: readOptionalString(record, "title", "dynamic-view-open"),
          placement:
            record.placement === undefined
              ? undefined
              : readPlacement(
                  readString(record, "placement", "dynamic-view-open"),
                  "dynamic-view-open",
                ),
          initialState: record.initialState,
          metadata: readMetadata(record, "metadata", "dynamic-view-open"),
        }),
      );
    },
    close: async (params) => {
      const record = requireRecord(params, "dynamic-view-close");
      return sessionToJson(
        await sessions.close({
          sessionId: readString(record, "sessionId", "dynamic-view-close"),
        }),
      );
    },
    push: async (params) => {
      const record = requireRecord(params, "dynamic-view-push");
      return sessions.push({
        sessionId: readString(record, "sessionId", "dynamic-view-push"),
        event: readString(record, "event", "dynamic-view-push"),
        payload: record.payload,
      });
    },
    sessions: async () => ({ sessions: sessions.list().map(sessionToJson) }),
  };
}
