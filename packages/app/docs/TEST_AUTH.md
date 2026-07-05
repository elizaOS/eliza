# Test Auth Contract

Automated app lanes must use one documented auth path per surface. Do not copy
tokens or bypasses between specs by hand; extend the shared helper for the
surface instead.

## Renderer Steward Sessions

Chromium renderer tests that need a Steward session use
`test/ui-smoke/helpers/test-auth.ts`.

- `seedStewardSession(page)` seeds the canonical
  `steward_session_token` localStorage key before React boots.
- `setStewardSession(page)` writes the same key after the page has loaded.
- The default token is opaque (`ui-smoke-onboarding-cloud-token`). Use it for
  mocked cloud login flows where refresh churn would obscure the test.
- Pass `{ jwt: true }` only when the spec intentionally needs a decodable JWT
  shape. The helper creates an unsigned JWT with `exp`; client-cloud refresh
  logic only attempts refresh for JWT-like tokens that carry an expiry.

## Surface Matrix

| Surface | Canonical test-auth path | Representative? | Token / secret shape |
| --- | --- | --- | --- |
| Web/desktop renderer UI-smoke | `seedStewardSession` or `setStewardSession` plus mocked `/api/cloud/*` routes | Bypass for renderer coverage | Opaque token by default; opt into helper JWT for JWT lifecycle tests |
| Cloud console audit (`audit:cloud`) | Build renderer with `VITE_PLAYWRIGHT_TEST_AUTH=true`; StewardProvider mounts the test-auth shell | Bypass for visual coverage | Build-time flag, no user token |
| iOS simulator local lane | Host agent on `127.0.0.1:31337` with `ELIZA_PAIRING_DISABLED=1`; Capacitor Preferences carries remote-connect state | Production-like local agent with pairing disabled | No cloud token |
| Android emulator/device local lane | Host agent plus `adb reverse`; deep link `elizaos://first-run/runtime/remote?api=...` | Production-like local agent with pairing disabled | No cloud token |
| Packaged Electrobun desktop | Loopback owner trust; packaged mock/live API seeds first-run state | Shell/auth bypass for packaged renderer coverage | Local owner trust, no cloud token |
| Real Eliza Cloud worker e2e | Headless SIWE via `siweTestLogin`, or `POST /api/test/auth/session` when `PLAYWRIGHT_TEST_AUTH` is enabled | Production-auth representative for API/session behavior | Real API key/session cookie |
| Real Eliza Cloud device lanes | Cloud provisioning secret passed to the lane | Production-auth representative for device cloud probe | `ELIZA_CLOUD_AUTH_TOKEN` |

## Missing Secrets

Auth-dependent CI steps must not disappear silently when a secret is absent.
They must either fail, or write a visible `skipped: missing <SECRET>` entry to
`$GITHUB_STEP_SUMMARY` before exiting successfully. Use the visible skip only
when the lane is optional or label-gated; blocking lanes should fail.

## Adding A New Lane

1. Pick the row above that matches the surface.
2. Reuse the shared helper or workflow secret exactly as documented.
3. State in the PR evidence whether the lane is a production-auth test or an
   intentional auth bypass for a narrower renderer/device assertion.
4. If a JWT lifecycle is the behavior under test, seed a short-expiry JWT with
   `seedStewardSession(page, { jwt: true, exp })` and attach the refresh network
   evidence.
