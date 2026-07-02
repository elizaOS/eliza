/**
 * Browser fixture for the accounts-UI e2e (run-accounts-ui-e2e.mjs).
 *
 * Mounts the REAL `AccountList` for a direct-API provider. The fixture is
 * served from the SAME origin as the real accounts API server, so the real
 * `ElizaClient` inside `useAccounts` issues genuine same-origin fetches to
 * `/api/accounts*` — real DOM, real network, real route handlers, real
 * `AccountPool`, real on-disk credential store. Only the app-state barrel is
 * swapped for a translator-only stub (see accounts-fixture-state-stub.ts).
 */

import { createRoot } from "react-dom/client";
import { AccountList } from "../../../ui/src/components/accounts/AccountList";

function AccountsFixture() {
  return (
    <div
      data-testid="accounts-fixture"
      className="mx-auto flex min-h-screen max-w-3xl flex-col gap-4 p-6"
    >
      <div>
        <h1 className="text-lg font-semibold text-txt">
          Anthropic API accounts
        </h1>
        <p className="text-xs text-muted">
          Multi-account rotation pool — accounts UI e2e fixture (#10722)
        </p>
      </div>
      <AccountList providerId="anthropic-api" />
    </div>
  );
}

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("fixture root element missing");
createRoot(rootEl).render(<AccountsFixture />);
