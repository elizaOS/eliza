## CPU cocotb extended tests (OoO agent)

These tests target the OoO/CPU integration boundary documented in
`docs/arch/ooo-cluster.md` and `docs/arch/cpu-subsystem.md`. They cover
machinery the tiny stub CPU at `rtl/cpu/e1_cpu_subsystem_stub.sv` cannot
exercise: privileged CSR access, trap entry, MMU page-walks.

### Status

| Test | Status | DUT | Notes |
|---|---|---|---|
| `test_csr_trap.py` | BLOCKED on real core | CVA6/Kunminghu wrapper | Stub CPU lacks CSR file + privilege. Test is parked as a structural check that runs when `+define+E1_HAVE_CVA6` makes the real CVA6 core available. |
| `test_mmu_sv39.py` | BLOCKED on real core | CVA6/Kunminghu wrapper | Same gating as CSR/trap test. |
| `test_fusion_table.py` | runs on host | n/a — pure Python | Sanity-checks `rtl/cpu/fusion/fusion_pkg.sv` enumerates the contract list. |
| `test_zihpm_event_table.py` | runs on host | n/a — pure Python | Sanity-checks `rtl/cpu/csr/zihpm.sv` event enum agrees with the OoO domain contract. |

`make cocotb-cpu-extended` (added under the same Makefile section as the
existing `cocotb-cpu`) runs the host-side checks and reports BLOCKED with
a clear reason for the gated ones.
