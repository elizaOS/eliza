# NPU cocotb gap coverage

Scaffolds for the v0 NPU descriptor-queue ABI documented in
`docs/arch/npu-microarch.md`. The historical queue-stress tests here remain
skipped until the `e1_npu_gemmini_wrapper` RTL lands.

The live local RTL coverage gate is `make cocotb-npu`. It runs
`verify/cocotb/test_e1_npu.py`, the focused software-fallback pytest, and
`scripts/check_npu_coverage_summary.py`. The checker writes
`build/reports/npu_coverage_summary.json` and fails closed unless opcode,
shape, saturation, invalid-programming, IRQ, descriptor accounting, counter,
and software fallback bins are present.

Tracked under
`verify/rtl_gap_work_order.yaml#areas.npu.critical_gaps.npu-production-accelerator`
and `npu-test-coverage-accounting`.
