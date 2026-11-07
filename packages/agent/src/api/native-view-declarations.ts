/** Trusted launch policy for navigation-only views rendered by a consumer shell. */
import { ElizaError, type ViewDeclaration } from "@elizaos/core";

export const NATIVE_VIEW_DECLARATIONS_ENV = "ELIZA_NATIVE_VIEW_DECLARATIONS";

export function nativeViewDeclarations(
  raw: string | undefined,
  builtins: readonly ViewDeclaration[],
): ViewDeclaration[] {
  if (raw === undefined) return [];
  const invalid = (): never => {
    throw new ElizaError("Invalid trusted native view declarations", {
      code: "INVALID_NATIVE_VIEW_DECLARATIONS",
    });
  };
  if (raw.length > 16384) return invalid();
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return invalid();
  }
  if (!Array.isArray(decoded) || decoded.length > 32) return invalid();
  const ids = new Set<string>();
  const paths = new Set<string>();
  return decoded.map<ViewDeclaration>((value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return invalid();
    const row = value as Record<string, unknown>;
    if (
      Object.keys(row).some(
        (key) => !["id", "label", "path", "fallbackFor"].includes(key),
      ) ||
      typeof row.id !== "string" ||
      !/^[a-z][a-z0-9_-]{0,63}$/.test(row.id) ||
      typeof row.label !== "string" ||
      !row.label.trim() ||
      row.label !== row.label.trim() ||
      row.label.length > 80 ||
      [...row.label].some(
        (character) =>
          character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ) ||
      typeof row.path !== "string" ||
      !/^\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+$/.test(row.path) ||
      row.path.length > 256 ||
      (row.fallbackFor !== undefined &&
        (typeof row.fallbackFor !== "string" ||
          !/^@?[a-z0-9_-]+(?:\/[a-z0-9_-]+)?$/.test(row.fallbackFor))) ||
      ids.has(row.id) ||
      paths.has(row.path)
    )
      return invalid();
    // A consumer may release its own counterpart of a preview destination,
    // never rename or replace an existing release/system destination.
    if (
      builtins.some(
        (view) =>
          (view.id === row.id || view.path === row.path) &&
          (view.id !== row.id ||
            view.path !== row.path ||
            view.viewKind !== "preview"),
      )
    )
      return invalid();
    ids.add(row.id);
    paths.add(row.path);
    return {
      id: row.id,
      label: row.label,
      path: row.path,
      ...(typeof row.fallbackFor === "string"
        ? { fallbackFor: row.fallbackFor }
        : {}),
      description:
        "Navigation-only native counterpart owned by this host's consumer shell.",
      viewKind: "release",
      viewType: "gui",
      nativeOs: true,
      roleGate: { minRole: "OWNER" },
      visibleInManager: false,
      desktopTabEnabled: false,
    };
  });
}
