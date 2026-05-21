# AlphaChip pretrained checkpoint and `plc_wrapper_main` — external blocker

**Status:** historically BLOCKED; now PARTIALLY MITIGATED.
**Last audited:** 2026-05-20.
**Owners of the broken artifact:** Google Research (`google-research/circuit_training`).
**Pin record:** `external/circuit_training/pin-manifest.json`
(`checkpoint_status = "gcs-403-with-local-mitigation-blocked-by-closed-source-binary"`).

## Mitigation summary (2026-05-20)

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
`plc_wrapper_main` is present on disk. They do **not** unblock the
plc_wrapper_main dependency itself — see the next section for why this is
irreducible.

## Why `plc_wrapper_main` cannot be built from source

The repository ships zero C++ source, no `BUILD`/`WORKSPACE` files, and no
`.proto` definitions for the placement-cost binary. Upstream maintainer
`esonghori` (Google Research, listed owner of the repo) stated in
[`google-research/circuit_training#11`](https://github.com/google-research/circuit_training/issues/11):

> Unfortunately, the source code for the `plc_wrapper_main` binary includes
> lots of internal Google dependencies which make extremely hard to clean for
> open-sourcing.

The binary is shipped only as a pre-built artifact via the GCS bucket, and the
GCS bucket has been returning HTTP 403 since February 2026. There is therefore
no source-based recovery path, and no public bazel target to point at. Any
suggestion to "build from source" against this checkout is rooted in a false
premise — the source has never been released, and the maintainer has stated it
will not be in any cleanable form.

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

## Mirror audit (2026-05-20)

No public mirror exists. Channels checked:

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

Upstream never published SHA256s for any of these artifacts, so even if a
copy is recovered later we cannot byte-verify it against an authoritative
hash — we can only verify it against a known-good local copy.

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

## Re-audit cadence

Re-test the GCS URLs and refresh `pin-manifest.json:last_audited` on the first
day of each month, and immediately whenever any of issues #85/#86/#87 see new
maintainer activity. If/when the bucket is restored or a mirror is published,
record the canonical URL in this document and unblock the gate.
