export {
  authoredBrowserDestination,
  containsWebAddress,
  groundBrowserDestination,
} from "@elizaos/contracts/browser-request-grounding";

/** Policy refusal before persistence; never represents a human review decision. */
export class DeviceBrowserNotRequestedError extends Error {
  readonly code = "DEVICE_BROWSER_NOT_REQUESTED";
  constructor() {
    super(
      "The current original request did not ask to open this exact browser destination. No proposal was created or navigation executed.",
    );
  }
}
