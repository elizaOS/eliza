/** Node default retains its existing DNS-pinned reader, metadata and upstream recovery hints. */

import { guardedTextHttpRequest } from "../lib/web-http.js";
import { createWebFetchAction } from "./web-fetch-core.js";

export {
  htmlToReadableText,
  isCodingWebFetchEnabled,
} from "./web-fetch-core.js";
export const webFetchAction = createWebFetchAction((url, signal) =>
  guardedTextHttpRequest(url, { signal }),
);
