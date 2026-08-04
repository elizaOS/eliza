/** Implements Electrobun desktop registry ts behavior for app-core shell integration. */
import { DynamicViewError } from "./errors";
import {
  DYNAMIC_VIEW_PLACEMENTS,
  DYNAMIC_VIEW_SOURCES,
  type DynamicViewManifest,
  type DynamicViewMetadata,
  type DynamicViewPlacement,
  type DynamicViewSource,
} from "./types";

interface RegisterOptions {
  update?: boolean;
}

function isNonEmptyString(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validateStringList(
  values: string[] | undefined,
  field: string,
): string[] | undefined {
  if (values === undefined) return undefined;
  if (!Array.isArray(values)) {
    throw new DynamicViewError(
      "DYNAMIC_VIEW_INVALID_MANIFEST",
      `${field} must be an array.`,
    );
  }
  return values.map((value) => {
    if (!isNonEmptyString(value)) {
      throw new DynamicViewError(
        "DYNAMIC_VIEW_INVALID_MANIFEST",
        `${field} must contain only non-empty strings.`,
      );
    }
    return value;
  });
}

function validateMetadata(
  metadata: DynamicViewMetadata | undefined,
): DynamicViewMetadata | undefined {
  if (metadata === undefined) return undefined;
  JSON.stringify(metadata);
  return { ...metadata };
}

function validatePlacement(value: DynamicViewPlacement): DynamicViewPlacement {
  if (!DYNAMIC_VIEW_PLACEMENTS.includes(value)) {
    throw new DynamicViewError(
      "DYNAMIC_VIEW_INVALID_MANIFEST",
      `Unsupported dynamic view placement: ${String(value)}`,
    );
  }
  return value;
}

function validateSource(value: DynamicViewSource): DynamicViewSource {
  if (!DYNAMIC_VIEW_SOURCES.includes(value)) {
    throw new DynamicViewError(
      "DYNAMIC_VIEW_INVALID_MANIFEST",
      `Unsupported dynamic view source: ${String(value)}`,
    );
  }
  return value;
}

function optionalString(
  value: string | undefined,
  field: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (!isNonEmptyString(value)) {
    throw new DynamicViewError(
      "DYNAMIC_VIEW_INVALID_MANIFEST",
      `${field} must be a non-empty string.`,
    );
  }
  return value;
}

export function normalizeDynamicViewManifest(
  manifest: DynamicViewManifest,
): DynamicViewManifest {
  if (!isNonEmptyString(manifest.id)) {
    throw new DynamicViewError(
      "DYNAMIC_VIEW_INVALID_MANIFEST",
      "id must be a non-empty string.",
    );
  }
  if (!isNonEmptyString(manifest.title)) {
    throw new DynamicViewError(
      "DYNAMIC_VIEW_INVALID_MANIFEST",
      "title must be a non-empty string.",
    );
  }
  if (!isNonEmptyString(manifest.entrypoint)) {
    throw new DynamicViewError(
      "DYNAMIC_VIEW_INVALID_MANIFEST",
      "entrypoint must be a non-empty string.",
    );
  }

  const normalized: DynamicViewManifest = {
    id: manifest.id.trim(),
    title: manifest.title.trim(),
    source: validateSource(manifest.source),
    entrypoint: manifest.entrypoint.trim(),
    placement: validatePlacement(manifest.placement),
  };
  const description = optionalString(manifest.description, "description");
  const permissions = validateStringList(manifest.permissions, "permissions");
  const metadata = validateMetadata(manifest.metadata);

  if (description !== undefined) normalized.description = description;
  if (permissions !== undefined) normalized.permissions = permissions;
  if (metadata !== undefined) normalized.metadata = metadata;

  return normalized;
}

export class DynamicViewRegistry {
  private readonly manifests = new Map<string, DynamicViewManifest>();

  register(
    manifest: DynamicViewManifest,
    options: RegisterOptions = {},
  ): DynamicViewManifest {
    const normalized = normalizeDynamicViewManifest(manifest);
    if (this.manifests.has(normalized.id) && options.update !== true) {
      throw new DynamicViewError(
        "DYNAMIC_VIEW_DUPLICATE",
        `Dynamic view already registered: ${normalized.id}`,
      );
    }
    this.manifests.set(normalized.id, normalized);
    return normalized;
  }

  unregister(viewId: string): boolean {
    return this.manifests.delete(viewId);
  }

  get(viewId: string): DynamicViewManifest | null {
    return this.manifests.get(viewId) ?? null;
  }

  list(): DynamicViewManifest[] {
    return [...this.manifests.values()];
  }
}
