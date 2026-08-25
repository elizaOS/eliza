/**
 * Verifies the terminal dedicated-agent failure classifier used by startup
 * polling and runtime recovery. Direct deterministic suite: calls the real
 * classifier with literal fixtures against the real dedicated-base predicate
 * (no mocks); companion coverage lives inside startup-phase-poll.test.ts.
 */

import { describe, expect, it } from "vitest";
import { isTerminalDedicatedCloudAgentErrorState } from "./dedicated-cloud-agent-error";

// Execution-verified dedicated bases (isDedicatedCloudAgentBase === true):
// any single DNS label on a dedicated suffix (elizacloud.ai, cloud.eliza.app)
// and the local development path form on a loopback host.
const DEDICATED_BASE =
  "https://67ae7b68-6351-41db-a79a-a1d157265018.elizacloud.ai";
const DEDICATED_CLOUD_ELIZA_APP_BASE =
  "https://67ae7b68-6351-41db-a79a-a1d157265018.cloud.eliza.app";
const DEDICATED_LOOPBACK_PATH_BASE =
  "http://localhost:3000/api/v1/eliza/agents/67ae7b68-6351-41db-a79a-a1d157265018";

// Not classified as dedicated: hosts without a dedicated suffix (the bare
// eliza.app marketing host and any unrelated origin) never reach the reason
// arms, so no failure shape is terminal for them.
const NON_DEDICATED_BASE = "https://example.com";
const UNSUFFIXED_AGENT_LIKE_BASE = "https://agent-1.eliza.app";

describe("isTerminalDedicatedCloudAgentErrorState", () => {
  describe("HTTP status gate: terminal only on 503 from the dedicated proxy", () => {
    it.each([500, 502, 504, 404, 200])(
      "returns false on status %i even with a terminal code on a dedicated base",
      (status) => {
        expect(
          isTerminalDedicatedCloudAgentErrorState({
            status,
            code: "agent_error_state",
            message: "Agent is in an error state",
            data: { data: { status: "stopped" } },
            clientBaseUrl: DEDICATED_BASE,
          }),
        ).toBe(false);
      },
    );

    it("returns false when status is undefined", () => {
      expect(
        isTerminalDedicatedCloudAgentErrorState({
          status: undefined,
          code: "agent_error_state",
          message: "Agent is in an error state",
          clientBaseUrl: DEDICATED_BASE,
        }),
      ).toBe(false);
    });

    it("returns true on 503 with the terminal code on a dedicated base", () => {
      expect(
        isTerminalDedicatedCloudAgentErrorState({
          status: 503,
          code: "agent_error_state",
          message: null,
          clientBaseUrl: DEDICATED_BASE,
        }),
      ).toBe(true);
    });
  });

  describe("dedicated-base gate: non-dedicated bases are never terminal", () => {
    it.each([
      ["unrelated origin", NON_DEDICATED_BASE],
      ["subdomain without a dedicated suffix", UNSUFFIXED_AGENT_LIKE_BASE],
    ])(
      "returns false for a %s regardless of a matching failure reason",
      (_label, base) => {
        expect(
          isTerminalDedicatedCloudAgentErrorState({
            status: 503,
            code: "agent_error_state",
            message: "Agent is in an error state",
            data: { data: { status: "stopped" } },
            clientBaseUrl: base,
          }),
        ).toBe(false);
      },
    );

    it.each([
      ["elizacloud.ai uuid subdomain", DEDICATED_BASE],
      ["cloud.eliza.app uuid subdomain", DEDICATED_CLOUD_ELIZA_APP_BASE],
      ["loopback host with the agents path", DEDICATED_LOOPBACK_PATH_BASE],
    ])("treats the %s as a dedicated base", (_label, base) => {
      expect(
        isTerminalDedicatedCloudAgentErrorState({
          status: 503,
          code: "agent_error_state",
          message: null,
          clientBaseUrl: base,
        }),
      ).toBe(true);
    });
  });

  describe("reason arm: code === agent_error_state", () => {
    it("matches without any message or structured data", () => {
      expect(
        isTerminalDedicatedCloudAgentErrorState({
          status: 503,
          code: "agent_error_state",
          message: null,
          clientBaseUrl: DEDICATED_BASE,
        }),
      ).toBe(true);
    });

    it("does not match a differently-cased code", () => {
      expect(
        isTerminalDedicatedCloudAgentErrorState({
          status: 503,
          code: "AGENT_ERROR_STATE",
          message: null,
          clientBaseUrl: DEDICATED_BASE,
        }),
      ).toBe(false);
    });
  });

  describe("reason arm: agent_not_running with a structured control-plane status", () => {
    it.each(["sleeping", "stopped", "suspended", "error"])(
      "is terminal when the nested status is %s",
      (status) => {
        expect(
          isTerminalDedicatedCloudAgentErrorState({
            status: 503,
            code: "agent_not_running",
            message: "Dedicated agent is not running yet",
            data: { data: { status } },
            clientBaseUrl: DEDICATED_BASE,
          }),
        ).toBe(true);
      },
    );

    it("matches the nested status case-insensitively", () => {
      expect(
        isTerminalDedicatedCloudAgentErrorState({
          status: 503,
          code: "agent_not_running",
          message: null,
          data: { data: { status: "Suspended" } },
          clientBaseUrl: DEDICATED_BASE,
        }),
      ).toBe(true);
    });

    it.each([
      [
        "a provisioning status stays retryable",
        { data: { status: "provisioning" } },
      ],
      ["a missing data payload", undefined],
      ["a null data payload", null],
      ["data whose nested data is not an object", { data: "stopped" }],
      ["data whose nested status is not a string", { data: { status: 42 } }],
      ["data without a nested status", { data: {} }],
    ])("is not terminal for %s", (_label, data) => {
      expect(
        isTerminalDedicatedCloudAgentErrorState({
          status: 503,
          code: "agent_not_running",
          message: null,
          data,
          clientBaseUrl: DEDICATED_BASE,
        }),
      ).toBe(false);
    });

    it("is not terminal for a control-plane status under a different code", () => {
      expect(
        isTerminalDedicatedCloudAgentErrorState({
          status: 503,
          code: "agent_timeout",
          message: null,
          data: { data: { status: "stopped" } },
          clientBaseUrl: DEDICATED_BASE,
        }),
      ).toBe(false);
    });
  });

  describe("reason arm: legacy message fragment", () => {
    it("matches the exact legacy fragment with no code", () => {
      expect(
        isTerminalDedicatedCloudAgentErrorState({
          status: 503,
          message: "Agent is in an error state",
          clientBaseUrl: DEDICATED_BASE,
        }),
      ).toBe(true);
    });

    it("matches the fragment embedded in the real proxy message", () => {
      expect(
        isTerminalDedicatedCloudAgentErrorState({
          status: 503,
          message:
            "Agent is in an error state. Resolve the failure before connecting.",
          clientBaseUrl: DEDICATED_BASE,
        }),
      ).toBe(true);
    });

    it("matches the fragment under an unrecognized code", () => {
      expect(
        isTerminalDedicatedCloudAgentErrorState({
          status: 503,
          code: "unavailable",
          message:
            "Agent is in an error state. Resolve the failure before connecting.",
          clientBaseUrl: DEDICATED_BASE,
        }),
      ).toBe(true);
    });

    it("matches the fragment when a present agent_not_running code carries non-terminal data", () => {
      expect(
        isTerminalDedicatedCloudAgentErrorState({
          status: 503,
          code: "agent_not_running",
          message:
            "Agent is in an error state. Resolve the failure before connecting.",
          data: { data: { status: "provisioning" } },
          clientBaseUrl: DEDICATED_BASE,
        }),
      ).toBe(true);
    });

    it("does not match a case-varied fragment", () => {
      expect(
        isTerminalDedicatedCloudAgentErrorState({
          status: 503,
          message: "agent is in an Error state",
          clientBaseUrl: DEDICATED_BASE,
        }),
      ).toBe(false);
    });

    it("returns false for a null message when no other arm matches", () => {
      expect(
        isTerminalDedicatedCloudAgentErrorState({
          status: 503,
          message: null,
          clientBaseUrl: DEDICATED_BASE,
        }),
      ).toBe(false);
    });

    it("returns false for a message without the fragment", () => {
      expect(
        isTerminalDedicatedCloudAgentErrorState({
          status: 503,
          message: "temporary upstream hiccup",
          clientBaseUrl: DEDICATED_BASE,
        }),
      ).toBe(false);
    });
  });
});
