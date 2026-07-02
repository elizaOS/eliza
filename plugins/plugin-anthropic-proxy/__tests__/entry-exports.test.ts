/**
 * Guards the programmatic export surface requested in
 * https://github.com/elizaOS/eliza/issues/11496 — downstream consumers embed
 * the proxy's request-transformation pieces directly and need these reachable
 * from the package entry (no deep imports, no vendored copies).
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_REVERSE_MAP,
  DEFAULT_TOOL_RENAMES,
  getStainlessHeaders,
} from "../index.js";

describe("package entry exports (#11496)", () => {
  it("exports getStainlessHeaders returning the CC identity header set", () => {
    const headers = getStainlessHeaders();
    expect(headers["user-agent"]).toMatch(/^claude-cli\//);
    expect(headers["x-app"]).toBe("cli");
    expect(headers["x-stainless-lang"]).toBe("js");
    expect(headers["x-stainless-runtime"]).toBe("node");
  });

  it("exports the default fingerprint rename dictionaries", () => {
    expect(DEFAULT_TOOL_RENAMES.length).toBeGreaterThan(0);
    expect(DEFAULT_REVERSE_MAP.length).toBeGreaterThan(0);
    for (const pair of DEFAULT_TOOL_RENAMES) {
      expect(pair).toHaveLength(2);
      expect(typeof pair[0]).toBe("string");
      expect(typeof pair[1]).toBe("string");
    }
    for (const pair of DEFAULT_REVERSE_MAP) {
      expect(pair).toHaveLength(2);
      expect(typeof pair[0]).toBe("string");
      expect(typeof pair[1]).toBe("string");
    }
  });
});
