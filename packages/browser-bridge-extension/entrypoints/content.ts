import { runDomAction } from "../src/dom-actions";
import { capturePageContext } from "../src/page-extract";
import type {
  ContentScriptMessage,
  ContentScriptResponse,
} from "../src/protocol";
import { addRuntimeMessageListener } from "../src/webextension";

addRuntimeMessageListener((message, _sender, sendResponse) => {
  const request = message as ContentScriptMessage | undefined;
  if (!request || typeof request !== "object" || !("type" in request)) {
    return false;
  }

  try {
    if (request.type === "browser-bridge:capture-page") {
      const response: ContentScriptResponse = {
        ok: true,
        page: capturePageContext(),
      };
      sendResponse(response);
      return false;
    }

    if (request.type === "browser-bridge:execute-dom-action") {
      const response: ContentScriptResponse = {
        ok: true,
        actionResult: runDomAction(request.action),
      };
      sendResponse(response);
      return false;
    }
  } catch (error) {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    } satisfies ContentScriptResponse);
    return false;
  }

  return false;
});
