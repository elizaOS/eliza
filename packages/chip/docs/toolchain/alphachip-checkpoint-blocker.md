# AlphaChip pretrained checkpoint and `plc_wrapper_main` — external blocker

**Status:** the `plc_wrapper_main` placement-cost binary is now obtainable from a
lawful third-party mirror (Farama-Foundation, Apache-2.0) and runs locally; the
**20-block TPU pretrained checkpoint** remains BLOCKED (no lawful mirror found).
A fully-open native proxy-cost path (TILOS `plc_client_os`, BSD-3) is also wired
and needs no binary at all.
**Last audited:** 2026-06-02.
**Owners of the broken artifact:** Google Research (`google-research/circuit_training`).
**Pin record:** `external/circuit_training/pin-manifest.json`
(`checkpoint_status = "gcs-403-with-local-mitigation-blocked-by-closed-source-binary"`).

## Mitigation summary (2026-05-21)

Everything in the AlphaChip toolchain that is *open-source* now builds and
runs locally:

| Component                       | Local path                                                            | Provenance                                                                       |
| ------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Python 3.11 venv                | `external/circuit_training/.venv`                                     | uv-managed `cpython-3.11.14`                                                     |
| `tf-agents[reverb]` `~=0.19.0`  | inside venv                                                           | PyPI                                                                             |
| `tf-keras`                      | inside venv                                                           | PyPI; `TF_USE_LEGACY_KERAS=1`                                                    |
| Ariane test fixtures            | `external/circuit_training/circuit_training/environment/test_data/ariane/{netlist.pb.txt,initial.plc}` | shipped with the Apache-2.0 repo                                                 |
| Bazelisk                        | `external/bazel-bin/bazel` (reports `bazel 9.1.0`)                    | upstream Go binary (static)                                                      |
| Pretraining smoke driver        | `scripts/alphachip/run_pretraining.sh`                                | this repo                                                                        |
| Bootstrap fallback              | `scripts/alphachip/bootstrap_pretrained_checkpoint.sh`                | this repo                                                                        |

These let us drive one PPO iteration on Ariane end-to-end *iff*
`plc_wrapper_main` is present on disk. A lawful copy of that binary is now
available (next section), so the reward function is no longer the blocker; the
remaining hard limits are the missing TPU checkpoint and CT's distributed-PPO
handshake on a CPU-only host (see "Follow-up finding" below).

## Two open paths now exist for the placement-cost reward

The proxy cost is `wirelength + 0.5*congestion + 0.5*density`
(`circuit_training.environment.environment.cost_info_function`). There are now
two open ways to compute it without the closed binary on the GCS bucket:

1. **Lawful third-party mirror of `plc_wrapper_main` (Farama-Foundation).** The
   Apache-2.0 repo
   [`Farama-Foundation/a2perf-circuit-training`](https://github.com/Farama-Foundation/a2perf-circuit-training)
   ships the genuine Linux x86-64 binary at `bin/plc_wrapper_main`
   (`dev` branch, 10,605,424 bytes, raw URL returns HTTP 200 as of 2026-05-21).
   `scripts/alphachip/build_container.sh` already points at this URL via
   `PLC_BINARY_URL`. Downloaded locally to
   `external/circuit_training/checkpoints/plc_wrapper_main`
   (sha256 `86fe9a2841fc21d3c18bb838d93fff128ceb51f82490d561e22985caab00c9b3`),
   it executes and computes all three proxy terms on the vendored Ariane
   fixtures. This is *acquisition of a real published artifact*, not a rebuild:
   the source is still unreleased (see below), but a usable binary is no longer
   "unavailable".

2. **Fully-open native cost function (TILOS `plc_client_os`, BSD-3).** The
   reverse-engineered open reimplementation at
   `external/repos/tilos-macroplacement/payload/CodeElements/Plc_client/plc_client_os.py`
   computes `get_cost` / `get_congestion_cost` / `get_density_cost` in pure
   Python on CPU with **no `plc_wrapper_main` dependency at all**.
   `scripts/alphachip/open_proxy_cost.py` drives it and, when the binary is
   present, records both costs and their delta in
   `build/reports/alphachip/open-proxy-cost.json`
   (schema `eliza.alphachip.open_proxy_cost.v1`).

### Open-client fidelity (Ariane `initial.plc`, measured 2026-05-21)

| Term        | Real binary (Farama)   | Open `plc_client_os` | Delta (open − binary) |
| ----------- | ---------------------- | -------------------- | --------------------- |
| wirelength  | 0.050186607699881      | 0.050186607693903    | -5.98e-12 (bit-match) |
| congestion  | 0.941179621160251      | 0.984565648958765    | +0.043386 (+4.6%)     |
| density     | 0.756401121979883      | 0.750061768642256    | -0.006339 (-0.84%)    |
| proxy cost  | 0.898976979269949      | 0.917500316494413    | +0.018523 (+2.1%)     |

Wirelength matches near bit-exactly; density is within ~1%; the congestion term
uses a stochastic fast-router and diverges ~5%. The open client is therefore a
faithful but **not bit-exact** stand-in: usable as an open reward signal and for
cross-validation, but a placement scored only by `plc_client_os` cannot be
claimed to reproduce a `plc_wrapper_main`-scored result to the last digit.

## Why `plc_wrapper_main` still cannot be built from source

The repository ships zero C++ source, no `BUILD`/`WORKSPACE` files, and no
`.proto` definitions for the placement-cost binary. Upstream maintainer
`esonghori` (Google Research, listed owner of the repo) stated in
[`google-research/circuit_training#11`](https://github.com/google-research/circuit_training/issues/11):

> Unfortunately, the source code for the `plc_wrapper_main` binary includes
> lots of internal Google dependencies which make extremely hard to clean for
> open-sourcing.

The binary is shipped only as a pre-built artifact. The canonical GCS bucket has
been returning HTTP 403 since February 2026, but the Farama mirror above serves
the same artifact. There is no source-based rebuild path and no public bazel
target — "build from source" against this checkout remains a false premise. What
changed in this audit is *availability of a pre-built copy*, not buildability.

## Summary

The canonical artifacts that `external/circuit_training/` (`c5a83e5`, 2023-12-12)
expects to be fetchable from `https://storage.googleapis.com/rl-infra-public/`
have been returning **HTTP 403 `AccessDenied` ("Anonymous caller does not have
storage.objects.get access")** since at least February 2026. The objects either
have had their public ACL revoked or were removed. Affected URLs:

| Artifact                                       | URL                                                                                                              | Status (2026-05-20) |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------- |
| Pretrained checkpoint (20-block TPU)           | `https://storage.googleapis.com/rl-infra-public/circuit-training/tpu_checkpoint_20240815.tar.gz`                  | 403                 |
| `plc_wrapper_main` (latest)                    | `https://storage.googleapis.com/rl-infra-public/circuit-training/placement_cost/plc_wrapper_main`                 | 403                 |
| `plc_wrapper_main_0.0.3`                       | `https://storage.googleapis.com/rl-infra-public/circuit-training/placement_cost/plc_wrapper_main_0.0.3`           | 403                 |
| `plc_wrapper_main_0.0.4`                       | `https://storage.googleapis.com/rl-infra-public/circuit-training/placement_cost/plc_wrapper_main_0.0.4`           | 403                 |
| DREAMPlace py3.9 tarball                       | `https://storage.googleapis.com/rl-infra-public/circuit-training/dreamplace/dreamplace_python3.9.tar.gz`          | 403                 |
| Ariane reference netlist                       | `https://storage.googleapis.com/rl-infra-public/circuit-training/netlist/ariane.circuit_graph.pb.txt.gz`          | 403                 |
| Bucket root                                    | `https://storage.googleapis.com/rl-infra-public/`                                                                 | 403                 |

Reproduce:

```
curl -sS -I -L -o /dev/null \
  -w '%{http_code}\n' \
  https://storage.googleapis.com/rl-infra-public/circuit-training/tpu_checkpoint_20240815.tar.gz
```

Expected output: `403`.

## Upstream issues

All three are open with no maintainer response as of the audit date:

- `google-research/circuit_training#85` — "Cannot access public files during
  Docker build (permission denied on dreamplace)". Reports `dreamplace`,
  `plc_wrapper_main`, and `models` paths all returning AccessDenied.
- `google-research/circuit_training#86` — "Checkpoint is not publicly
  available". Reports the `tpu_checkpoint_20240815.tar.gz` 403 directly. Two
  "+1" comments from other users.
- `google-research/circuit_training#87` — "Unable to download required
  artifacts (plc_wrapper_main and DREAMPlace tarball) from GCS (HTTP 403)".
  Tested 2026-02-19, two "+1" comments.

## Mirror audit (2026-05-21)

A lawful mirror of the **binary and DREAMPlace builds** now exists; no mirror of
the **TPU checkpoint** was found. Channels checked:

- **`Farama-Foundation/a2perf-circuit-training` (Apache-2.0, NOT archived):**
  hosts the genuine `bin/plc_wrapper_main` (10,605,424 bytes, raw URL HTTP 200
  on 2026-05-21) plus a `dreamplace_builds/` directory. This is a live, lawful,
  license-clear mirror of the closed binary and of DREAMPlace. It does **not**
  host the 20-block `tpu_checkpoint_20240815.tar.gz`. This is the recommended
  acquisition path for the binary; it supersedes the earlier "no public mirror
  exists" finding for the binary specifically.
- **GitHub releases on `google-research/circuit_training`:** none — the repo
  publishes no release assets (`gh api repos/google-research/circuit_training/releases`
  returns `[]`).
- **`jayhusemi/AlphaChip` (community fork):** README is a copy of upstream and
  reuses the same `storage.googleapis.com/rl-infra-public/...` URLs. No release
  assets. `docs/PRETRAINING.md` documents the procedure but contains no mirror
  link.
- **`TILOS-AI-Institute/MacroPlacement`:** their March 2025 benchmarks were
  produced *with* the August 2024 pretrained checkpoint but the repo does not
  re-host it — only the tensorboards/results.
- **Hugging Face:** full-text search for `tpu_checkpoint_20240815`,
  `plc_wrapper_main`, and `AlphaChip` returns no model or dataset re-uploads.
- **Zenodo / archive.org via search:** no indexed copy.
- **`web.archive.org` Wayback Availability API:** rate-limited (HTTP 429) on
  this network; not yet confirmed whether a snapshot was ever taken. The GCS
  object's `Content-Type` and lack of an HTML landing page make a Wayback
  snapshot unlikely even if attempted.
- **Paper supplementary materials (`Mirhoseini et al.`, Nature 2024 AlphaChip
  paper):** the paper does not bundle the checkpoint or the `plc_wrapper_main`
  binary; both are released only via the GCS bucket described above.

Upstream never published SHA256s for any of these artifacts, so even the Farama
copy cannot be byte-verified against an *authoritative* upstream hash — we record
our own hash of the downloaded binary
(`86fe9a2841fc21d3c18bb838d93fff128ceb51f82490d561e22985caab00c9b3`) and verify
the file is a Linux x86-64 ELF that runs and computes the documented proxy terms.
The TPU checkpoint remains hash-unverifiable and unavailable.

## Recovery channels

The recovery chain is now three-tiered, in priority order:

1. **Canonical GCS URL.** Returns 403; tried automatically by
   `scripts/alphachip/download_pretrained_checkpoint.sh`.
2. **Private mirror.** `scripts/alphachip/mirror_pretrained_checkpoint.sh`
   downloads from `ALPHACHIP_MIRROR_URL` (HTTP(S) or `file://`) and verifies
   against `ALPHACHIP_MIRROR_SHA256`. Both env vars are required.
3. **Local bootstrap.** `scripts/alphachip/bootstrap_pretrained_checkpoint.sh`
   runs `run_pretraining.sh` against the vendored Ariane fixtures and
   materialises a fresh single-iteration policy directory at the expected
   path. This is the only path that does not depend on a pre-Feb-2026
   colleague-held tarball, *but* it still requires `plc_wrapper_main` on
   disk; without it, `run_pretraining.sh` fails closed with status
   `blocked_plc_wrapper_main` in
   `build/reports/alphachip/pretraining-smoke.json`. The resulting checkpoint
   is a minimum-viable starting point, **not** a replacement for the
   20-block TPU pretrained policy.

## Manual workaround

Until upstream restores the bucket or publishes a mirror:

1. Obtain `tpu_checkpoint_20240815.tar.gz` (and, if Docker builds are needed,
   `plc_wrapper_main_0.0.4`) from a colleague who pulled them **before
   February 2026**, when the bucket was still public.
2. Compute a SHA256 against that local copy and record it in
   `external/circuit_training/pin-manifest.json` (`checkpoint.sha256`,
   `plc_wrapper_main.sha256`) so the rest of the team can byte-verify
   downstream copies.
3. Either:
   - Place the archive at a private URL and export
     `ALPHACHIP_PRETRAINED_URL=<that-url>` before running
     `scripts/alphachip/download_pretrained_checkpoint.sh`; or
   - Unpack the archive manually into a directory and pass
     `ALPHACHIP_POLICY_DIR=<checkpoint_dir>` to the training wrappers
     (`run_e1_softmacro_training.sh`, `run_h200_payload.sh`,
     `ct_single_host_train.sh`).
4. For `plc_wrapper_main`: drop the binary at `/usr/local/bin/plc_wrapper_main`
   (`chmod 555`) **or** export `PLC_WRAPPER_MAIN=/abs/path/to/plc_wrapper_main`
   and pass `--plc_wrapper_main=$PLC_WRAPPER_MAIN` to any
   `circuit_training.environment.plc_client`-driven command.

The mirror helper script
`scripts/alphachip/mirror_pretrained_checkpoint.sh` exists to automate step 3
once a private URL is in hand, and is wired in as a fallback by
`download_pretrained_checkpoint.sh` whenever the GCS path returns non-2xx.

## Owner decision (2026-05-21)

Project owner confirmed no lawful private pre-February-2026 copy of
`plc_wrapper_main` (or the TPU checkpoint) is available. The AlphaChip Circuit
Training RL lane is therefore treated as a **permanent external-artifact
blocker**: no compute (local or Nebius H200) can unblock it because the
placement-cost binary is closed-source and the GCS bucket returns 403. The
standing substitute for macro-placement candidate generation is the
deterministic proxy lane set (legal-grid / target-aware / target-repair plus the
simulated-annealing, Hier-RTLMP, and ChipDiffusion proxy adapters), with
OpenLane/OpenROAD as the authoritative replay. Revisit only if a lawful binary
with a recorded SHA256 is later obtained.

### Follow-up finding (2026-05-21) — the revisit condition is now met for the binary

The owner decision's revisit trigger ("a lawful binary with a recorded SHA256 is
later obtained") is satisfied for `plc_wrapper_main`: the Apache-2.0
`Farama-Foundation/a2perf-circuit-training` mirror serves a genuine, runnable
binary (sha256 `86fe9a2841fc21d3c18bb838d93fff128ceb51f82490d561e22985caab00c9b3`),
verified to compute the documented proxy terms on the Ariane fixtures. Two
irreducible blockers remain and gate any "AlphaChip pretraining reproduced" claim:

1. **TPU pretrained checkpoint** — still has no lawful mirror. Pretraining from
   scratch is possible with the binary above, but the published 20-block policy
   is not recoverable, so we cannot reproduce *its* results.
2. **Full distributed PPO on CPU** — CT's `ppo_reverb_server` blocks in a
   `wait_predicate_fn` handshake that the single-host smoke ordering does not
   satisfy on this CPU host; a real training run wants the GPU collect/train
   topology. The reward function itself is unblocked (binary + open client both
   compute it), but a multi-iteration trained policy is not yet produced here.

What this *does* unblock today, on CPU: the AlphaChip proxy-cost reward via two
open paths — the lawful Farama binary and the BSD-3 `plc_client_os` — proven by
`scripts/alphachip/open_proxy_cost.py --compare-binary`
(`build/reports/alphachip/open-proxy-cost.json`). Owner to decide whether to lift
the binary half of the blocker; the checkpoint half stays closed.

## Re-audit cadence

Re-test the GCS URLs and refresh `pin-manifest.json:last_audited` on the first
day of each month, and immediately whenever any of issues #85/#86/#87 see new
maintainer activity. If/when the bucket is restored or a mirror is published,
record the canonical URL in this document and unblock the gate.
