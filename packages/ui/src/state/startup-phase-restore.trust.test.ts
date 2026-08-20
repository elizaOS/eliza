/** Verifies persisted remote and Cloud runtime URL trust gates. */
// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  isTrustedCloudApiBaseUrl,
  isTrustedRestoreApiBaseUrl,
} from "./runtime-url-trust";

/**
 * The persisted active-server / agent-profile record is localStorage-backed and
 * could be tampered by an XSS or a malicious same-origin plugin view. The
 * restore + profile-switch paths only dial a "remote" apiBase whose host is
 * trusted; this locks which hosts pass (loopback / current-origin / private-LAN)
 * vs an arbitrary public attacker host (rejected, fail closed).
 */
describe("isTrustedRestoreApiBaseUrl", () => {
  it("trusts loopback and local-agent hosts", () => {
    expect(isTrustedRestoreApiBaseUrl("http://localhost:31337")).toBe(true);
    expect(isTrustedRestoreApiBaseUrl("http://127.0.0.1:31337")).toBe(true);
    expect(isTrustedRestoreApiBaseUrl("http://[::1]:2138")).toBe(true);
    expect(isTrustedRestoreApiBaseUrl("http://0.0.0.0")).toBe(true);
  });

  it("trusts the current page origin", () => {
    // jsdom default origin is http://localhost (already loopback); assert an
    // explicit same-host URL passes regardless.
    expect(isTrustedRestoreApiBaseUrl(`${window.location.origin}/api`)).toBe(
      true,
    );
  });

  it("trusts private / LAN / CGNAT / link-local hosts and private suffixes", () => {
    expect(isTrustedRestoreApiBaseUrl("http://192.168.1.50:31337")).toBe(true);
    expect(isTrustedRestoreApiBaseUrl("http://10.0.0.5")).toBe(true);
    expect(isTrustedRestoreApiBaseUrl("http://172.16.0.9")).toBe(true);
    expect(isTrustedRestoreApiBaseUrl("http://100.96.0.1")).toBe(true); // tailscale CGNAT
    expect(isTrustedRestoreApiBaseUrl("http://169.254.1.1")).toBe(true);
    expect(isTrustedRestoreApiBaseUrl("http://my-box.local")).toBe(true);
    expect(isTrustedRestoreApiBaseUrl("http://agent.ts.net")).toBe(true);
    expect(isTrustedRestoreApiBaseUrl("http://[fd00::1]")).toBe(true);
  });

  it("rejects arbitrary public hosts (the attacker-write vector)", () => {
    expect(isTrustedRestoreApiBaseUrl("https://attacker.example/")).toBe(false);
    expect(isTrustedRestoreApiBaseUrl("https://1.2.3.4/")).toBe(false);
    // 172.32 is outside the RFC1918 172.16-31 block.
    expect(isTrustedRestoreApiBaseUrl("http://172.32.0.1")).toBe(false);
    // 100.128 is outside the CGNAT 100.64-127 block.
    expect(isTrustedRestoreApiBaseUrl("http://100.128.0.1")).toBe(false);
    expect(
      isTrustedRestoreApiBaseUrl("http://evil.example.local.attacker.com"),
    ).toBe(false);
  });

  it("rejects non-http(s) schemes, malformed input, and empty values", () => {
    expect(isTrustedRestoreApiBaseUrl("javascript:alert(1)")).toBe(false);
    expect(isTrustedRestoreApiBaseUrl("file:///etc/passwd")).toBe(false);
    expect(isTrustedRestoreApiBaseUrl("not a url")).toBe(false);
    expect(isTrustedRestoreApiBaseUrl(undefined)).toBe(false);
    expect(isTrustedRestoreApiBaseUrl("")).toBe(false);
  });

  it("trusts the bundled on-device agent's IPC pseudo-base (iOS/Android local mode)", () => {
    // The mobile local-agent record is kind:"remote" with the in-process IPC
    // base — no network dial, no attacker-choosable host. Rejecting it made
    // every relaunch of a local-mode phone drop its saved on-device server
    // and silently un-complete first-run (found via the #11110 device boot
    // trace: boot ended at chat-first onboarding with no startup poll and
    // the Bun engine never started).
    expect(isTrustedRestoreApiBaseUrl("eliza-local-agent://ipc")).toBe(true);
    expect(isTrustedRestoreApiBaseUrl("eliza-local-agent://ipc/")).toBe(true);
    expect(
      isTrustedRestoreApiBaseUrl(
        "eliza-remote://session/23766030-0000-0000-0000-000000000000",
      ),
    ).toBe(true);
  });

  it("still rejects other custom schemes and non-IPC authorities on the IPC scheme", () => {
    expect(isTrustedRestoreApiBaseUrl("evil-local-agent://ipc")).toBe(false);
    expect(isTrustedRestoreApiBaseUrl("eliza-local-agent://attacker.com")).toBe(
      false,
    );
  });
});

describe("isTrustedCloudApiBaseUrl", () => {
  const AGENT = "11111111-1111-4111-8111-111111111111";
  const OTHER_AGENT = "22222222-2222-4222-8222-222222222222";

  it("binds production and staging dedicated hosts to one agent label", () => {
    expect(
      isTrustedCloudApiBaseUrl(`https://${AGENT}.elizacloud.ai`, AGENT),
    ).toBe(true);
    expect(
      isTrustedCloudApiBaseUrl(
        `https://${AGENT}.staging.elizacloud.ai/`,
        AGENT,
      ),
    ).toBe(true);
    expect(
      isTrustedCloudApiBaseUrl(`https://${AGENT}.elizacloud.ai`, OTHER_AGENT),
    ).toBe(false);
    expect(
      isTrustedCloudApiBaseUrl(`https://nested.${AGENT}.elizacloud.ai`, AGENT),
    ).toBe(false);
    expect(
      isTrustedCloudApiBaseUrl(
        `https://${AGENT}.elizacloud.ai/api/status`,
        AGENT,
      ),
    ).toBe(false);
    expect(
      isTrustedCloudApiBaseUrl(`https://${AGENT}.elizacloud.ai`, "bad/id"),
    ).toBe(false);
    expect(isTrustedCloudApiBaseUrl("https://not-an-agent.elizacloud.ai")).toBe(
      false,
    );
  });

  it("binds shared Cloud adapter paths to the expected agent", () => {
    const base = "https://api-staging.elizacloud.ai/api/v1/eliza/agents";
    expect(isTrustedCloudApiBaseUrl(`${base}/${AGENT}`, AGENT)).toBe(true);
    expect(isTrustedCloudApiBaseUrl(`${base}/${AGENT}/bridge`, AGENT)).toBe(
      true,
    );
    expect(isTrustedCloudApiBaseUrl(`${base}/${AGENT}`, OTHER_AGENT)).toBe(
      false,
    );
    expect(
      isTrustedCloudApiBaseUrl(`${base}/${encodeURIComponent(`${AGENT}/x`)}`),
    ).toBe(false);
    expect(isTrustedCloudApiBaseUrl(`${base}/not-an-agent`)).toBe(false);
  });

  it("binds a rowless personal identity only to its exact Shared adapter", () => {
    const personalId = "personal:00000000-0000-5000-8000-000000000001";
    const encoded = encodeURIComponent(personalId);

    expect(
      isTrustedCloudApiBaseUrl(
        `https://api.eliza.app/api/v1/eliza/agents/${encoded}`,
        personalId,
      ),
    ).toBe(true);
    expect(
      isTrustedCloudApiBaseUrl(
        `https://api.eliza.app/api/v1/eliza/agents/${encoded}`,
        "personal:00000000-0000-5000-8000-000000000002",
      ),
    ).toBe(false);
    expect(
      isTrustedCloudApiBaseUrl(`https://${AGENT}.elizacloud.ai`, personalId),
    ).toBe(false);
  });

  it("allows agentless control-plane roots only before an owner is selected", () => {
    expect(isTrustedCloudApiBaseUrl("https://elizacloud.ai")).toBe(true);
    expect(
      isTrustedCloudApiBaseUrl("https://api.elizacloud.ai/api/v1/eliza/agents"),
    ).toBe(true);
    expect(isTrustedCloudApiBaseUrl("https://elizacloud.ai", AGENT)).toBe(
      false,
    );
    expect(isTrustedCloudApiBaseUrl("https://docs.elizacloud.ai")).toBe(false);
  });

  it("allows strict loopback roots without widening to arbitrary paths", () => {
    expect(isTrustedCloudApiBaseUrl("http://127.0.0.1:31337", AGENT)).toBe(
      true,
    );
    expect(isTrustedCloudApiBaseUrl("https://localhost:2138/", AGENT)).toBe(
      true,
    );
    expect(isTrustedCloudApiBaseUrl("http://[::1]:31337", AGENT)).toBe(true);
    expect(isTrustedCloudApiBaseUrl("http://127.0.0.1:31337/api", AGENT)).toBe(
      false,
    );
    expect(isTrustedCloudApiBaseUrl("http://127.0.0.1.evil.test", AGENT)).toBe(
      false,
    );
  });

  it("rejects public sinks and URL components that can change authority", () => {
    expect(
      isTrustedCloudApiBaseUrl("https://credential-sink.example", AGENT),
    ).toBe(false);
    expect(
      isTrustedCloudApiBaseUrl(`http://${AGENT}.elizacloud.ai`, AGENT),
    ).toBe(false);
    expect(
      isTrustedCloudApiBaseUrl(`https://${AGENT}.elizacloud.ai:444`, AGENT),
    ).toBe(false);
    expect(
      isTrustedCloudApiBaseUrl(
        `https://user:pass@${AGENT}.elizacloud.ai`,
        AGENT,
      ),
    ).toBe(false);
    expect(
      isTrustedCloudApiBaseUrl(
        `https://${AGENT}.elizacloud.ai?next=evil`,
        AGENT,
      ),
    ).toBe(false);
    expect(
      isTrustedCloudApiBaseUrl(`https://${AGENT}.elizacloud.ai#evil`, AGENT),
    ).toBe(false);
  });
});
