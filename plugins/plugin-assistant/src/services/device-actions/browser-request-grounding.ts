export {
  authoredBrowserDestination,
  browserDestinationMatches,
  browserSearchQueryMatches,
  containsWebAddress,
  directBrowserDestination,
  directBrowserSearchQuery,
  groundBrowserDestination,
  groundBrowserSearchQuery,
} from "@elizaos/contracts/browser-request-grounding";

/** Policy refusal before persistence; never represents a human review decision. */
export class DeviceBrowserNotRequestedError extends Error {
  readonly code = "DEVICE_BROWSER_NOT_REQUESTED";
  constructor(readonly request: "destination" | "search" = "destination") {
    super(
      request === "search"
        ? "The current original request does not contain these search words. Use only words the user typed in this message. No proposal was created or search executed."
        : "The current original request did not ask to open this exact browser destination. No proposal was created or navigation executed.",
    );
  }
}
