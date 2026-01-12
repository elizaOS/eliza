export { default as issueContext, issueContextProvider } from "./issueContext";
export {
  default as repositoryState,
  repositoryStateProvider,
} from "./repositoryState";

import { issueContextProvider } from "./issueContext";
import { repositoryStateProvider } from "./repositoryState";

export const allProviders = [repositoryStateProvider, issueContextProvider];
