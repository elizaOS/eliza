# @elizaos/core

Node runtime kernel for Eliza agents: plugin registration, authorization, state, model dispatch, memory, and cancellation.

Keep core independent of application hosts, database adapters, and assistant behavior. Preserve authorization, cancellation, effect receipts, and complete model context; hosts register behavior and providers explicitly.

Build, test, and setup: [README.md](README.md).

Historical navigation receipts follow source-bound request selection; full authorized restoration retains exact receipts. Unknown bindings and current effects remain inline.
