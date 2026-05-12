import type { Component, MetadataValue } from "@elizaos/core";

type ComponentData = NonNullable<Component["data"]>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function serializeMetadataValue(value: unknown): MetadataValue {
  if (value === undefined) {
    return undefined;
  }

  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    return undefined;
  }

  return JSON.parse(serialized) as MetadataValue;
}

export function getStoredField<T>(
  component: Pick<Component, "data" | "type"> | null | undefined,
  field: string,
): T | null {
  if (!component?.data) {
    return null;
  }

  if (!isRecord(component.data)) {
    throw new Error(
      `[Music Library] Component ${component.type} has invalid data payload`,
    );
  }

  const value = component.data[field];
  if (value === undefined || value === null) {
    return null;
  }

  return value as T;
}

export function createStoredField(
  field: string,
  value: unknown,
): ComponentData {
  return {
    [field]: serializeMetadataValue(value),
  };
}

export function mergeStoredField(
  component: Pick<Component, "data">,
  field: string,
  value: unknown,
): ComponentData {
  return {
    ...(component.data ?? {}),
    [field]: serializeMetadataValue(value),
  };
}
