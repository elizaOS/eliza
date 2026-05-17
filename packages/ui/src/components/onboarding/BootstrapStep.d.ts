/**
 * BootstrapStep — cloud-provisioned containers only.
 *
 * If the dashboard linked here with `#bootstrap=<token>`, the token is read
 * once on mount, scrubbed from the URL, and exchanged automatically — no
 * paste required. Otherwise the manual paste form is shown as a fallback.
 *
 * On success the returned session id is written to
 * sessionStorage["eliza_session"] and the `onAdvance` callback fires.
 *
 * P1 will migrate the session to an HttpOnly cookie and retire sessionStorage.
 * The key name is kept in sync with the cookie name planned for P1
 * (eliza_session) so the P1 migration is a straightforward swap.
 *
 * Error contract (fail closed):
 *   401 → token invalid / expired / already used, single-use, must rotate.
 *   429 → rate limited.
 *   5xx → server not ready.
 *   network → surfaces to user; never treated as success.
 */
import type { BootstrapExchangeResult } from "../../api/client-agent";
export interface BootstrapStepProps {
    /**
     * Called after a successful exchange. The caller is responsible for
     * advancing the wizard.
     */
    onAdvance: () => void;
    /**
     * Injected exchange function — defaults to the real API client call but
     * can be swapped in tests.
     */
    exchangeFn?: (token: string) => Promise<BootstrapExchangeResult>;
}
export declare function BootstrapStep({ onAdvance, exchangeFn }: BootstrapStepProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=BootstrapStep.d.ts.map