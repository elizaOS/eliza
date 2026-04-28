import type { VaultReference, VaultSource } from "./types.js";

export interface ParsedReference {
  readonly source: VaultSource;
  readonly path: string;
  readonly raw: VaultReference;
}

export class InvalidReferenceError extends Error {
  constructor(ref: string, detail?: string) {
    super(
      detail
        ? `Invalid vault reference ${JSON.stringify(ref)}: ${detail}`
        : `Invalid vault reference ${JSON.stringify(ref)}`,
    );
    this.name = "InvalidReferenceError";
  }
}

const SCHEME_TO_SOURCE: ReadonlyMap<string, VaultSource> = new Map([
  ["file", "file"],
  ["keyring", "keyring"],
  ["op", "1password"],
  ["pass", "protonpass"],
  ["env", "env-legacy"],
  ["cloud", "cloud"],
]);

export function parseReference(ref: VaultReference): ParsedReference {
  const sep = ref.indexOf("://");
  if (sep <= 0) throw new InvalidReferenceError(ref, "missing scheme");
  const scheme = ref.slice(0, sep);
  const path = ref.slice(sep + 3);
  const source = SCHEME_TO_SOURCE.get(scheme);
  if (!source) {
    throw new InvalidReferenceError(ref, `unknown scheme \`${scheme}\``);
  }
  // `file://` is allowed empty (the "file backend, default slot").
  if (source !== "file" && path.length === 0) {
    throw new InvalidReferenceError(ref, "empty path");
  }
  return { source, path, raw: ref };
}

export function buildReference(source: VaultSource, path: string): VaultReference {
  switch (source) {
    case "file":
      return "file://";
    case "keyring":
      return `keyring://${path}`;
    case "1password":
      return `op://${path}`;
    case "protonpass":
      return `pass://${path}`;
    case "env-legacy":
      return `env://${path}`;
    case "cloud":
      return `cloud://${path}`;
  }
}
