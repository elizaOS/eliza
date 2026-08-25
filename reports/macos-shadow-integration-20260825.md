# macOS shadow integration — 2026-08-25

This is a nonproduction integration and packaging-readiness receipt. It does not
authorize or claim a native launch, port lease, TCC change, signing, deployment,
provider traffic, physical-pointer action, or release acceptance.

## Frozen inputs

- Base `origin/develop`: `69c0291954942c9ae375fe5aacc82729a24bac6f`
- Shared PR #27103: `a009fcb8f755bb43a0db45eaca17402e03137a0a`
- Devices PR #25427: `31f37c57912e57276c4cc59008eca600c5f51e0c`
- iOS PR #27216: `f69c25de5fbc496c1f1d6bb9f0869b9c83d40f98`
- Computer Use PR #27215: `f0f5679c0512db4992135cf7c3276ceebbd6825c`
- Merged Vault authority: `a982a071b66f4688809ca49c5fb83284f54912dc`
  (verified ancestor of the frozen base)
- Merged Auth consolidation: `c61c7f72123c722f7a14cfd0355f13123ba6c237`
  (verified ancestor of the frozen base)

PR #27221 at `a430c7c4cbea93704b04f52cd8f47b269b4f3b5e`
was not merged because its ancestry is obsolete and its two unique commits
still have unresolved P1 review findings. Their intended behavior was restacked
for shadow analysis only:

- `f479bb9509678c0c5ce818dcc3983bf002f0a3ef` became
  `6f49647fff14bc84503af8e1436510c8be8060b4`.
- `a430c7c4cbea93704b04f52cd8f47b269b4f3b5e` became
  `bb9c3e14ac6191f5d22d32804ea21518841c47a6`.

Stable patch IDs prove those two shadow restacks match the original unique
changes (`85589c94bbf78182e02db82e9ab8bbe20da8755f` and
`7b76eaf66ac7d48248942062c20044c4b8de7ff8`). The P1 repairs are isolated in
`112842af4e`: every main-process reset/status/config request now supplies its
actual target URL before a remote bearer is attached, and a runtime-less
package probes the persisted token on every boot. A failed probe remains an
external-but-unavailable topology and never invents a local runtime or exposes
the unqualified token. These shadow repairs require owner review before any
promotion; neither original #27221 commit is treated as accepted.

PR #26870 at `fa342976d78f6591f012e247a35f76c0bc0cf7fb`
is historical packaged/integration evidence only. It was observed `DIRTY`, was
not merged, and is not an ancestor or build base for this shadow.

## Composition and conflict ownership

The merge order was Shared, Devices, iOS, Computer Use, PR #27221's two unique
shadow patches, the refreshed Computer Use tip, latest Shared, then current
`origin/develop`. The pre-receipt composite is `8cd74d7649c911a24f70f563367369b5ceaa09e6`
with tree `823185f941c8080fe996d8a332b0229aeb61dac8`.

- Shared merged without a textual conflict.
- Devices merged without a textual conflict.
- iOS produced 30 textual conflicts inside the 39 divergent Devices/iOS files
  identified by the independent overlap audit. Devices is authoritative for
  runtime-management security, confirmation/effect binding, managed-network
  activation, relay repositories, and the shared Devices UI. The current
  Devices versions were retained for those conflict files. All nonconflicting
  iOS owner-login, origin-scoped CSRF, native transport, voice, and native-app
  changes were retained.
- The byte-identical iOS `0312_remote_host_managed_network.sql` duplicate was
  omitted in favor of Devices' canonical `0313` migration, preserving the
  append-only migration sequence.
- Origin-scoped iOS CSRF changed the runtime-management fixture's assumption.
  The fixture now seeds the token for the exact `127.0.0.1:31337` origin rather
  than leaking a page-origin cookie across origins.
- iOS retained the legacy cockpit adapter to the unified Devices container.
  The Devices container now exports its existing props shape so that adapter
  remains type-safe without duplicating runtime logic.
- Computer Use and Devices auto-merged additively in
  `electrobun.config.ts`, `electrobun-config.test.ts`, and `desktop-build.mjs`.
  The composite contains both Devices' Linux CEF/version/repackage behavior and
  Computer Use's opt-in direct-only macOS helper, Store refusal, copy map, and
  build flag.
- iOS and Shared overlapped only in translation content; the merge preserved
  the combined catalog.
- Cloud router generation was rerun and produced no generated-source drift.
- The generated action catalog was refreshed and now includes `CALCULATE` and
  `RUNTIMES` (182 registered actions).
- The current-base complete-content policy removed the old shell-relay error
  cap; its stale integration test now verifies complete surrogate-safe error
  delivery. The disposable SSH fixture now supplies the Devices-required
  runtime-bound credential reference. No production behavior was weakened.
- `origin/develop` advanced during the pass through `420a80752e` and then
  `69c0291954`; both deltas merged without conflict. The frozen PR heads were
  re-read from the remote after the final merge and remained unchanged.

## Verification

- App Core focused contracts: 93/93.
- Electrobun complete package lane on the final source composite: 1,475/1,475
  across 149 files.
- PR #27221 target-origin/runtime-less regressions plus main reset transport:
  27/27; focused standalone TypeScript compile passed.
- Computer Use routing/coordinator/MCP: 30/30.
- Computer Use packaging/helper contracts: 18/18.
- Agent runtime/auth contracts: 40/40.
- Shared loopback and App Control runtime-management contracts: 138/138.
- UI Devices/auth/permissions/voice/startup contracts: 145/145.
- UI typecheck: passed.
- Computer Use typecheck: passed.
- Cloud API remote pairing/relay contracts: 43/43.
- Cloud Shared secure relay/repository contracts: 21 passed; the explicit
  Postgres-only migration fixture remained skipped in the local no-database
  lane.
- iOS build/device/App Intent contracts: 171/171.
- App Core, Agent, UI, and Computer Use source-package builds: passed.
- Final App Core source-package build passed; final Core Node build and
  in-memory deletion regression 7/7 passed.
- Latest Shared public-error contract: 40/40; Cloud API owner-safe detail/list
  routes: 12/12 and 27/27 using the required isolated runner.
- Latest CLI language validation: 3/3 using Vitest. A direct `bun test` attempt
  was rejected as the wrong runner (`vi.mocked` is unavailable there) and is
  not counted as product evidence.
- npm pack dry runs:
  - `@elizaos/app-core`: 1,480 entries, 12,862,054 bytes unpacked on the final
    source composite (5,144,045-byte archive estimate).
  - `@elizaos/agent`: 1,031 entries, 10,524,169 bytes unpacked.
  - `@elizaos/ui`: 5,397 entries, 23,464,267 bytes unpacked.
  - `@elizaos/plugin-computeruse`: 122 entries, 4,595,892 bytes unpacked.
- Release launch-QA plan dry run: passed; no command from the plan was executed.
- Scoped Biome and `git diff --check`: passed.
- Gitleaks scanned 231 feature commits / about 1.89 MB against current develop
  with redaction enabled and found no leaks.

The direct package builds use `tsc6 --noCheck` by design. UI and Computer Use
strict typechecks passed. Initial App Core/Agent package-local typechecks also
reported unresolved optional private workspace packages because those packages
were not built in the disposable checkout; the owned collision surfaces were
then covered by focused tests and successful package builds. This setup-only
result is not represented as a strict full-monorepo typecheck pass.

## Final-package rebuild manifest

Before the one final native package is built or launched:

1. Refresh all live PR heads and `origin/develop`; recompose if any SHA differs
   from the frozen inputs above.
2. Require constituent review/CI readiness, including explicit approval of the
   two repaired #27221 P1 contracts, before promotion.
3. Run the repository release contract/typecheck lanes with all private
   workspace packages built, plus the Postgres migration fixture in its proper
   CI environment.
4. Build exactly one ad-hoc/local candidate from the promoted exact head and
   attest embedded Git/build metadata, package inventory, helper architecture,
   signature mode, and hashes.
5. Preserve the current accepted native rollback receipt, acquire exactly one
   owner for `50001`, `5174`, `31337`, and `31338`, and use a fresh bounded
   launch/state receipt. No port was bound during this shadow pass.
6. Run Nubs-supervised native QA for the compact first-run UI, Workspace/Vault,
   pill/tray/semantic open, Computer Use, Cerebras/Cartesia readiness, and the
   remaining permission/provider/manual gates. Do not infer packaged acceptance
   from this source-only shadow.

The recoverable local tag `nubs/macos-shadow-integration-20260825-v1` resolves
the final manifest checkpoint recorded by this receipt.
