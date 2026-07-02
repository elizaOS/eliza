# Issue #11592 — swept app-chat holds settle markup-inclusively

## Scope

Issue #11592's core (app-chat stranded holds never swept) was fixed by the
merged #11493, verified on develop tip before this change:

- app-chat holds are stamped `settlement_marker = app_chat_reservation_v1`
  (`apps/[id]/chat/route.ts`) and the hold transaction id is threaded through
  every settle/refund site;
- `sweepStaleReservations` matches both marker shapes, claims via a
  compare-and-set on `settled_at`, and refunds under the idempotent
  `recon:<txid>:refund` key;
- the cron route is registered (`api/cron/sweep-credit-reservations`) and
  fans out on the `* * * * *` schedule present in `wrangler.toml`;
- `bun test --isolate --conditions eliza-source` on the 4 money suites from
  #11493's evidence: 68 pass / 0 fail on develop tip.

**Residual bug fixed here — unit mismatch in the sweep's settle target.**
The sweep settles a stale hold to `metadata.estimated_cost`. For generic
reservations that is org-charge units (correct). For app-chat holds it is the
UNBUFFERED BASE cost, while the row amount is the org charge — buffered base
PLUS creator markup (`computeInferenceCharge` via
`appCreditsService.deductCredits`), and the creator's earnings are recorded
at deduct time. So sweeping a stranded MONETIZED app-chat hold refunded the
org the markup too, while the creator kept the earnings: the platform ate the
full creator markup on every swept monetized hold. The pre-existing test
masked this by modeling `reserved_amount == row amount` (markup = 0).

Fix: for `app_chat_reservation` rows, settle the org to
`row amount × (estimated_cost / reserved_amount)` — exactly what a normal
settle at the estimated cost charges (base × (1 + markup)). Markup-0 holds
collapse to the previous math; holds without a usable base pair settle
exact-cost; the result is clamped to the held amount so corrupt metadata can
never become a surprise overage charge.

Remaining scope (documented, not silently dropped): the sweep still does not
reverse the creator-earnings share of the BUFFER delta
(`(reservedBase − estimatedBase) × markup`, $0.10 in the test shape) — that
requires app-earnings machinery (`appCreditsService`) which `creditsService`
cannot import (dependency direction). Platform-absorbed, bounded, rare-path;
flagged for [cloud-money] on the PR.

## Red / green proof (real PGlite)

New test: monetized shape — $1.00 base estimate, 1.5× buffer, 20% markup →
$1.80 hold; sweep must refund $0.60 (org nets $1.20), exactly once.

Pre-fix (develop `credits.ts`, new test only):

```text
error: expect(received).toBeCloseTo(expected, precision)
Expected: 8.8
Received: 9
Received difference: 0.1999999999999993
(fail) CreditsService reservation settlement marker (#11169) > sweep settles
monetized app-chat holds markup-inclusively — exactly one refund, org nets
the marked-up estimate
```

(balance 9.0 = the org was over-refunded $0.80, pocketing the markup)

Post-fix, full suite:

```text
bun test --isolate --conditions eliza-source \
  packages/cloud/shared/src/lib/services/__tests__/credits-reconcile.test.ts
=> Ran 30 tests across 1 file. 0 fail
```

The new tests assert: exactly one refund row (`recon:<txid>:refund`,
`0.600000`), `settled_at` claimed, a re-sweep scans 0 rows, a late
full-refund settle after the sweep is a no-op (`adjustmentType: "none"`,
refund count stays 1) — no double-refund; plus the missing-base-pair hold
settles exact-cost (no refund, no guess).

## Lint / typecheck

```text
biome check packages/cloud/shared/src/lib/services/credits.ts \
  packages/cloud/shared/src/lib/services/__tests__/credits-reconcile.test.ts
=> Checked 2 files. No fixes applied.

bun run --cwd packages/cloud/shared typecheck | grep -E "credits|error TS"
=> no errors for the touched files
```

## UI / Media

N/A — backend money-path cron/settlement fix; no user-facing UI surface.
