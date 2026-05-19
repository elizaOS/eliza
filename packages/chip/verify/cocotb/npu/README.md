# NPU cocotb gap coverage

Scaffolds for the v0 NPU descriptor-queue ABI documented in
`docs/arch/npu-microarch.md`. Tests are decorated with `skip=True` until
the `e1_npu_gemmini_wrapper` RTL lands; they encode the queue, IRQ, and
unsupported-op contract that wrapper must satisfy.

Tracked under
`verify/rtl_gap_work_order.yaml#areas.npu.critical_gaps.npu-production-accelerator`
and `npu-test-coverage-accounting`.
