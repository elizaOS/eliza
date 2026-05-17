import { describe, expect, it } from "vitest";
import { isAllowedOrigin } from "./server-cors";

describe("server CORS origin allowlist", () => {
  it("allows the packaged Electrobun views scheme used by the desktop renderer", () => {
    expect(isAllowedOrigin("views://")).toBe(true);
  });

  it("continues to reject untrusted custom browser schemes", () => {
    expect(isAllowedOrigin("evil://localhost")).toBe(false);
  });
});
