/**
 * GitHub Providers
 *
 * All available providers for the GitHub plugin.
 */

export { default as issueContext, issueContextProvider } from "./issueContext";
export {
  default as repositoryState,
  repositoryStateProvider,
} from "./repositoryState";

import { issueContextProvider } from "./issueContext";
import { repositoryStateProvider } from "./repositoryState";

/**
 * All GitHub providers
 */
export const allProviders = [repositoryStateProvider, issueContextProvider];
