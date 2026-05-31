import { describe, expect, mock, test } from "bun:test";

mock.module("@/db/repositories/agent-sandboxes", () => ({
  agentSandboxesRepository: {
    findById: mock(),
  },
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    error: mock(),
    warn: mock(),
  },
}));

const { resolveHeadscaleLookupPayload } = await import(
  "../agents/[id]/headscale-ip/route"
);

describe("resolveHeadscaleLookupPayload", () => {
  test("requires a persisted headscale IP instead of routing through stale host metadata", () => {
    expect(
      resolveHeadscaleLookupPayload({
        status: "running",
        headscale_ip: null,
        web_ui_port: 20001,
      }),
    ).toEqual({
      ok: false,
      status: 503,
      error: "agent has no routable Headscale IP",
    });
  });

  test("returns the headscale IP and web UI port for routable sandboxes", () => {
    expect(
      resolveHeadscaleLookupPayload({
        status: "running",
        headscale_ip: "100.64.0.21",
        web_ui_port: 20001,
      }),
    ).toEqual({
      ok: true,
      payload: {
        headscale_ip: "100.64.0.21",
        web_ui_port: 20001,
        status: "running",
      },
    });
  });
});
