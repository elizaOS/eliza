# @elizaos/core

Node runtime kernel for Eliza agents: plugin registration, authorization, state, model dispatch, memory, and cancellation.

The root entrypoint is Node-only; exported protocol and utility leaves must not import the runtime barrel. Keep core independent of application hosts, database adapters, and assistant behavior. Preserve authorization, cancellation, effect receipts, and complete model context; hosts register behavior and providers explicitly.

Build, test, and setup: [README.md](README.md).

Historical navigation receipts and owner-declared, non-mutating read observations may follow their exact, unambiguous original request through history selection. Include receipt bytes in the source hash and restore them with that request. Missing, malformed or stale bindings retain full evidence; current tools, mutation outcomes and standing constraints remain inline.
