import { describe, expect, test } from "bun:test";
import {
  buildAppNodeNftablesRules,
  buildHetznerAppFirewallRules,
  CLOUD_METADATA_IP,
  RFC1918_RANGES,
} from "../app-firewall-utils";

describe("buildAppNodeNftablesRules", () => {
  const rules = buildAppNodeNftablesRules({ egressProxyIp: "10.200.0.5" });

  test("default-drops the forward chain", () => {
    expect(rules).toContain("policy drop;");
  });

  test("blocks the cloud metadata endpoint and every RFC1918 range", () => {
    expect(rules).toContain(`ip daddr ${CLOUD_METADATA_IP} drop`);
    for (const range of RFC1918_RANGES) {
      expect(rules).toContain(`ip daddr ${range} drop`);
    }
  });

  test("allows established return traffic and the egress proxy", () => {
    expect(rules).toContain("ct state established,related accept");
    expect(rules).toContain("ip daddr 10.200.0.5 accept");
  });

  test("omits the proxy allow when no proxy ip is given", () => {
    expect(buildAppNodeNftablesRules()).not.toContain("accept\n    }");
  });

  test("allows the apps private subnet before the RFC1918 drop (tenant DB ambassador)", () => {
    const rules = buildAppNodeNftablesRules({
      egressProxyIp: "172.17.0.1",
      allowedPrivateCidrs: ["10.30.0.0/16"],
    });
    const proxyIdx = rules.indexOf("ip daddr 172.17.0.1 accept");
    const privateIdx = rules.indexOf("ip daddr 10.30.0.0/16 accept");
    const rfc1918Idx = rules.indexOf("ip daddr 10.0.0.0/8 drop");
    expect(proxyIdx).toBeGreaterThan(-1);
    expect(privateIdx).toBeGreaterThan(proxyIdx);
    expect(rfc1918Idx).toBeGreaterThan(privateIdx);
  });
});

describe("buildHetznerAppFirewallRules", () => {
  test("allows inbound to the host-port range only from control-plane CIDRs", () => {
    const rules = buildHetznerAppFirewallRules({
      controlPlaneCidrs: ["10.0.0.1/32"],
      hostPortRange: "49000-49999",
    });
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({
      direction: "in",
      protocol: "tcp",
      port: "49000-49999",
      source_ips: ["10.0.0.1/32"],
    });
  });
});
