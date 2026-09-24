/** Starts the deployable first-party identity service against its configured PostgreSQL database. */
import { startLoginServer } from "./runtime";
import { serveUntilSignal } from "./serve-until-signal";

export { startLoginServer } from "./runtime";

if (import.meta.main) await serveUntilSignal(await startLoginServer());
