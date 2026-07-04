/**
 * Verifies extractDevServerUrl.
 * Deterministic unit test of pure helpers; no runtime, no live model.
 */
import { describe, expect, it } from "vitest";
import { extractDevServerUrl } from "../../src/services/ansi-utils.js";

// #9146 — surfacing a spawned dev server's URL into chat means parsing it out of
// noisy (often ANSI-colored) CLI output. Pin the localhost/loopback match.
describe("extractDevServerUrl", () => {
  it("extracts localhost / loopback URLs with a port", () => {
    expect(extractDevServerUrl("  ➜  Local:   http://localhost:5173/")).toBe(
      "http://localhost:5173/",
    );
    expect(extractDevServerUrl("server running at http://127.0.0.1:3000")).toBe(
      "http://127.0.0.1:3000",
    );
    expect(extractDevServerUrl("Listening on http://0.0.0.0:8080/app")).toBe(
      "http://0.0.0.0:8080/app",
    );
  });

  it("strips ANSI color before matching", () => {
    expect(extractDevServerUrl("[32mhttp://localhost:4321[0m")).toBe(
      "http://localhost:4321",
    );
  });

  it("returns null when there is no local dev URL", () => {
    expect(extractDevServerUrl("https://example.com/no-port")).toBeNull();
    expect(extractDevServerUrl("building...")).toBeNull();
  });
});
