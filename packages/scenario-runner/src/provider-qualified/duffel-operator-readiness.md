# Duffel sandbox canary operator

`duffel-operator-controller.ts` is a fail-closed controller for
`provider.duffel-travel.booking`. It does not supply credentials, host ingress,
sign observer evidence, or convert a sandbox receipt into qualification.

Before any ingress, the operator must supply an Ed25519-authorized manifest,
the exact raw `duffel.booking-hold-create` binding, two signed negative-probe
payloads, and a plan bound to the same sandbox account, connection, owner
principal, and run nonce. The operation binding includes the selected offer,
itinerary, passengers, `orderType=hold`, exact `totalCents` and `currency`, and
disabled calendar sync.

Execution requires all of these external capabilities up front:

1. authenticate a read-write Duffel test-mode token and prove `liveMode=false`;
2. start an independent order/payment no-effect observer;
3. send an authenticated proposal turn that creates one pending approval;
4. finish the no-effect interval before approval ingress;
5. send a distinct authenticated owner-approval turn for the same approval ID
   and canonical payload hash;
6. read the created order from Duffel sandbox and prove it is the exact held,
   awaiting-payment, unpaid order with no calendar mutation;
7. replay authenticated approval and prove no additional order or payment;
8. execute the exact authorization-denied and provider-rejected probes without
   state change; and
9. export the deployed trajectories for both turns.

The returned document is deliberately unsigned and contains
`qualificationClaimed: false`. Provider qualification still requires the
independent observer and judge signatures, exact trajectory-stage bindings,
artifact assembly, and reverification owned by the external canary
orchestrator.

Duffel's public API does not document a client idempotency key for order
creation. The production approval dispatcher therefore must never blindly
retry an order after dispatch has started: ambiguous outcomes go to explicit
reconciliation. Provider metadata and `x-client-correlation-id` are correlation
handles, not exactly-once proof.
