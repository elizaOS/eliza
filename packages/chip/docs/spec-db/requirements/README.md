# Canonical requirement-ID registry

This directory is the single source of truth for stable requirement IDs in the
E1 chip package. Every requirement is a node in the traceability graph
(`scripts/build_traceability_graph.py`) and is validated fail-closed by
`scripts/check_traceability.py`.

## ID format

```
REQ-<DOMAIN>-<4-digit-zero-padded>
```

`DOMAIN` is one of:

| DOMAIN | Registry file | Meaning |
| ------ | ------------- | ------- |
| `SPEC`   | `spec.yaml`   | Target-spec / contract requirements (docs/spec-db) |
| `ARCH`   | `arch.yaml`   | Architecture-level requirements |
| `RTL`    | `rtl.yaml`    | RTL closure requirements (verify/rtl_gap_work_order) |
| `TIMING` | `timing.yaml` | Timing-closure requirements |
| `POWER`  | `power.yaml`  | Power/thermal requirements |
| `DFT`    | `dft.yaml`    | Design-for-test requirements |
| `VERIF`  | `verif.yaml`  | Verification proof/coverage requirements |
| `PKG`    | `pkg.yaml`    | Package/board requirements |
| `PD`     | `pd.yaml`     | Physical-design signoff requirements |
| `MFG`    | `mfg.yaml`    | Manufacturing/tapeout artifact requirements |
| `NODE`   | `node.yaml`   | Process-node-profile requirements |

Only the registry files that have real requirements exist on disk. The builder
and gate accept any subset of the table above. IDs are stable: never renumber
or reuse a retired ID.

## Schema: `eliza.requirement.v1`

Each registry file is a mapping with `schema`, `domain`, `owner_scope`,
`description`, and a `requirements` list. Each requirement has:

| Field | Required | Notes |
| ----- | -------- | ----- |
| `id` | yes | `REQ-<DOMAIN>-NNNN`, must match the file's `domain` |
| `title` | yes | One-line human description |
| `owner` | yes | Subsystem owner (`cpu`, `memory`, `npu`, `pd`, ...) |
| `source_doc` | yes | Repo-relative path to the document the requirement is drawn from |
| `source_doc_sha` | yes | SHA-256 (or 16-char prefix) of `source_doc` at registration time |
| `status` | yes | Free-form lifecycle tag (`target_spec`, `contract`, `open`, `blocked`, ...) |
| `claim_boundary` | yes | The fail-closed boundary string, mirrors the source doc |
| `links` | yes | `{rtl:[], tests:[], pd_evidence:[], mfg_artifacts:[]}` — repo-relative paths |
| `gates` | no | Gate names from `scripts/aggregate_tapeout_readiness.py` GATES that validate this requirement |
| `work_order_id` | no | The matching `verify/rtl_gap_work_order.yaml` gap id, when seeded from there |
| `waiver` | no | `{owner, reason, expiry}` — see below |

### Link resolution (fail-closed)

Every path under `links.{rtl,tests,pd_evidence,mfg_artifacts}` must resolve to a
real file in the package. A missing path is a dangling link and fails
`check_traceability.py`. A requirement with no links at all is an orphan and
also fails, unless it carries a valid waiver.

### Waivers

```yaml
waiver:
  owner: pd
  reason: blocked on commercial-EDA vendor access
  expiry: 2026-12-31
```

A waiver suppresses the orphan/dangling failure for that requirement until
`expiry` (ISO date). An expired waiver fails closed. `BLOCKED` requirements
(e.g. NDA advanced nodes, vendor-gated EDA) keep their blocked status — a waiver
is the auditable record of that block, never a way to claim closure.

## How other agents reference these IDs

Other domain artifacts add a `requirement_ids: []` list that cites the IDs in
this registry. The traceability graph reads those back-references to build
req↔artifact edges, so add IDs here first, then reference them.

## Generated outputs

`scripts/build_traceability_graph.py` writes:

- `docs/spec-db/traceability/graph.json` (`eliza.traceability_graph.v1`)
- `docs/spec-db/traceability/matrix.md` (human-readable trace matrix)
- `docs/spec-db/traceability/coverage.json` (`eliza.traceability_coverage.v1`,
  per-requirement closure %, extends tapeout-readiness)

Make targets: `make traceability-build`, `make traceability-check`,
`make change-impact PATH=<changed-path>`.
