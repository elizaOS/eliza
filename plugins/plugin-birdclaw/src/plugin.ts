import type { Plugin } from "@elizaos/core";
import { birdclawAction } from "./actions/birdclaw.ts";
import { BirdclawService } from "./birdclaw/service.ts";
import { birdclawRoutes } from "./routes/birdclaw-routes.ts";

/**
 * `@elizaos/plugin-birdclaw` — birdclaw (https://birdclaw.sh) local-first
 * Twitter/X memory for elizaOS.
 *
 * Registers `BIRDCLAW_SERVICE` (a typed wrapper over the birdclaw CLI's
 * `--json` envelopes), the owner-gated `BIRDCLAW` action (search / inbox /
 * sync / digest / status over the local archive), the `/api/birdclaw/*`
 * routes, and the Birdclaw archive-browser view.
 *
 * Enablement: the agent auto-loads this plugin when the birdclaw CLI (or an
 * existing `~/.birdclaw` data root) is present on the host — see
 * `birdclawRequested` in `packages/agent/src/runtime/plugin-collector.ts`.
 * `ELIZA_BIRDCLAW=1/0` forces it on or off. Everything degrades explicitly
 * when the binary goes missing: the view renders a setup screen and the
 * action stops validating.
 */
export const birdclawPlugin: Plugin = {
  name: "birdclaw",
  description:
    "Local-first Twitter/X memory (birdclaw.sh): browse and search the archived timeline, mentions, likes, and bookmarks; triage the mention/DM inbox; trigger live syncs; build digests.",
  services: [BirdclawService],
  actions: [birdclawAction],
  routes: birdclawRoutes,
  views: [
    {
      id: "birdclaw",
      label: "Birdclaw",
      description:
        "Local-first Twitter/X memory — browse your archived timeline, mentions, likes, and bookmarks",
      icon: "Bird",
      path: "/birdclaw",
      // GUI-only shipping ("tui"/"xr" remain valid compatibility values but
      // are no longer declared), drawn from the single BirdclawSpatialView
      // source. `modalities` stays a plain literal here (plugin.ts is not in
      // the view bundle).
      modalities: ["gui"],
      bundlePath: "dist/views/bundle.js",
      // First-party instrumented view (data-agent-id controls): grant the
      // agent-surface capability so the view broker admits agent-driven
      // fills/clicks (#13452 manifest gate).
      surface: { capabilities: ["agent-surface"] },
      componentExport: "BirdclawView",
      tags: ["twitter", "x", "social", "archive", "memory", "birdclaw"],
      visibleInManager: true,
      desktopTabEnabled: true,
    },
  ],
  async dispose(runtime) {
    await runtime
      .getService<BirdclawService>(BirdclawService.serviceType)
      ?.stop();
  },
};

export default birdclawPlugin;
