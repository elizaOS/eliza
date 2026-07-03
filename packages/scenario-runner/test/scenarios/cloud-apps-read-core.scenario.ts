import type { ScenarioContext } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";

function expectCloudAppsListResult(ctx: ScenarioContext): string | undefined {
  const call = ctx.actionsCalled.find(
    (action) =>
      action.actionName === "LIST_CLOUD_APPS" &&
      action.result?.success === true,
  );
  const data =
    call?.result?.data && typeof call.result.data === "object"
      ? (call.result.data as Record<string, unknown>)
      : null;
  if (!data) {
    return `expected successful LIST_CLOUD_APPS result data; calls: ${
      ctx.actionsCalled
        .map(
          (action) =>
            `${action.actionName}(success=${String(action.result?.success)})`,
        )
        .join(", ") || "(no actions called)"
    }`;
  }
  if (typeof data.count !== "number") {
    return `expected LIST_CLOUD_APPS result.data.count, saw ${JSON.stringify(data)}`;
  }
  if (!Array.isArray(data.apps)) {
    return `expected LIST_CLOUD_APPS result.data.apps array, saw ${JSON.stringify(data)}`;
  }

  const reply = ctx.turns?.at(-1)?.responseText ?? "";
  if (!/(app|cloud)/i.test(reply)) {
    return `expected cloud apps inventory reply, saw ${JSON.stringify(reply)}`;
  }
  return undefined;
}

/**
 * Live trajectory for the Eliza Cloud Apps read-core (#10218).
 *
 * FOLLOW-UP EVIDENCE — lane: "live-only". This needs BOTH a live model (to route
 * "what apps do I have?" to LIST_CLOUD_APPS) AND a real `ELIZAOS_CLOUD_API_KEY`
 * (so `client.listApps()` reaches Eliza Cloud). It is intentionally excluded
 * from the keyless `pr-deterministic` lane: LIST_CLOUD_APPS calls the Cloud API,
 * which cannot be satisfied by a proxy fixture. Run it manually with a key:
 *
 *   ELIZAOS_CLOUD_API_KEY=eliza_... \
 *   bun packages/scenario-runner/src/cli.ts run packages/scenario-runner/test/scenarios \
 *     --scenario cloud-apps-read-core --report /tmp/cloud-apps.json
 *
 * The bun:test unit suite in plugins/plugin-cloud-apps/__tests__ is the
 * gating proof; this scenario captures the end-to-end agent trajectory.
 */
export default scenario({
  id: "cloud-apps-read-core",
  lane: "live-only",
  title: "Eliza Cloud Apps read-core: what apps do I have?",
  domain: "cloud-apps",
  status: "active",
  requires: {
    plugins: ["@elizaos/plugin-cloud-apps"],
  },
  turns: [
    {
      kind: "message",
      name: "user asks for their cloud apps",
      text: "what apps do I have?",
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "LIST_CLOUD_APPS returned inventory data",
      predicate: expectCloudAppsListResult,
    },
  ],
});
