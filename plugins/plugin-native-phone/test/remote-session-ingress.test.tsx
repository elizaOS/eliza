import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToString } from "react-dom/server";
import { RemoteSession } from "../src/companion/components/RemoteSession";

/**
 * Renders the real RemoteSession component on the server. Rendering runs the
 * component's ingress check, so an accepted host builds the viewer URL in the
 * output and a rejected host renders the guard's error instead.
 */
function renderIngress(ingressUrl: string): string {
  return renderToString(
    React.createElement(RemoteSession, {
      payload: {
        agentId: "agent-1",
        pairingCode: "123456",
        ingressUrl,
        sessionToken: "token-1",
      },
      onExit: () => {},
    }),
  );
}

describe("RemoteSession companion ingress guard", () => {
  // Link-local is fe80::/10: the first hextet runs fe80-febf, not only fe80.
  test.each([
    "fe80::1",
    "fe90::1",
    "fea0::1",
    "febf::1",
    // Site-local entry kept from the original prefix list.
    "fec0::1",
    // Unique-local fc00::/7 needs a full first hextet (fc00-fdff).
    "fc00::1",
    "fd12::1",
  ])("allows plaintext ws to the private host %s", (host) => {
    const html = renderIngress(`ws://[${host}]:9000/input`);
    expect(html).not.toContain("ws:// is only allowed");
    expect(html).toContain("/vnc");
  });

  test("allows plaintext ws to an RFC1918 host without brackets", () => {
    const html = renderIngress("ws://192.168.1.10:9000/input");
    expect(html).not.toContain("ws:// is only allowed");
    expect(html).toContain("/vnc");
  });

  // fc::1 and fd::1 have first hextets 0x00fc / 0x00fd, outside fc00::/7;
  // the old bare "fc" / "fd" prefixes wrongly treated them as private.
  test.each(["fc::1", "fd::1", "8.8.8.8"])(
    "rejects plaintext ws to the non-private host %s",
    (host) => {
      const url = host.includes(":")
        ? `ws://[${host}]:9000/input`
        : `ws://${host}:9000/input`;
      const html = renderIngress(url);
      expect(html).toContain("ws:// is only allowed");
    },
  );

  test("still allows wss to a public host", () => {
    const html = renderIngress("wss://8.8.8.8:9000/input");
    expect(html).not.toContain("ws:// is only allowed");
    expect(html).toContain("/vnc");
  });
});
