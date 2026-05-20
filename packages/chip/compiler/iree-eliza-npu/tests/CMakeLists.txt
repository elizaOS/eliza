# MLIR FileCheck-style tests for the elizanpu dialect. These are skipped
# unless the IREE / MLIR opt tool is built. The Python descriptor-word
# parity test lives at tests/test_descriptor_parity.py and runs under the
# repo-wide pytest harness regardless of whether the dialect is built.

if(TARGET elizanpu-opt)
  add_test(
    NAME elizanpu_roundtrip
    COMMAND elizanpu-opt --verify-roundtrip
            ${CMAKE_CURRENT_SOURCE_DIR}/roundtrip.mlir
  )
  add_test(
    NAME elizanpu_legalize_ring
    COMMAND elizanpu-opt --elizanpu-legalize-ring
            ${CMAKE_CURRENT_SOURCE_DIR}/legalize_ring.mlir
  )
endif()
