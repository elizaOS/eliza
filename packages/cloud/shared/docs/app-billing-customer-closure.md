# Customer-wide closure authority

`closeAppBillingCustomer` freezes one existing provider customer binding after
all product-family scopes sharing its billing account and merchant have a
canonical `close` disposition for the current deletion request. The binding ID
is the stable closure identity across requests and phase handoff. The row keeps
the original app, merchant account, environment and Stripe customer ID; its
initiating request and phase are provenance, never an authorization token.

Every call validates the caller's current irreversible Stripe deletion phase,
including calls that return an existing closure initiated by another request.
A phase takeover does not rewrite the closure or its future provider idempotency
identity. Provider operations must independently revalidate current authority
at dispatch and result commit; the closure row alone authorizes neither.

Scope admission and customer binding inserts serialize against closure using
the owner organization and billing account locks. Closure locks owner
organizations in UUID order, then sharing scopes in UUID order, the billing
account, original customer binding, deleting user, request and phase. The
organization lock prevents a sharing scope from being inserted during the
inventory-to-closure transaction. A new family or replayed binding cannot reuse
a customer after closure. Existing historical reads remain available.

Closure fails when any sharing scope lacks a current-request close disposition,
including a retained sibling, an undecided family, an inconsistent merchant/mode binding, or a
subject that cannot canonically decide the entire shared customer. The caller
must obtain each legitimate disposition; it cannot copy a sibling's decision
or borrow another request's authority. Historical `retain_shared` decisions do
not prevent a later canonical close, but a retained scope without that later
close remains a barrier. Orphan bindings without any scope also require an
explicit recovery design and are rejected.

This is an intent and admission fence only. It does not cancel a subscription,
expire Checkout, delete a provider customer, settle an ambiguous command,
complete the canonical Stripe deletion phase, or prove physical identity
erasure. Those operations require their durable journal and terminal provider
observations while this original binding and financial history are retained.
