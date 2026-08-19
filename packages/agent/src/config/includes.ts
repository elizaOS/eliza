/**
 * $include directive for modular configs.
 *
 * ```json5
 * { "$include": "./base.json5" }
 * { "$include": ["./a.json5", "./b.json5"] }
 * ```
 *
 * Included files are byte-capped on an opened handle before allocation and
 * share an aggregate graph budget so startup cannot be pinned by breadth.
 */

import fs from "node:fs";
import path from "node:path";
import JSON5 from "json5";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const INCLUDE_KEY = "$include";
export const MAX_INCLUDE_DEPTH = 10;
const MAX_INCLUDE_BYTES = 1_048_576;
const MAX_INCLUDE_FILES = 256;
const MAX_INCLUDE_TOTAL_BYTES = 8 * MAX_INCLUDE_BYTES;
const BLOCKED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export type IncludeResolver = {
  readFile: (path: string) => string;
  parseJson: (raw: string) => unknown;
};

export class ConfigIncludeError extends Error {
  constructor(
    message: string,
    public readonly includePath: string,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = "ConfigIncludeError";
  }
}

export class CircularIncludeError extends ConfigIncludeError {
  constructor(public readonly chain: string[]) {
    super(
      `Circular include detected: ${chain.join(" -> ")}`,
      chain[chain.length - 1] ?? "",
    );
    this.name = "CircularIncludeError";
  }
}

export function deepMerge(target: unknown, source: unknown): unknown {
  if (Array.isArray(target) && Array.isArray(source)) {
    return [...target, ...source];
  }
  if (isPlainObject(target) && isPlainObject(source)) {
    const result: Record<string, unknown> = { ...target };
    for (const key of Object.keys(source)) {
      if (BLOCKED_KEYS.has(key)) continue;
      result[key] =
        key in result ? deepMerge(result[key], source[key]) : source[key];
    }
    return result;
  }
  return source;
}

class IncludeProcessor {
  private visited = new Set<string>();
  private depth = 0;

  constructor(
    private basePath: string,
    private resolver: IncludeResolver,
    private readonly budget = { files: 0, bytes: 0 },
  ) {
    this.visited.add(path.normalize(basePath));
  }

  process(obj: unknown): unknown {
    if (Array.isArray(obj)) {
      return obj.map((item) => this.process(item));
    }
    if (!isPlainObject(obj)) {
      return obj;
    }
    const record = obj as Record<string, unknown>;
    if (!(INCLUDE_KEY in record)) {
      return this.processObject(record);
    }
    return this.processInclude(record);
  }

  private processObject(obj: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (BLOCKED_KEYS.has(key)) continue;
      result[key] = this.process(value);
    }
    return result;
  }

  private processInclude(obj: Record<string, unknown>): unknown {
    const includeValue = obj[INCLUDE_KEY];
    const otherKeys = Object.keys(obj).filter((k) => k !== INCLUDE_KEY);
    const included = this.resolveInclude(includeValue);

    if (otherKeys.length === 0) {
      return included;
    }

    if (!isPlainObject(included)) {
      throw new ConfigIncludeError(
        "Sibling keys require included content to be an object",
        typeof includeValue === "string" ? includeValue : INCLUDE_KEY,
      );
    }

    const rest: Record<string, unknown> = {};
    for (const key of otherKeys) {
      rest[key] = this.process(obj[key]);
    }
    return deepMerge(included, rest);
  }

  private resolveInclude(value: unknown): unknown {
    if (typeof value === "string") {
      return this.loadFile(value);
    }

    if (Array.isArray(value)) {
      return value.reduce<unknown>((merged, item) => {
        if (typeof item !== "string") {
          throw new ConfigIncludeError(
            `Invalid $include array item: expected string, got ${typeof item}`,
            String(item),
          );
        }
        return deepMerge(merged, this.loadFile(item));
      }, {});
    }

    throw new ConfigIncludeError(
      `Invalid $include value: expected string or array of strings, got ${typeof value}`,
      String(value),
    );
  }

  private loadFile(includePath: string): unknown {
    const resolvedPath = path.isAbsolute(includePath)
      ? includePath
      : path.resolve(path.dirname(this.basePath), includePath);
    const normalized = path.normalize(resolvedPath);

    if (this.visited.has(normalized)) {
      throw new CircularIncludeError([...this.visited, normalized]);
    }
    if (this.depth >= MAX_INCLUDE_DEPTH) {
      throw new ConfigIncludeError(
        `Maximum include depth (${MAX_INCLUDE_DEPTH}) exceeded at: ${includePath}`,
        includePath,
      );
    }

    let raw: string;
    try {
      raw = this.resolver.readFile(normalized);
    } catch (err) {
      throw new ConfigIncludeError(
        `Failed to read include file: ${includePath} (resolved: ${normalized})`,
        includePath,
        err instanceof Error ? err : undefined,
      );
    }

    const rawBytes = Buffer.byteLength(raw, "utf8");
    this.budget.files += 1;
    this.budget.bytes += rawBytes;
    if (rawBytes > MAX_INCLUDE_BYTES) {
      throw new ConfigIncludeError(
        `Include file exceeds ${MAX_INCLUDE_BYTES} bytes at: ${includePath}`,
        includePath,
      );
    }
    if (
      this.budget.files > MAX_INCLUDE_FILES ||
      this.budget.bytes > MAX_INCLUDE_TOTAL_BYTES
    ) {
      throw new ConfigIncludeError(
        `Include graph exceeds ${MAX_INCLUDE_FILES} files or ${MAX_INCLUDE_TOTAL_BYTES} bytes at: ${includePath}`,
        includePath,
      );
    }

    let parsed: unknown;
    try {
      parsed = this.resolver.parseJson(raw);
    } catch (err) {
      throw new ConfigIncludeError(
        `Failed to parse include file: ${includePath} (resolved: ${normalized})`,
        includePath,
        err instanceof Error ? err : undefined,
      );
    }

    const nested = new IncludeProcessor(normalized, this.resolver, this.budget);
    nested.visited = new Set([...this.visited, normalized]);
    nested.depth = this.depth + 1;
    return nested.process(parsed);
  }
}

function readBoundedIncludeFile(filePath: string): string {
  const handle = fs.openSync(filePath, "r");
  try {
    const before = fs.fstatSync(handle);
    if (
      !before.isFile() ||
      !Number.isSafeInteger(before.size) ||
      before.size > MAX_INCLUDE_BYTES
    ) {
      throw new Error(
        `include is not a regular file within ${MAX_INCLUDE_BYTES} bytes`,
      );
    }
    const bytes = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = fs.readSync(
        handle,
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (read === 0) break;
      offset += read;
    }
    const after = fs.fstatSync(handle);
    if (after.size > MAX_INCLUDE_BYTES || after.size !== before.size) {
      throw new Error("include changed while it was being read");
    }
    return bytes.subarray(0, offset).toString("utf8");
  } finally {
    fs.closeSync(handle);
  }
}

const defaultResolver: IncludeResolver = {
  readFile: readBoundedIncludeFile,
  parseJson: (raw) => JSON5.parse(raw),
};

export function resolveConfigIncludes(
  obj: unknown,
  configPath: string,
  resolver: IncludeResolver = defaultResolver,
): unknown {
  return new IncludeProcessor(configPath, resolver).process(obj);
}
