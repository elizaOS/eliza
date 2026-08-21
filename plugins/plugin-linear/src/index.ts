/** Public barrel for the read-only Linear plugin surface. */

export { linearAction } from "./action.js";
export {
  LINEAR_API_ENDPOINT,
  LinearClient,
  type LinearClientOptions,
  type LinearCredential,
} from "./client.js";
export { LinearError, type LinearErrorCode } from "./errors.js";
export { linearPlugin, linearPlugin as default } from "./plugin.js";
export {
  getLinearService,
  LINEAR_SERVICE_TYPE,
  LinearService,
} from "./service.js";
export type {
  IssueSearchRequest,
  LinearIssue,
  LinearIssuePage,
  LinearTeam,
  LinearTeamPage,
  LinearViewer,
  TeamListRequest,
} from "./types.js";
