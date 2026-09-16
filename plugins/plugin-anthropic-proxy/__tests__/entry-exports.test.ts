/**
 * Guards the programmatic export surface requested in
 * https://github.com/elizaOS/eliza/issues/11496 — downstream consumers embed
 * the proxy's request headers directly and need this behavior reachable from
 * the package entry without a deep import.
 */

import { describe, expect, it } from "vitest";
import { getStainlessHeaders } from "../index.js";

describe("package entry exports (#11496)", () => {
  it("exports getStainlessHeaders returning the CC identity header set", () => {
    const headers = getStainlessHeaders();
    expect(headers["user-agent"]).toMatch(/^claude-cli\//);
    expect(headers["x-app"]).toBe("cli");
    expect(headers["x-stainless-lang"]).toBe("js");
    expect(headers["x-stainless-runtime"]).toBe("node");
  });
});
