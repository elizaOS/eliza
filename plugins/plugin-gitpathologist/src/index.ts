/**
 * @elizaos/plugin-gitpathologist
 *
 * Forensic git-history analysis. See README and the GIT_PATHOLOGY action for
 * usage. The plugin auto-detects whether the workspace is a git repository
 * and only registers its action when the GitPathologyService starts.
 */

import { type IAgentRuntime, logger, type Plugin } from "@elizaos/core";
import { gitPathologyAction } from "./actions/git-pathology.ts";
import {
  GIT_PATHOLOGY_SERVICE_NAME,
  GitPathologyService,
} from "./services/git-pathology-service.ts";

const gitpathologistPlugin: Plugin = {
  name: "@elizaos/plugin-gitpathologist",
  description:
    "Forensic git-history analysis for elizaOS agents: per-surface health timeline, drift inflection detection, rot post-mortem.",
  init: async (_config: Record<string, string>, _runtime: IAgentRuntime): Promise<void> => {
    logger.info("[GitPathology] plugin initialized");
  },
  async dispose(runtime: IAgentRuntime) {
    const svc = runtime.getService<GitPathologyService>(GIT_PATHOLOGY_SERVICE_NAME);
    await svc?.stop();
  },
  services: [GitPathologyService],
  actions: [gitPathologyAction],
  providers: [],
};

export default gitpathologistPlugin;
export { gitPathologyAction } from "./actions/git-pathology.ts";
export {
  GIT_PATHOLOGY_SERVICE_NAME,
  GitPathologyService,
} from "./services/git-pathology-service.ts";
export type {
  AnalysisOptions,
  CommitHealthPoint,
  InflectionPoint,
  PathologyReport,
  RotCause,
  SurfaceSpec,
} from "./types.ts";
