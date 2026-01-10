/**
 * GitHub Providers
 *
 * All available providers for the GitHub plugin.
 */

export { repositoryStateProvider, default as repositoryState } from "./repositoryState";
export { issueContextProvider, default as issueContext } from "./issueContext";

import { repositoryStateProvider } from "./repositoryState";
import { issueContextProvider } from "./issueContext";

/**
 * All GitHub providers
 */
export const allProviders = [repositoryStateProvider, issueContextProvider];

