/** Shared delivery state for the standard shell; product renderers use the same protocol implementation. */
import { createCompletedActionNavigationState } from "@elizaos/core/protocol";
import { getWindowNavigationPath } from "./navigation";

const state = createCompletedActionNavigationState(getWindowNavigationPath);
export const {
  captureCompletedActionNavigationFence,
  dispatchCompletedActionNavigation,
  markCompletedActionNavigationHandled,
  resetCompletedActionNavigationForTests,
} = state;
