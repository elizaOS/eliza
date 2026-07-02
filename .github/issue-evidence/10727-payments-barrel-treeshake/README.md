# #10727 follow-up — payments (and sibling) feature barrels tree-shaken out of the mobile bundle

Follow-up to PR #11248 (`fix(core): sub-agent-credentials circular import crashes
the mobile agent bundle at load`), which flagged `features/payments` as the same
latent barrel-drop pattern. This audit covered **every** `packages/core/src/features/*`
directory and fixed all remaining occurrences.

## Before (origin/develop `7d98c19dc4`, includes the merged #11248 fix)

Bundle built with `bun run --cwd packages/agent build:mobile` (the exact
artifact `stage-android-agent.mjs` ships to devices), grepped on host:

```
paymentAction                            0     <- whole payments feature absent
eligibleDeliveryTargetsFor               0
[PaymentsPlugin] Initialized             0
init_payments = () =>                    1     <- module init compiled to an EMPTY stub
paymentsPlugin                           1     <- only the core namespace getter:
                                                  216103:  paymentsPlugin: () => paymentsPlugin,
                                                  (getter kept, binding never emitted ->
                                                   ReferenceError on first access on device)
CREATE_OAUTH_INTENT                      0
oauthPlugin                              0
PROBE_PLUGIN_CONFIG_REQUIREMENTS         0
pluginConfigPlugin                       0
```

`paymentsPlugin` is a public `@elizaos/core` export (`index.node.ts` /
`index.browser.ts`) — the shipped mobile bundle exposed a namespace getter for a
binding that was never emitted.

## After (this branch)

```
paymentAction                                      5
name: "PAYMENT"                                    3
eligibleDeliveryTargetsFor                         3
[PaymentsPlugin] Initialized                       1
init_payments = () =>                              0     <- real init body now
var paymentsPlugin                                 1     (defined at bundle line 166113,
                                                          assigned at 166117)
__bundle_safety_FEATURES_PAYMENTS_INDEX__          3
CREATE_OAUTH_INTENT / oauthPlugin                  0     <- correct: not exported from the
PROBE_PLUGIN_CONFIG_REQUIREMENTS / pluginConfigPlugin 0     core root barrel, no consumers yet
                                                          (dead code until wired; the fix makes
                                                          them land safely once wired)
```

## Bundle load smoke

Build-time fail-closed smoke (from #11248) passed on every rebuild, plus manual:

```
$ cd packages/agent/dist-mobile && bun -e 'await import("./agent-bundle.js"); console.log("BUNDLE_MODULE_INIT_OK"); process.exit(0)'
BUNDLE_MODULE_INIT_OK
```

## #11271 clobber restoration (second commit)

While this branch was in flight, develop commit `5b714c74e6` (#11271, a cloud
refund refactor) shipped a stale tree that reverted the entire merged #11248
fix (sub-agent-credentials barrel + the fail-closed bundle load smoke),
re-introducing the P0 on-device load crash. This branch restores those paths
byte-identical to `5b714c74e6^`. Final bundle (rebased tree, both commits):

```
paymentAction                                 5
name: "PAYMENT"                               3
eligibleDeliveryTargetsFor                    3
[PaymentsPlugin] Initialized                  1
init_payments = () =>                         0
DECLARE_SUB_AGENT_CREDENTIAL_SCOPE            6     <- #11248 state restored
declareSubAgentCredentialScopeAction          4
__bundle_safety_FEATURES_PAYMENTS_INDEX__     3

[build-mobile] load smoke: evaluating bundle module graph...
[build-mobile] load smoke passed: module init OK
$ bun -e 'await import("./agent-bundle.js"); ...'
BUNDLE_MODULE_INIT_OK
```

## Tests / checks

- `bunx vitest run src/features/{payments,oauth,plugin-config,secrets,sub-agent-credentials}` (packages/core): **105/105 passed**
- `bun run typecheck` (packages/core, tsgo): clean
- `bunx biome check` on all touched feature dirs: clean
- `bun run --cwd packages/core build`: clean
