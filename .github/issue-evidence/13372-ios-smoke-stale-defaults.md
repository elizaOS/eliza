# Issue 13372 - iOS Smoke Stale Defaults Cleanup

## Scope

The simulator smoke harness now deletes the onboarding and attachment smoke
request/result keys from the simulator defaults domain before reinstalling the
iOS app. The existing post-install cleanup remains in place.

This closes only the stale `eliza:ios-onboarding-smoke:request` harness hazard
called out in #13372. It does not claim to fix the separate `ws://` mixed-content
runtime failure from an `https://localhost` WKWebView origin.

## Validation

- `node --check packages/app/scripts/ios-onboarding-smoke.mjs`
- `node --check packages/app/scripts/ios-attachment-smoke.mjs`
- `bunx @biomejs/biome check packages/app/scripts/ios-onboarding-smoke.mjs packages/app/scripts/ios-attachment-smoke.mjs`
- `git diff --check origin/develop...HEAD && git diff --check`

## Evidence Boundary

This is a script-only simulator harness cleanup. A live iOS simulator rerun is
still required to prove the broader remote-host lane and mixed-content behavior.
