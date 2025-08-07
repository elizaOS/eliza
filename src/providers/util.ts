import { ProviderResult, State } from "@elizaos/core";

export const EMPTY_RESULT: ProviderResult = {};

export const selectProviderState = <T>(
  name: string,
  state?: State
): T | undefined => {
  if (!state?.data?.providers) {
    return undefined;
  }

  const provider = state.data.providers[name];

  if (!provider) {
    return undefined;
  }

  return (provider as { data: T })?.data;
};
