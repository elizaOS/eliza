# ChampSim 2024-12 prefetcher ports

In-repo ports of five CRC-style prefetcher drop-ins to the ChampSim
2024-12 module API. The published reference implementations all target
the legacy ChampSim 2.x interface (free-function
`CACHE::l2c_prefetcher_operate(uint64_t, uint64_t, ...)` etc.) and do
not link against ChampSim 2024-12 without a full port.

| Name   | Paper                                 | Path                  | Attached to |
|--------|---------------------------------------|-----------------------|-------------|
| Berti  | Navarro-Torres et al., MICRO'22       | `berti/`              | L2C         |
| IPCP   | Pakalapati & Panda, ISCA'20           | `ipcp/`               | L2C         |
| Bingo  | Bakhshalipour et al., HPCA'19         | `bingo/`              | L2C         |
| BOP    | Michaud, HPCA'16                      | `bop/`                | L2C         |
| Pythia | Bera et al., MICRO'21                 | `pythia/`             | L2C         |

Each port is a single `<name>.h` + `<name>.cc` against
`champsim::modules::prefetcher`. The per-port algorithmic scope and
documented deviations from the published reference (e.g. Berti's
demand-to-fill latency table is not wired through ChampSim 2024-12's
prefetcher interface) live in
`docs/evidence/cache/champsim_external_prefetchers_report.json`
under `ported_modules.<name>`.

Pythia is a CPU C++ tabular-SARSA prefetcher — NOT a GPU/ML stack.
Earlier project notes describing it as RL-via-GPU were incorrect and
have been corrected in `docs/evidence/cache/cache-evidence-gate.yaml`
and `pythia_dpc3_report.json`.

## Install + build

```bash
./scripts/champsim_prefetcher_ports/install.sh
```

This copies the source into `external/ChampSim/prefetcher/<name>/`,
the build config into `external/ChampSim/build-configs/`, and runs
`./config.sh + make` for each. Output binaries land in
`external/ChampSim/bin/champsim_pref_<name>`.

## Sweep

```bash
python3 scripts/champsim_sweep.py --mode prefetch \
    --warmup 2000000 --sim 2000000 --commit-evidence
```

Results land in `docs/evidence/cache/champsim_prefetch_sweep_report.json`
with all ten prefetchers (no, next_line, ip_stride, spp_dev,
va_ampm_lite, berti, ipcp, bingo, bop, pythia) on the three DPC-3
traces (401.bzip2-7B, 403.gcc-16B, 429.mcf-22B). All numbers carry
`evidence_class: champsim_dpc3_traces_only` and must not be promoted
to phone-class without silicon or full-system-simulator evidence.
