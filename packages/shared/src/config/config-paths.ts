/**
 * Dot-notation config path parsing and safe get/set/unset on nested config
 * objects. Prototype-pollution keys (`__proto__`, `prototype`, `constructor`)
 * are rejected so untrusted override paths cannot walk into the prototype chain.
 */

import { ElizaError } from "@elizaos/core";

type PathNode = Record<string, unknown>;

const BLOCKED_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const MAX_CONFIG_PATH_LENGTH = 512;
const MAX_CONFIG_PATH_SEGMENTS = 32;
const MAX_CONFIG_PATH_SEGMENT_LENGTH = 128;

function unsafeConfigPath(
  context: Record<string, unknown>,
  cause?: unknown,
): ElizaError {
  return new ElizaError("Config path contains an unsafe segment", {
    code: "CONFIG_PATH_UNSAFE",
    context,
    cause,
    severity: "fatal",
  });
}

function assertSafePath(path: string[]): void {
  if (
    path.length === 0 ||
    path.length > MAX_CONFIG_PATH_SEGMENTS ||
    path.some(
      (key) =>
        !key ||
        key.length > MAX_CONFIG_PATH_SEGMENT_LENGTH ||
        BLOCKED_KEYS.has(key),
    )
  ) {
    throw unsafeConfigPath({ segmentCount: path.length });
  }
}

function ownDataValue(
  node: PathNode,
  key: string,
): { found: boolean; value?: unknown } {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(node, key);
  } catch (cause) {
    throw unsafeConfigPath({ key }, cause);
  }
  if (!descriptor) return { found: false };
  if (!("value" in descriptor)) {
    throw unsafeConfigPath({ key, reason: "accessor" });
  }
  return { found: true, value: descriptor.value };
}

function isSafePathNode(value: unknown): value is PathNode {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch (cause) {
    throw unsafeConfigPath({ reason: "prototype" }, cause);
  }
}

function defineOwn(node: PathNode, key: string, value: unknown): void {
  try {
    Object.defineProperty(node, key, {
      configurable: true,
      enumerable: true,
      value,
      writable: true,
    });
  } catch (cause) {
    throw unsafeConfigPath({ key, reason: "write" }, cause);
  }
}

function isEmptyOwnNode(node: PathNode, key: string): boolean {
  try {
    return Object.getOwnPropertyNames(node).length === 0;
  } catch (cause) {
    throw unsafeConfigPath({ key, reason: "own-keys" }, cause);
  }
}

export function parseConfigPath(raw: string): {
  ok: boolean;
  path?: string[];
  error?: string;
} {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_CONFIG_PATH_LENGTH) {
    return {
      ok: false,
      error: "Invalid path. Use dot notation (e.g. foo.bar).",
    };
  }
  const parts = trimmed.split(".").map((part) => part.trim());
  if (
    parts.length > MAX_CONFIG_PATH_SEGMENTS ||
    parts.some((part) => !part || part.length > MAX_CONFIG_PATH_SEGMENT_LENGTH)
  ) {
    return {
      ok: false,
      error: "Invalid path. Use dot notation (e.g. foo.bar).",
    };
  }
  if (parts.some((part) => BLOCKED_KEYS.has(part))) {
    return { ok: false, error: "Invalid path segment." };
  }
  return { ok: true, path: parts };
}

export function setConfigValueAtPath(
  root: PathNode,
  path: string[],
  value: unknown,
): void {
  assertSafePath(path);
  if (!isSafePathNode(root)) {
    throw unsafeConfigPath({ reason: "root-prototype" });
  }
  let cursor: PathNode = root;
  for (let idx = 0; idx < path.length - 1; idx += 1) {
    const key = path[idx];
    const next = ownDataValue(cursor, key);
    if (!next.found || typeof next.value !== "object" || next.value === null) {
      if (next.found && typeof next.value === "object" && next.value !== null) {
        throw unsafeConfigPath({ key, reason: "nested-prototype" });
      }
      const created = Object.create(null) as PathNode;
      defineOwn(cursor, key, created);
      cursor = created;
    } else {
      if (!isSafePathNode(next.value)) {
        throw unsafeConfigPath({ key, reason: "nested-prototype" });
      }
      cursor = next.value;
    }
  }
  const leafKey = path[path.length - 1];
  defineOwn(cursor, leafKey, value);
}

export function unsetConfigValueAtPath(
  root: PathNode,
  path: string[],
): boolean {
  assertSafePath(path);
  if (!isSafePathNode(root)) {
    throw unsafeConfigPath({ reason: "root-prototype" });
  }
  const stack: Array<{ node: PathNode; key: string }> = [];
  let cursor: PathNode = root;
  for (let idx = 0; idx < path.length - 1; idx += 1) {
    const key = path[idx];
    const next = ownDataValue(cursor, key);
    if (!next.found || typeof next.value !== "object" || next.value === null) {
      return false;
    }
    if (!isSafePathNode(next.value)) {
      throw unsafeConfigPath({ key, reason: "nested-prototype" });
    }
    stack.push({ node: cursor, key });
    cursor = next.value;
  }
  const leafKey = path[path.length - 1];
  const leaf = ownDataValue(cursor, leafKey);
  if (!leaf.found) {
    return false;
  }
  try {
    delete cursor[leafKey];
  } catch (cause) {
    throw unsafeConfigPath({ key: leafKey, reason: "delete" }, cause);
  }
  for (let idx = stack.length - 1; idx >= 0; idx -= 1) {
    const { node, key } = stack[idx];
    const child = ownDataValue(node, key);
    if (
      child.found &&
      isSafePathNode(child.value) &&
      isEmptyOwnNode(child.value, key)
    ) {
      try {
        delete node[key];
      } catch (cause) {
        throw unsafeConfigPath({ key, reason: "delete" }, cause);
      }
    } else {
      break;
    }
  }
  return true;
}

export function getConfigValueAtPath(root: PathNode, path: string[]): unknown {
  assertSafePath(path);
  if (!isSafePathNode(root)) {
    throw unsafeConfigPath({ reason: "root-prototype" });
  }
  let cursor: unknown = root;
  for (let idx = 0; idx < path.length; idx += 1) {
    const key = path[idx];
    if (typeof cursor !== "object" || cursor === null) {
      return undefined;
    }
    if (!isSafePathNode(cursor)) {
      throw unsafeConfigPath({ key, reason: "nested-prototype" });
    }
    const next = ownDataValue(cursor, key);
    if (!next.found) return undefined;
    if (
      idx < path.length - 1 &&
      typeof next.value === "object" &&
      next.value !== null &&
      !isSafePathNode(next.value)
    ) {
      throw unsafeConfigPath({ key, reason: "nested-prototype" });
    }
    cursor = next.value;
  }
  return cursor;
}
