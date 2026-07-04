/** Provider barrel: collects the plugin's context providers into `farcasterProviders` for registration. */
import { farcasterProfileProvider } from "./profileProvider";

export { farcasterProfileProvider };
export const farcasterProviders = [farcasterProfileProvider];
