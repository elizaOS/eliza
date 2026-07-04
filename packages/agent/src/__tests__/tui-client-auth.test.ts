/**
 * Unit-tests the TUI client's auth-token helpers (`resolveTuiApiToken` /
 * `buildTuiAuthHeaders`): pure functions over an env-like record that decide
 * whether the terminal client sends a Bearer header past the backend's
 * loopback-trust gate. No network or backend.
 */
import { describe, expect, it } from "vitest";
import {
  buildTuiAuthHeaders,
  resolveTuiApiToken,
} from "../tui/agent-terminal-tui";

/**
 * #9946: the TUI client must be able to authenticate past the backend's
 * loopback-trust gate (a tunnel/proxy injects X-Forwarded-For, disabling it).
 * It reads ELIZA_API_TOKEN — the exact key isAuthorized validates — and sends a
 * Bearer header when present, and nothing when absent (loopback unchanged).
 */
describe("TUI client auth (#9946)", () => {
  it("resolves ELIZA_API_TOKEN when set, null otherwise", () => {
    expect(resolveTuiApiToken({ ELIZA_API_TOKEN: "secret-123" })).toBe(
      "secret-123",
    );
    expect(resolveTuiApiToken({ ELIZA_API_TOKEN: "  padded  " })).toBe(
      "padded",
    );
    expect(resolveTuiApiToken({})).toBeNull();
    expect(resolveTuiApiToken({ ELIZA_API_TOKEN: "   " })).toBeNull();
  });

  it("attaches an Authorization: Bearer header only when a token is configured", () => {
    expect(buildTuiAuthHeaders({ ELIZA_API_TOKEN: "tok" })).toEqual({
      Authorization: "Bearer tok",
    });
    expect(buildTuiAuthHeaders({})).toEqual({});
  });
});
