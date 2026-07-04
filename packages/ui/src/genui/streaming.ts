/**
 * Incremental patch application for streamed GenUI specs: applies RFC-6902
 * patches onto the in-flight spec and reports validation issues.
 */
import type {
  ElizaGenUiJsonValue,
  ElizaGenUiPatch,
  ElizaGenUiPatchResult,
  ElizaGenUiSpec,
  ElizaGenUiValidationIssue,
  ElizaGenUiValidationOptions,
} from "./types";
import { validateElizaGenUiSpec } from "./validator";

function decodePathSegment(segment: string): string {
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}

function parsePatchPath(path: string): string[] | null {
  if (!path.startsWith("/")) {
    return null;
  }
  return path
    .slice(1)
    .split("/")
    .filter((segment) => segment.length > 0)
    .map(decodePathSegment);
}

function _patchError(message: string, path: string): ElizaGenUiPatchResult {
  return {
    ok: false,
    errors: [{ code: "invalid_spec", message, path }],
  };
}

function resolveContainer(
  root: unknown,
  segments: readonly string[],
): { container: unknown; key: string } | null {
  if (segments.length === 0) {
    return null;
  }
  let cursor = root;
  for (const segment of segments.slice(0, -1)) {
    if (Array.isArray(cursor)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= cursor.length) {
        return null;
      }
      cursor = cursor[index];
      continue;
    }
    if (!cursor || typeof cursor !== "object") {
      return null;
    }
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return { container: cursor, key: segments[segments.length - 1] };
}

function writePatchValue(
  container: unknown,
  key: string,
  op: "add" | "replace",
  value: ElizaGenUiJsonValue | undefined,
): boolean {
  if (value === undefined) {
    return false;
  }
  if (Array.isArray(container)) {
    const index = key === "-" ? container.length : Number(key);
    if (!Number.isInteger(index) || index < 0 || index > container.length) {
      return false;
    }
    if (op === "replace" && index >= container.length) {
      return false;
    }
    if (op === "add") {
      container.splice(index, 0, value);
      return true;
    }
    container[index] = value;
    return true;
  }
  if (!container || typeof container !== "object") {
    return false;
  }
  const record = container as Record<string, unknown>;
  if (op === "replace" && !(key in record)) {
    return false;
  }
  record[key] = value;
  return true;
}

function removePatchValue(container: unknown, key: string): boolean {
  if (Array.isArray(container)) {
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0 || index >= container.length) {
      return false;
    }
    container.splice(index, 1);
    return true;
  }
  if (!container || typeof container !== "object") {
    return false;
  }
  const record = container as Record<string, unknown>;
  if (!(key in record)) {
    return false;
  }
  delete record[key];
  return true;
}

function applySinglePatch(
  spec: ElizaGenUiSpec,
  patch: ElizaGenUiPatch,
): ElizaGenUiValidationIssue | null {
  const segments = parsePatchPath(patch.path);
  if (!segments) {
    return {
      code: "invalid_spec",
      message: `Patch path "${patch.path}" must be a JSON Pointer.`,
      path: patch.path,
    };
  }
  const target = resolveContainer(spec, segments);
  if (!target) {
    return {
      code: "invalid_spec",
      message: `Patch path "${patch.path}" does not resolve.`,
      path: patch.path,
    };
  }
  const ok =
    patch.op === "remove"
      ? removePatchValue(target.container, target.key)
      : writePatchValue(target.container, target.key, patch.op, patch.value);
  if (!ok) {
    return {
      code: "invalid_spec",
      message: `Patch operation "${patch.op}" failed at "${patch.path}".`,
      path: patch.path,
    };
  }
  return null;
}

export function applyElizaGenUiPatch(
  spec: ElizaGenUiSpec,
  patches: readonly ElizaGenUiPatch[],
  options?: ElizaGenUiValidationOptions,
): ElizaGenUiPatchResult {
  const next = structuredClone(spec) as ElizaGenUiSpec;
  const errors: ElizaGenUiValidationIssue[] = [];
  for (const patch of patches) {
    const error = applySinglePatch(next, patch);
    if (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  const validated = validateElizaGenUiSpec(next, options);
  if (!validated.ok) {
    return validated;
  }
  return { ok: true, spec: validated.spec };
}

export function resetElizaGenUiSpec(spec: ElizaGenUiSpec): ElizaGenUiSpec {
  return structuredClone(spec) as ElizaGenUiSpec;
}

export function abortElizaGenUiStream(reason: string): ElizaGenUiPatchResult {
  return {
    ok: false,
    errors: [{ code: "invalid_spec", message: reason }],
  };
}
