/**
 * $include directive for modular configs.
 *
 * ```json5
 * { "$include": "./base.json5" }
 * { "$include": ["./a.json5", "./b.json5"] }
 * ```
 */

import JSON5 from "json5";
import fs from "node:fs";
import path from "node:path";
import { isPlainObject } from "./object-utils.js";

export const INCLUDE_KEY = "$include";
export const MAX_INCLUDE_DEPTH = 10;

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
    super(`Circular include detected: ${chain.join(" -> ")}`, chain[chain.length - 1]);
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
      result[key] = key in result ? deepMerge(result[key], source[key]) : source[key];
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
    if (!(INCLUDE_KEY in obj)) {
      return this.processObject(obj);
    }
    return this.processInclude(obj);
  }

  private processObject(obj: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
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

    const nested = new IncludeProcessor(normalized, this.resolver);
    nested.visited = new Set([...this.visited, normalized]);
    nested.depth = this.depth + 1;
    return nested.process(parsed);
  }
}

const defaultResolver: IncludeResolver = {
  readFile: (p) => fs.readFileSync(p, "utf-8"),
  parseJson: (raw) => JSON5.parse(raw),
};

export function resolveConfigIncludes(
  obj: unknown,
  configPath: string,
  resolver: IncludeResolver = defaultResolver,
): unknown {
  return new IncludeProcessor(configPath, resolver).process(obj);
}
