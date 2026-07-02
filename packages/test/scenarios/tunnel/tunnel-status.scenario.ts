/**
 * Keyless per-plugin e2e for `@elizaos/plugin-tunnel` (issue #8801).
 *
 * Drives the `TUNNEL` dispatcher action through its deterministic `status`
 * sub-op. `status` reads the active tunnel service's in-memory `getStatus()` —
 * it spawns no `tailscale` process and needs no live tailnet, so the only
 * dependency is that a tunnel service is registered under
 * `serviceType="tunnel"`.
 *
 * The plugin's `init` registers `LocalTunnelService` only when the `tailscale`
 * CLI is on PATH. To exercise the real service keyless, the seed drops a tiny
 * stub `tailscale` executable onto PATH (so `which tailscale` and the service's
 * install probe succeed) and registers the real `LocalTunnelService`. The
 * status read returns the fresh, inactive state — no network, no credentials.
 *
 * The handler makes no `useModel` call, so only the routing/decision fixtures
 * are needed.
 */
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntime } from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import { LocalTunnelService } from "@elizaos/plugin-tunnel";
import { scenario } from "@elizaos/scenario-runner/schema";
import {
  describeCalls,
  successfulActionData,
} from "../_helpers/effect-assertions.ts";

const TUNNEL = "TUNNEL";

type R = AgentRuntime & {
  registerService: (svc: unknown) => Promise<void>;
  getServiceLoadPromise: (t: string) => Promise<unknown>;
  scenarioLlmFixtures?: {
    register: (...f: Array<Record<string, unknown>>) => void;
  };
};

let restorePath: (() => void) | undefined;

export default scenario({
  lane: "pr-deterministic",
  id: "tunnel.status",
  title: "Tunnel: read tunnel status via the real LocalTunnelService",
  domain: "tunnel",
  tags: ["smoke", "tunnel", "connector"],
  description:
    "Exercises the real TUNNEL action's `status` sub-op end-to-end against the plugin's LocalTunnelService — keyless, no live tailnet, no credentials.",

  requires: { plugins: ["@elizaos/plugin-tunnel"] },
  isolation: "per-scenario",

  seed: [
    {
      type: "custom",
      name: "tunnel-service-setup",
      apply: async (ctx) => {
        const runtime = ctx.runtime as R;

        // The plugin gates LocalTunnelService on the `tailscale` binary being
        // present. Drop a stub `tailscale` on PATH so the install probe
        // (`which tailscale`) succeeds; the `status` read never invokes it.
        const binDir = mkdtempSync(join(tmpdir(), "tunnel-stub-"));
        const stub = join(binDir, "tailscale");
        writeFileSync(stub, "#!/bin/sh\nexit 0\n");
        chmodSync(stub, 0o755);
        const prevPath = process.env.PATH ?? "";
        process.env.PATH = `${binDir}:${prevPath}`;
        restorePath = () => {
          process.env.PATH = prevPath;
          restorePath = undefined;
        };

        // The scenario API host does not run the plugin's tailscale-gated init,
        // so register the real LocalTunnelService here and force-start it so the
        // synchronous getService() in TUNNEL.validate resolves.
        await runtime.registerService(LocalTunnelService);
        await runtime.getServiceLoadPromise("tunnel");

        runtime.scenarioLlmFixtures?.register(
          {
            name: "tunnel-stage1",
            match: {
              modelType: ModelType.RESPONSE_HANDLER,
              input: (v: string) => v.includes("tunnel"),
              toolName: "HANDLE_RESPONSE",
            },
            response: {
              contexts: ["connectors"],
              intents: ["check tunnel status"],
              replyText: "",
              threadOps: [],
              candidateActionNames: [TUNNEL],
            },
            times: 1,
          },
          {
            name: "tunnel-planner",
            match: {
              modelType: ModelType.ACTION_PLANNER,
              input: (v: string) => v.includes("tunnel"),
              toolName: TUNNEL,
            },
            response: {
              text: "",
              thought: "Read the current tunnel status.",
              messageToUser: "",
              completed: true,
              finishReason: "tool-calls",
              toolCalls: [
                {
                  id: "call-tunnel-status",
                  name: TUNNEL,
                  type: "function",
                  arguments: { action: "status" },
                },
              ],
            },
            times: 1,
          },
          {
            name: "tunnel-decision",
            match: (call: { modelType: string; toolNames: string[] }) =>
              call.modelType === ModelType.RESPONSE_HANDLER &&
              !call.toolNames.includes("HANDLE_RESPONSE"),
            response: {
              success: true,
              decision: "FINISH",
              thought: "Tunnel status reported; nothing more to do.",
              messageToUser: "No active tunnel.",
            },
            times: 1,
          },
        );
        return undefined;
      },
    },
  ],
  cleanup: [
    {
      type: "custom",
      name: "restore-path",
      apply: () => {
        restorePath?.();
        return undefined;
      },
    },
  ],

  rooms: [
    { id: "main", source: "dashboard", channelType: "DM", title: "Tunnel" },
  ],

  turns: [
    {
      kind: "message",
      name: "status",
      text: "What is the tunnel status?",
      timeoutMs: 120_000,
      assertTurn: (turn) => {
        const call = turn.actionsCalled.find((a) => a.actionName === TUNNEL);
        if (!call) {
          return `Expected ${TUNNEL} but got: ${turn.actionsCalled
            .map((a) => a.actionName)
            .join(", ")}`;
        }
        if (!call.result?.success) {
          return `${TUNNEL} did not succeed: ${
            call.error?.message ?? call.result?.text ?? "unknown error"
          }`;
        }
      },
    },
  ],

  finalChecks: [
    {
      type: "actionCalled",
      actionName: TUNNEL,
      status: "success",
      minCount: 1,
    },
    {
      // Effect proof (#11381): the status sub-op really read the live
      // LocalTunnelService's fresh state — an inactive tunnel with a named
      // provider — not just "the handler returned success".
      type: "custom",
      name: "tunnel-status-effect",
      predicate: (ctx) => {
        const data = successfulActionData(ctx, TUNNEL);
        if (!data) {
          return `no successful TUNNEL result data; calls: ${describeCalls(ctx)}`;
        }
        if (data.action !== "tunnel_status") {
          return `expected result.data.action "tunnel_status", saw ${String(data.action ?? "(missing)")}`;
        }
        if (data.active !== false) {
          return `fresh LocalTunnelService must report an inactive tunnel (active=false); saw active=${String(data.active)}`;
        }
        if (typeof data.provider !== "string" || data.provider.length === 0) {
          return `expected the service's provider name in result.data.provider; saw ${JSON.stringify(data.provider ?? null)}`;
        }
      },
    },
  ],
});
