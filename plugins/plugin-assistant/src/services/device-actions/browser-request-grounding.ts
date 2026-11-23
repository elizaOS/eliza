export {
  authoredBrowserDestination,
  authoredBrowserOpen,
  browserDestinationMatches,
  browserSearchQueryMatches,
  containsWebAddress,
  directBrowserDestination,
  directBrowserOpen,
  directBrowserSearchQuery,
  groundBrowserDestination,
  groundBrowserSearchQuery,
  spokenBrowserOpen,
  withheldBrowserPageReloadRefusal,
} from "@elizaos/contracts/browser-request-grounding";

/** Policy refusal before persistence; never represents a human review decision. */
export class DeviceBrowserNotRequestedError extends Error {
  readonly code = "DEVICE_BROWSER_NOT_REQUESTED";
  constructor(readonly request: "destination" | "search" = "destination") {
    super(
      request === "search"
        ? "The current original request does not contain these search words. Use only words the user typed in this message. No proposal was created or search executed."
        : "The current original request did not ask to open this exact browser destination, and it is not a link of the Browser page that request carried. No proposal was created or navigation executed.",
    );
  }
}

/** Policy refusal before persistence: a reload of a Browser page the phone
 * withheld (it could not read it, or shares no text from it) that the owner's
 * own message did not ask for. Reloading never makes the page readable and can
 * resubmit a form; the message tells the model to answer the owner instead. */
export class DeviceBrowserPageWithheldError extends Error {
  readonly code = "DEVICE_BROWSER_PAGE_WITHHELD";
}
