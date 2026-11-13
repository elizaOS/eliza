import assert from "node:assert/strict";
import test from "node:test";
import { parseBrowserWorkspaceInputUrl } from "./browser-workspace-host-identity.ts";

test("address bar input: host:port is a host, other schemes are rejected", () => {
  assert.deepEqual(parseBrowserWorkspaceInputUrl("localhost:3000"), {
    ok: true,
    url: "https://localhost:3000/",
  });
  assert.deepEqual(parseBrowserWorkspaceInputUrl("example.com:8443/x"), {
    ok: true,
    url: "https://example.com:8443/x",
  });
  assert.deepEqual(parseBrowserWorkspaceInputUrl("http://localhost:3000/a"), {
    ok: true,
    url: "http://localhost:3000/a",
  });
  assert.deepEqual(parseBrowserWorkspaceInputUrl("about:blank"), {
    ok: true,
    url: "about:blank",
  });
  assert.deepEqual(parseBrowserWorkspaceInputUrl("javascript:alert(1)"), {
    ok: false,
    reason: "unsupported",
  });
  assert.deepEqual(parseBrowserWorkspaceInputUrl("mailto:a@example.com"), {
    ok: false,
    reason: "unsupported",
  });
  assert.deepEqual(parseBrowserWorkspaceInputUrl("   "), {
    ok: false,
    reason: "empty",
  });
});
