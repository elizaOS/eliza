// Exercises app network utils behavior with deterministic cloud-shared lib fixtures.
import { describe, expect, test } from "bun:test";
import {
  appNetworkName,
  buildAppContainerSecurityFlags,
  buildAppEgressEnv,
  buildEnsureAppNetworkCmd,
  buildLoopbackPortPublishFlag,
  buildSquidAllowlistConf,
} from "../app-network-utils";

const APP_ID = "11111111-2222-3333-4444-555555555555";

describe("appNetworkName", () => {
  test("derives a stable per-app network name", () => {
    const n = appNetworkName(APP_ID);
    expect(n).toBe(appNetworkName(APP_ID));
    expect(n).toMatch(/^app-net-[a-z0-9]+$/);
    // never the shared agent network
    expect(n).not.toBe("containers-isolated");
  });

  test("throws on empty or non-alphanumeric app ID", () => {
    expect(() => appNetworkName("")).toThrow(/Invalid app ID/);
    expect(() => appNetworkName("---")).toThrow(/Invalid app ID/);
  });
});

describe("buildEnsureAppNetworkCmd — isolation is real (--internal)", () => {
  const cmd = buildEnsureAppNetworkCmd("app-net-x");

  test("creates an --internal bridge (the load-bearing flag)", () => {
    expect(cmd).toContain("--driver bridge --internal");
    expect(cmd).toContain("app-net-x");
  });

  test("never references the shared agent network name", () => {
    expect(cmd).not.toContain("containers-isolated");
  });
});

describe("buildAppContainerSecurityFlags — untrusted-image hardening", () => {
  const flags = buildAppContainerSecurityFlags();
  const joined = flags.join(" ");

  test("drops all caps, forbids privilege escalation, bounds pids", () => {
    expect(joined).toContain("--cap-drop=ALL");
    expect(joined).toContain("no-new-privileges");
    expect(joined).toContain("--pids-limit=512");
  });

  test("NEVER grants the agent-only network escapes", () => {
    expect(joined).not.toContain("NET_ADMIN");
    expect(joined).not.toContain("/dev/net/tun");
    expect(joined).not.toContain("--privileged");
    expect(joined).not.toContain("host.docker.internal");
    expect(joined).not.toContain("cap-add");
  });

  test("honors a custom pids limit", () => {
    expect(buildAppContainerSecurityFlags({ pidsLimit: 128 }).join(" ")).toContain(
      "--pids-limit=128",
    );
  });
});

describe("buildLoopbackPortPublishFlag", () => {
  test("binds published ports to host loopback only", () => {
    expect(buildLoopbackPortPublishFlag(49001, 3000)).toBe("-p 127.0.0.1:49001:3000");
    expect(buildLoopbackPortPublishFlag(49002, "8080")).toBe("-p 127.0.0.1:49002:8080");
  });

  test("rejects invalid host ports", () => {
    expect(() => buildLoopbackPortPublishFlag(0, 3000)).toThrow(/Invalid host port/);
    expect(() => buildLoopbackPortPublishFlag(-1, 3000)).toThrow(/Invalid host port/);
    expect(() => buildLoopbackPortPublishFlag(70000, 3000)).toThrow(/Invalid host port/);
    expect(() => buildLoopbackPortPublishFlag(Number.NaN, 3000)).toThrow(/Invalid host port/);
  });

  test("rejects invalid or injection-like container ports", () => {
    expect(() => buildLoopbackPortPublishFlag(8080, "3000; rm -rf /")).toThrow(
      /Invalid container port/,
    );
    expect(() => buildLoopbackPortPublishFlag(8080, 0)).toThrow(/Invalid container port/);
    expect(() => buildLoopbackPortPublishFlag(8080, 70000)).toThrow(/Invalid container port/);
  });
});

describe("buildAppEgressEnv", () => {
  test("routes all HTTP(S) egress through the proxy, bypassing localhost", () => {
    const env = buildAppEgressEnv("http://egress-gw:3128");
    expect(env.HTTP_PROXY).toBe("http://egress-gw:3128");
    expect(env.HTTPS_PROXY).toBe("http://egress-gw:3128");
    expect(env.http_proxy).toBe("http://egress-gw:3128");
    expect(env.NO_PROXY).toContain("127.0.0.1");
  });
});

describe("buildSquidAllowlistConf — default deny", () => {
  test("allows only listed hosts and denies everything else", () => {
    const conf = buildSquidAllowlistConf(["api.stripe.com", "*.elizacloud.ai"]);
    expect(conf).toContain("acl allowed_dst dstdomain api.stripe.com");
    expect(conf).toContain("acl allowed_dst dstdomain *.elizacloud.ai");
    expect(conf).toContain("http_access allow allowed_dst");
    expect(conf).toContain("http_access deny all");
  });

  test("an empty allowlist denies everything (no allow line)", () => {
    const conf = buildSquidAllowlistConf([]);
    expect(conf).toContain("http_access deny all");
    expect(conf).not.toContain("http_access allow");
  });

  test("ignores malformed/injection-y host entries", () => {
    const conf = buildSquidAllowlistConf(["evil.com\nhttp_access allow all"]);
    expect(conf).not.toContain("http_access allow all");
  });
});
