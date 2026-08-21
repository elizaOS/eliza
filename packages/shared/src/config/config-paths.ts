/**
 * Dot-notation config path parsing and safe get/set/unset on nested config
 * objects. Prototype-pollution keys (`__proto__`, `prototype`, `constructor`)
 * are rejected so untrusted override paths cannot walk into the prototype chain.
 */

import { ElizaError } from "@elizaos/core";
import { isPlainObject } from "../type-guards.js";

type PathNode = Record<string, unknown>;

const BLOCKED_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function assertSafePath(path: string[]): void {
  if (path.length === 0 || path.some((key) => !key || BLOCKED_KEYS.has(key))) {
    throw new ElizaError("Config path contains an unsafe segment", {
      code: "CONFIG_PATH_UNSAFE",
      context: { path },
      severity: "fatal",
    });
  }
}

function ownValue(node: PathNode, key: string): unknown {
  return Object.hasOwn(node, key) ? node[key] : undefined;
}

function defineOwn(node: PathNode, key: string, value: unknown): void {
  Object.defineProperty(node, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

export function parseConfigPath(raw: string): {
  ok: boolean;
  path?: string[];
  error?: string;
} {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {
      ok: false,
      error: "Invalid path. Use dot notation (e.g. foo.bar).",
    };
  }
  const parts = trimmed.split(".").map((part) => part.trim());
  if (parts.some((part) => !part)) {
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
  let cursor: PathNode = root;
  for (let idx = 0; idx < path.length - 1; idx += 1) {
    const key = path[idx];
    const next = ownValue(cursor, key);
    if (!isPlainObject(next)) {
      const created = Object.create(null) as PathNode;
      defineOwn(cursor, key, created);
      cursor = created;
    } else {
      cursor = next;
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
  const stack: Array<{ node: PathNode; key: string }> = [];
  let cursor: PathNode = root;
  for (let idx = 0; idx < path.length - 1; idx += 1) {
    const key = path[idx];
    const next = ownValue(cursor, key);
    if (!isPlainObject(next)) {
      return false;
    }
    stack.push({ node: cursor, key });
    cursor = next;
  }
  const leafKey = path[path.length - 1];
  if (!Object.hasOwn(cursor, leafKey)) {
    return false;
  }
  delete cursor[leafKey];
  for (let idx = stack.length - 1; idx >= 0; idx -= 1) {
    const { node, key } = stack[idx];
    const child = node[key];
    if (isPlainObject(child) && Object.keys(child).length === 0) {
      delete node[key];
    } else {
      break;
    }
  }
  return true;
}

export function getConfigValueAtPath(root: PathNode, path: string[]): unknown {
  assertSafePath(path);
  let cursor: unknown = root;
  for (const key of path) {
    if (!isPlainObject(cursor)) {
      return undefined;
    }
    cursor = ownValue(cursor, key);
  }
  return cursor;
}
