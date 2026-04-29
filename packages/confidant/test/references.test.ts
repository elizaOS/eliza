import { describe, expect, it } from "vitest";
import {
  buildReference,
  InvalidReferenceError,
  parseReference,
} from "../src/references.js";

describe("references", () => {
  it("parses every supported scheme", () => {
    expect(parseReference("file://").source).toBe("file");
    expect(parseReference("keyring://elizaos/llm.openrouter.apiKey").source).toBe(
      "keyring",
    );
    expect(parseReference("op://Personal/OpenRouter/api-key").source).toBe(
      "1password",
    );
    expect(parseReference("pass://default/openrouter").source).toBe("protonpass");
    expect(parseReference("env://OPENROUTER_API_KEY").source).toBe("env-legacy");
    expect(parseReference("cloud://path").source).toBe("cloud");
  });

  it("rejects unknown schemes", () => {
    expect(() => parseReference("unknown://value")).toThrow(InvalidReferenceError);
  });

  it("rejects missing scheme", () => {
    expect(() => parseReference("just-a-string")).toThrow(InvalidReferenceError);
    expect(() => parseReference("://nothing")).toThrow(InvalidReferenceError);
  });

  it("rejects empty path on schemes that require one", () => {
    expect(() => parseReference("op://")).toThrow(InvalidReferenceError);
    expect(() => parseReference("env://")).toThrow(InvalidReferenceError);
  });

  it("allows empty path on file://", () => {
    expect(parseReference("file://").path).toBe("");
  });

  it("buildReference roundtrips with parseReference", () => {
    const cases: ReadonlyArray<[Parameters<typeof buildReference>[0], string]> = [
      ["file", ""],
      ["keyring", "elizaos/foo"],
      ["1password", "Personal/Item/field"],
      ["protonpass", "default/openrouter"],
      ["env-legacy", "OPENROUTER_API_KEY"],
      ["cloud", "path/to/secret"],
    ];
    for (const [source, path] of cases) {
      const ref = buildReference(source, path);
      const parsed = parseReference(ref);
      expect(parsed.source).toBe(source);
      expect(parsed.path).toBe(path);
    }
  });

  it("preserves the raw reference on parse", () => {
    const ref = "op://Personal/OpenRouter/api-key";
    expect(parseReference(ref).raw).toBe(ref);
  });
});
