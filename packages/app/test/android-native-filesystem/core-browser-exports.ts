/** Real core leaves used by the service; avoids loading unrelated Node-only catalog code in this isolated WebView. */
export { logger } from "../../../core/src/logger";
export { Service } from "../../../core/src/types/service";
export { resolveStateDir } from "../../../core/src/utils/state-dir";
