/**
 * Unit coverage for cacheable tool whitelist registry in registry.ts.
 *
 * Tests CACHEABLE_TOOL_REGISTRY entries, resolveToolDescriptor fallback
 * and override handling, and isCacheable lookup predicate.
 */

import { describe, expect, it } from "vitest";
import {
  CACHEABLE_TOOL_REGISTRY,
  isCacheable,
  resolveToolDescriptor,
} from "./registry.js";

describe("tool-call-cache registry", () => {
  it("exports CACHEABLE_TOOL_REGISTRY with default cacheable tools", () => {
    expect(CACHEABLE_TOOL_REGISTRY.web_search).toBeDefined();
    expect(CACHEABLE_TOOL_REGISTRY.web_search.cacheable).toBe(true);

    expect(CACHEABLE_TOOL_REGISTRY.web_fetch).toBeDefined();
    expect(CACHEABLE_TOOL_REGISTRY.web_fetch.cacheable).toBe(true);

    expect(CACHEABLE_TOOL_REGISTRY.file_read).toBeDefined();
    expect(CACHEABLE_TOOL_REGISTRY.file_read.cacheable).toBe(true);

    expect(CACHEABLE_TOOL_REGISTRY.rag_search).toBeDefined();
    expect(CACHEABLE_TOOL_REGISTRY.knowledge_lookup).toBeDefined();
  });

  describe("resolveToolDescriptor", () => {
    it("resolves registered tool descriptor with its default TTL and version", () => {
      const descriptor = resolveToolDescriptor("web_search");
      expect(descriptor.name).toBe("web_search");
      expect(descriptor.cacheable).toBe(true);
      expect(descriptor.version).toBe("1");
      expect(descriptor.ttlMs).toBeGreaterThan(0);
    });

    it("applies overrides to TTL and version when provided", () => {
      const custom = resolveToolDescriptor("web_search", {
        ttlMs: 5000,
        version: "2",
      });

      expect(custom.ttlMs).toBe(5000);
      expect(custom.version).toBe("2");
      expect(custom.cacheable).toBe(true);
    });

    it("returns non-cacheable descriptor for unregistered tools", () => {
      const unregistered = resolveToolDescriptor("send_email");
      expect(unregistered.name).toBe("send_email");
      expect(unregistered.cacheable).toBe(false);
      expect(unregistered.ttlMs).toBe(0);
      expect(unregistered.version).toBe("1");
    });
  });

  describe("isCacheable", () => {
    it("returns true for registered cacheable tools", () => {
      expect(isCacheable("web_search")).toBe(true);
      expect(isCacheable("web_fetch")).toBe(true);
      expect(isCacheable("file_read")).toBe(true);
    });

    it("returns false for unregistered tools and empty names", () => {
      expect(isCacheable("execute_code")).toBe(false);
      expect(isCacheable("")).toBe(false);
      expect(isCacheable("unknown_tool")).toBe(false);
    });
  });
});
