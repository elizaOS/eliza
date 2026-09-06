# Application billing selections

An application slot is an operator-owned selection of one registered app,
product family, merchant and execution environment. It contains no credential.
Its developer organization pays infrastructure; its native purchaser account
uses the existing `user:<canonical-user-id>` account namespace.

Install a reviewed configuration with the pinned Bun runtime:

```sh
bun packages/cloud/scripts/admin/install-app-billing-slot.ts /absolute/path/manifest.json REVIEWED_SHA256
```

The JSON document has `version: 1`, `kind: "application_slot"`, `sourceSystem`,
`sourceRecordId`, `sourceDigest`, `slotKey`, `appId`, `developerOrganizationId`,
`merchantId`, `livemode`, and `productFamilyKey`. IDs select existing registered
records. Source provenance identifies the operator inventory being adopted;
the command requires a separate SHA-256 of the complete reviewed file. The
file must belong to the current operator and must not be group/world writable
or a symbolic link. No purchaser HTTP route accepts this document.

The installer retrieves the actual merchant and published Stripe prices using
the configured environment's credentials and pinned Acacia adapter. It rejects
provider drift, wrong ownership and unavailable app approval. It creates no
Stripe customers, subscriptions, invoices, charges or checkout sessions.

Native dispatch resolves an explicitly selected slot through
`resolveAppBillingApplicationSlot({slotKey, livemode, verifiedUserId})`.
The caller must authenticate the canonical user and derive the execution mode
from server configuration. The resolver checks current account membership,
app approval, merchant availability and developer standing. Wallet principals
are supported; email verification is not a substitute for caller authentication.
No purchaser account is created during inference.

After reserving app allowance and developer infrastructure funding, dispatch
must resolve the selection again and require the same slot ID, account and
scope. Disabling a slot is irreversible for that row; a replacement gets a new
ID. A selected but unavailable product must fail explicitly. Requests without
an application selection keep their prepaid behavior.

Existing organization subscriptions, invoice identifiers and cash remain
unchanged. Installing a slot does not classify historical organizations as
product subscribers, consume their trial eligibility, or activate a product
subscription. The native gateway owns credential verification and dispatch;
this configuration layer owns only trusted selection and current authority.

Disabling a merchant's new sales does not cancel its provider subscriptions or
revoke already granted app access. Existing customers can resolve their product,
use its unexpired allowance, reconcile renewals, open their scoped payment portal,
and cancel. New trials, purchases, and purchase retries remain blocked. Disabling
the application slot or suspending the app, purchaser account, or developer
organization still denies dispatch. Provider disconnection does not manufacture
a successful provider read; unavailable reconciliation remains explicit.
