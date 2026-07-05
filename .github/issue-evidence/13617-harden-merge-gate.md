# #13617 — harden the develop merge gate (no self-hosted SPOF hang; still a real gate)

## What changed

`.github/workflows/`:
- **test.yml** — added hosted `merge-quality-gate` (lint + `format:check` +
  repo-wide `typecheck` + stale-base guard + gitleaks secret scan), made `ci-ok`
  need it; gave every self-hosted lane the `HETZNER_FLEET_ONLINE` fleet-drain
  fallback; wired the new contract self-test + check into the `changes` job.
- **scenario-pr / dev-smoke / docker-ci-smoke / mobile-build-smoke /
  windows-dev-smoke / windows-desktop-preload-smoke** — `Classify changed paths`
  classifier moved from `[self-hosted, hetzner-robot]` to `ubuntu-24.04` + timeout.
- **README.md** — Linux Runner Policy reconciled with the current fleet reality.

`packages/scripts/ci-merge-gate-contract.mjs` — contract + `--self-test`.

## Acceptance criterion 1 — a drained fleet no longer wedges the required gate

The required gate's *conclusion path* is now entirely GitHub-hosted:
classifiers, `plugin-tests-status`, `merge-quality-gate`, and `ci-ok` all run on
`ubuntu-24.04`. The heavy self-hosted lanes carry a fleet-drain toggle — there is
no way to probe fleet health from a `runs-on:` expression, so an admin flips one
repo **variable** during an outage. Truth table of the exact expression
`fromJSON(vars.HETZNER_FLEET_ONLINE == 'false' && '["ubuntu-24.04"]' || '["self-hosted","hetzner-robot"]')`:

```
""        -> ["self-hosted","hetzner-robot"]   (default: unchanged)
"true"    -> ["self-hosted","hetzner-robot"]
undefined -> ["self-hosted","hetzner-robot"]
"false"   -> ["ubuntu-24.04"]                  (outage: whole workflow → hosted)
```

One flip unblocks the entire queue instead of per-PR admin-bypass.

**Pending-hardware leg:** actually draining the live `hetzner-robot` fleet and
observing a real merge is an operator action on org infra I cannot perform from
this environment. The full code path (hosted conclusion spine + toggle) is
implemented and machine-verified by the contract; the drain itself is the one
execution leg left to an operator.

## Acceptance criterion 2 — lint + type + stale-base + secret PR is refused

Ran the exact tools `merge-quality-gate` invokes against deliberate violations:

```
biome lint  lint-bad.ts   -> "Found 1 error"          exit 1   (noSelfCompare)
tsc --noEmit type-bad.ts   -> TS2322 not assignable    exit 2
gitleaks    leak.txt       -> "leaks found: 2"         exit 1   (ghp_/sk_live_)
gitleaks    clean.txt      -> no leaks                 exit 0   (control passes)
```

Each non-zero exit fails its step → fails `merge-quality-gate` → `ci-ok` reports
`Required job 'merge-quality-gate' finished with 'failure'` and exits 1 → the
merge queue (sole required context `ci-ok`) refuses the PR. The clean control
proves it is not a blanket-fail. (`ghp_…`/`sk_live_…` are non-allowlisted token
formats; the `AKIA…EXAMPLE` keys gitleaks ships as allowlisted did *not* trip it,
confirming the repo's `.gitleaks.toml` allowlist is honored.)

The merge-group gitleaks range now uses merge-commit patch mode. Local proof on
a synthetic merge commit:

```
normal_has_secret=false
merge_patch_has_secret=true
```

That demonstrates why plain `git log -p -1 <merge>` was insufficient and why
`git log -m -p -1 <merge>` is required for queued merge commits.

## Contract self-test

```
ci-merge-gate-contract self-test: 8 cases passed
ci-merge-gate-contract: classifiers hosted, fleet-drain fallback present, ci-ok enforces the hosted quality gate.
```

The self-test proves a valid fixture passes and each of 7 broken fixtures
(self-hosted classifier, bare self-hosted lane, `ci-ok` missing the gate, gate
missing typecheck, gate missing the stale-base guard, gate missing the secret
scan, gate secret scan missing merge-commit patch mode) is caught.

## N/A
- UI screenshots / video / real-LLM trajectories / audio: no rendered UI, agent,
  model, or voice path changed — this is CI workflow + a node contract script.
