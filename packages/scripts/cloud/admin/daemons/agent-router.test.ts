import { describe, expect, it } from "bun:test";
import { resolveSandboxRouting } from "./agent-router";

describe("resolveSandboxRouting", () => {
  it("prefers headscale IP for the target when bridge metadata is available", () => {
    expect(
      resolveSandboxRouting({
        status: "running",
        bridge_url: "http://172.18.0.10:18791",
        headscale_ip: "100.64.0.21",
        web_ui_port: 20001,
      }),
    ).toEqual({
      headscaleIp: "100.64.0.21",
      bridgePort: 18791,
      webUiPort: 20001,
      target: "100.64.0.21:20001",
    });
  });

  it("falls back to bridge URL host for legacy sandboxes without headscale IP", () => {
    expect(
      resolveSandboxRouting({
        status: "running",
        bridge_url: "http://172.18.0.10:18791",
        headscale_ip: null,
        web_ui_port: 20001,
      }),
    ).toMatchObject({
      headscaleIp: "172.18.0.10",
      target: "172.18.0.10:20001",
    });
  });

  it("does not let malformed bridge URL override valid headscale IP", () => {
    expect(
      resolveSandboxRouting({
        status: "running",
        bridge_url: "not a url",
        headscale_ip: "100.64.0.21",
        web_ui_port: 20001,
      }),
    ).toBeNull();
  });
});
