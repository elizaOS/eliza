import { describe, expect, it } from "vitest";
import { MAX_PATTERN_LENGTH, parseAppPermissions } from "./app-permissions.js";

describe("parseAppPermissions", () => {
  describe("absent / null / undefined", () => {
    it("treats undefined as no permissions declared", () => {
      const result = parseAppPermissions(undefined);
      expect(result).toEqual({ ok: true, manifest: { raw: null } });
    });

    it("treats null as no permissions declared", () => {
      const result = parseAppPermissions(null);
      expect(result).toEqual({ ok: true, manifest: { raw: null } });
    });
  });

  describe("non-object root", () => {
    it("rejects an array", () => {
      const result = parseAppPermissions([]);
      expect(result.ok).toBe(false);
      if (result.ok === true) return;
      expect(result.path).toBe("permissions");
    });

    it("rejects a primitive", () => {
      const result = parseAppPermissions("yes please");
      expect(result.ok).toBe(false);
      if (result.ok === true) return;
      expect(result.reason).toContain("must be an object");
    });
  });

  describe("empty object", () => {
    it("yields an empty manifest with raw preserved", () => {
      const result = parseAppPermissions({});
      expect(result.ok).toBe(true);
      if (result.ok === false) return;
      expect(result.manifest.raw).toEqual({});
      expect(result.manifest.fs).toBeUndefined();
      expect(result.manifest.net).toBeUndefined();
    });
  });

  describe("fs slice", () => {
    it("parses fs.read and fs.write as string arrays", () => {
      const result = parseAppPermissions({
        fs: { read: ["state/**"], write: ["state/cache/*"] },
      });
      expect(result.ok).toBe(true);
      if (result.ok === false) return;
      expect(result.manifest.fs).toEqual({
        read: ["state/**"],
        write: ["state/cache/*"],
      });
    });

    it("preserves an empty array distinctly from absence", () => {
      const result = parseAppPermissions({ fs: { read: [] } });
      expect(result.ok).toBe(true);
      if (result.ok === false) return;
      expect(result.manifest.fs).toEqual({ read: [] });
    });

    it("omits fs when no recognised sub-keys are declared", () => {
      const result = parseAppPermissions({ fs: { unknown: 42 } });
      expect(result.ok).toBe(true);
      if (result.ok === false) return;
      expect(result.manifest.fs).toBeUndefined();
      expect(result.manifest.raw).toEqual({ fs: { unknown: 42 } });
    });

    it("rejects fs when not an object", () => {
      const result = parseAppPermissions({ fs: "all of it" });
      expect(result.ok).toBe(false);
      if (result.ok === true) return;
      expect(result.path).toBe("permissions.fs");
    });

    it("rejects fs.read when not an array", () => {
      const result = parseAppPermissions({ fs: { read: "state/**" } });
      expect(result.ok).toBe(false);
      if (result.ok === true) return;
      expect(result.reason).toBe("fs.read must be an array of glob strings");
      expect(result.path).toBe("permissions.fs.read");
    });

    it("rejects fs.read when an element is non-string", () => {
      const result = parseAppPermissions({ fs: { read: ["ok", 42] } });
      expect(result.ok).toBe(false);
      if (result.ok === true) return;
      expect(result.path).toBe("permissions.fs.read[1]");
    });

    it("rejects glob strings exceeding the length cap", () => {
      const tooLong = "a".repeat(MAX_PATTERN_LENGTH + 1);
      const result = parseAppPermissions({ fs: { read: [tooLong] } });
      expect(result.ok).toBe(false);
      if (result.ok === true) return;
      expect(result.reason).toContain(`exceeds ${MAX_PATTERN_LENGTH}`);
      expect(result.path).toBe("permissions.fs.read[0]");
    });

    it("accepts fs.write while fs.read is absent", () => {
      const result = parseAppPermissions({ fs: { write: ["state/**"] } });
      expect(result.ok).toBe(true);
      if (result.ok === false) return;
      expect(result.manifest.fs).toEqual({ write: ["state/**"] });
    });
  });

  describe("net slice", () => {
    it("parses net.outbound", () => {
      const result = parseAppPermissions({
        net: { outbound: ["api.example.com", "*.example.com"] },
      });
      expect(result.ok).toBe(true);
      if (result.ok === false) return;
      expect(result.manifest.net).toEqual({
        outbound: ["api.example.com", "*.example.com"],
      });
    });

    it("rejects net when not an object", () => {
      const result = parseAppPermissions({ net: ["a", "b"] });
      expect(result.ok).toBe(false);
      if (result.ok === true) return;
      expect(result.path).toBe("permissions.net");
    });

    it("rejects net.outbound when an element is non-string", () => {
      const result = parseAppPermissions({ net: { outbound: [true] } });
      expect(result.ok).toBe(false);
      if (result.ok === true) return;
      expect(result.reason).toBe(
        "net.outbound must be an array of host pattern strings",
      );
      expect(result.path).toBe("permissions.net.outbound[0]");
    });
  });

  describe("forward compatibility", () => {
    it("preserves unknown top-level namespaces under raw", () => {
      const input = {
        fs: { read: ["**"] },
        capabilities: { "screen-recording": true },
        future: { whatever: 1 },
      };
      const result = parseAppPermissions(input);
      expect(result.ok).toBe(true);
      if (result.ok === false) return;
      expect(result.manifest.raw).toEqual(input);
      expect(result.manifest.fs).toEqual({ read: ["**"] });
      expect(result.manifest.net).toBeUndefined();
    });

    it("preserves unknown sub-keys inside recognised slices", () => {
      const input = { fs: { read: ["**"], future: { whatever: 1 } } };
      const result = parseAppPermissions(input);
      expect(result.ok).toBe(true);
      if (result.ok === false) return;
      // The recognised slice only surfaces `read`; the unknown sub-key
      // is preserved under raw via the slice's own object.
      expect(result.manifest.fs).toEqual({ read: ["**"] });
      expect(result.manifest.raw).toEqual(input);
    });
  });

  describe("combined", () => {
    it("parses fs and net together", () => {
      const result = parseAppPermissions({
        fs: { read: ["state/**"], write: ["state/**"] },
        net: { outbound: ["api.foo.com"] },
      });
      expect(result.ok).toBe(true);
      if (result.ok === false) return;
      expect(result.manifest.fs).toEqual({
        read: ["state/**"],
        write: ["state/**"],
      });
      expect(result.manifest.net).toEqual({ outbound: ["api.foo.com"] });
    });

    it("propagates the first error encountered (fs before net)", () => {
      const result = parseAppPermissions({
        fs: { read: 42 },
        net: { outbound: 99 },
      });
      expect(result.ok).toBe(false);
      if (result.ok === true) return;
      expect(result.path).toBe("permissions.fs.read");
    });
  });
});
