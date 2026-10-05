/** Starts the first-party desktop identity service using its persisted local database. */
import { startEmbeddedLogin } from "./runtime";
import { serveUntilSignal } from "./serve-until-signal";

export { startEmbeddedLogin } from "./runtime";

if (import.meta.main) await serveUntilSignal(await startEmbeddedLogin());
