// SSRF guard for stored Web Push endpoints. Only third-party HTTPS push services
// may be persisted, since the cloud sender later POSTs to whatever is stored.
import { describe, expect, test } from "vitest";
import { isValidPushEndpoint } from "./endpoint-validation";

describe("isValidPushEndpoint", () => {
  test.each([
    "https://web.push.apple.com/QABC123",
    "https://fcm.googleapis.com/fcm/send/abc",
    "https://updates.push.services.mozilla.com/wpush/v2/xyz",
    "https://push.example.com:8443/path",
  ])("accepts real third-party push endpoint: %s", (url) => {
    expect(isValidPushEndpoint(url)).toBe(true);
  });

  test.each([
    ["not a url", "nope"],
    ["http (not https)", "http://push.example.com/abc"],
    ["ws scheme", "ws://push.example.com/abc"],
    ["file scheme", "file:///etc/passwd"],
    ["localhost", "https://localhost/abc"],
    ["*.localhost", "https://foo.localhost/abc"],
    ["*.local", "https://printer.local/abc"],
    ["*.internal", "https://redis.internal/abc"],
    ["loopback 127.0.0.1", "https://127.0.0.1/abc"],
    ["0.0.0.0", "https://0.0.0.0/abc"],
    ["private 10.x", "https://10.1.2.3/abc"],
    ["private 192.168.x", "https://192.168.0.1/abc"],
    ["private 172.16-31.x", "https://172.20.10.5/abc"],
    ["link-local / metadata 169.254.169.254", "https://169.254.169.254/latest"],
    ["multicast 224.x", "https://224.0.0.1/abc"],
    ["IPv6 loopback literal", "https://[::1]/abc"],
    ["IPv6 literal", "https://[2001:db8::1]/abc"],
  ])("rejects %s", (_label, url) => {
    expect(isValidPushEndpoint(url)).toBe(false);
  });

  test("accepts a public IPv4 push host (rare but valid)", () => {
    expect(isValidPushEndpoint("https://8.8.8.8/abc")).toBe(true);
  });
});
