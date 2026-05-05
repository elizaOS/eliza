# Remote Pairing Automation Boundary

Implemented app-core route-level automation covers the local remote-auth control plane that exists today:

- two simulated remote browser/device contexts via distinct request IPs and hosts
- pending pairing status and expiry metadata
- wrong-code rejection without consuming the pending code
- successful code consumption returning the configured static API token
- promoted bearer access to `GET /api/auth/status`
- consumed-code reuse rejection once a replacement pending code exists
- expired pending-code rejection and replacement-code consumption

The current `packages/app-core/src/api/auth-pairing-compat-routes.ts` API does not expose remote session creation, active-session promotion, revocation, ingress URL update, or multi-interface data-plane fanout. Those remain unautomated here because there is no route-level contract to assert without adding runtime behavior.

Recommended follow-up once the runtime surface exists:

- consume pairing code into a first-class remote session id
- expose list/revoke endpoints for remote sessions
- persist and enforce pairing-code/session expiry
- expose mockable ingress/data-plane fanout hooks for multi-interface message assertions
