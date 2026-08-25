/**
 * Deterministic unit coverage for the workerd-safe @elizaos/plugin-elevenlabs
 * stub. Drives the real module with no mocks: named and default exports are
 * the same sidecar marker object. The stub has no queue, comparator, or
 * capacity.
 */

import { describe, expect, test } from "vitest";
import * as stub from "./elizaos-plugin-elevenlabs";
import elevenLabsPluginDefault, {
  elevenLabsPlugin,
} from "./elizaos-plugin-elevenlabs";

const SIDECAR_DESCRIPTION =
  "ElevenLabs plugin is loaded by the agent-server sidecar, not the Cloudflare Worker API bundle.";

const OWN_KEYS = ["name", "description"] as const;

const PLUGIN_RUNTIME_KEYS = [
  "actions",
  "providers",
  "evaluators",
  "services",
  "routes",
  "models",
  "events",
  "tests",
  "init",
  "config",
] as const;

describe("elizaos-plugin-elevenlabs Worker stub", () => {
  test("named export is a plain object whose own keys are name then description", () => {
    expect(Object.keys(elevenLabsPlugin)).toEqual([...OWN_KEYS]);
    expect(Object.getOwnPropertyNames(elevenLabsPlugin)).toEqual([...OWN_KEYS]);
    expect(Object.getPrototypeOf(elevenLabsPlugin)).toBe(Object.prototype);
    expect(Array.isArray(elevenLabsPlugin)).toBe(false);
  });

  test("name is the lowercase plugin id, not the npm package name", () => {
    expect(elevenLabsPlugin.name).toBe("elevenlabs");
    expect(elevenLabsPlugin.name).not.toBe("@elizaos/plugin-elevenlabs");
  });

  test("description is the exact sidecar-not-worker sentence", () => {
    expect(elevenLabsPlugin.description).toBe(SIDECAR_DESCRIPTION);
  });

  test("default export is the same object identity as the named export", () => {
    expect(elevenLabsPluginDefault).toBe(elevenLabsPlugin);
    expect(stub.default).toBe(elevenLabsPlugin);
    expect(stub.elevenLabsPlugin).toBe(elevenLabsPlugin);
  });

  test("module namespace exposes only the named export and default", () => {
    expect(stub).toHaveProperty("elevenLabsPlugin");
    expect(stub).toHaveProperty("default");
    expect(Object.keys(stub).sort()).toEqual(["default", "elevenLabsPlugin"]);
  });

  test("does not expose queue, comparator, or capacity fields", () => {
    const record = elevenLabsPlugin as Record<string, unknown>;
    expect("queue" in record).toBe(false);
    expect("capacity" in record).toBe(false);
    expect("comparator" in record).toBe(false);
    expect(record.queue).toBeUndefined();
    expect(record.capacity).toBeUndefined();
    expect(record.comparator).toBeUndefined();
  });

  test("does not expose plugin runtime surfaces the Worker must not bundle", () => {
    const record = elevenLabsPlugin as Record<string, unknown>;
    for (const key of PLUGIN_RUNTIME_KEYS) {
      expect(key in record).toBe(false);
      expect(record[key]).toBeUndefined();
    }
  });

  test("deleting a missing queue key is a no-op and leaves both own keys", () => {
    const record = elevenLabsPlugin as Record<string, unknown>;
    expect("queue" in record).toBe(false);
    const deleted = delete record.queue;
    expect(deleted).toBe(true);
    expect(Object.keys(elevenLabsPlugin)).toEqual([...OWN_KEYS]);
    expect(elevenLabsPlugin.name).toBe("elevenlabs");
    expect(elevenLabsPlugin.description).toBe(SIDECAR_DESCRIPTION);
  });

  test("dynamic import resolves to the same module singleton", async () => {
    const again = await import("./elizaos-plugin-elevenlabs");
    expect(again.elevenLabsPlugin).toBe(elevenLabsPlugin);
    expect(again.default).toBe(elevenLabsPlugin);
  });

  test("own property descriptors are writable enumerable configurable strings", () => {
    for (const key of OWN_KEYS) {
      const descriptor = Object.getOwnPropertyDescriptor(elevenLabsPlugin, key);
      expect(descriptor).toEqual({
        value: elevenLabsPlugin[key],
        writable: true,
        enumerable: true,
        configurable: true,
      });
      expect(typeof descriptor?.value).toBe("string");
    }
  });

  test("is not frozen or sealed", () => {
    expect(Object.isFrozen(elevenLabsPlugin)).toBe(false);
    expect(Object.isSealed(elevenLabsPlugin)).toBe(false);
    expect(Object.isExtensible(elevenLabsPlugin)).toBe(true);
  });
});
