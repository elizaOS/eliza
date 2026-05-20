// RUN: elizanpu-opt --verify-roundtrip %s | FileCheck %s

// CHECK-LABEL: func.func @descriptor_round_trip
func.func @descriptor_round_trip(%addr: i32, %op_b: i32, %acc: i32) -> () {
  %ring = elizanpu.acquire_ring : !elizanpu.ring
  // CHECK: elizanpu.submit_descriptor
  // CHECK-SAME: opcode = 4
  // CHECK-SAME: offset = 0
  // CHECK-SAME: bytes = 32
  %ring2 = elizanpu.submit_descriptor %ring,
      opcode = 4, src = %addr, offset = 0, bytes = 32,
      op_b = %op_b, acc = %acc {writeback_request = false}
      : (!elizanpu.ring, i32, i32, i32) -> !elizanpu.ring
  return
}

// CHECK-LABEL: func.func @gemm_tile
func.func @gemm_tile(%addr: i32) -> () {
  %ring = elizanpu.acquire_ring : !elizanpu.ring
  %scratch = "test.dummy_scratch"() : () -> !elizanpu.scratch
  // CHECK: elizanpu.tile_dma
  %ring1, %scratch1 = elizanpu.tile_dma %ring, %scratch, %addr,
      offset = 0, bytes = 12
      : (!elizanpu.ring, !elizanpu.scratch, i32) -> (!elizanpu.ring, !elizanpu.scratch)
  // CHECK: elizanpu.gemm_s8
  // CHECK-SAME: m = 3
  // CHECK-SAME: n = 3
  // CHECK-SAME: k = 3
  %ring2, %scratch2 = elizanpu.gemm_s8 %ring1, %scratch1,
      m = 3, n = 3, k = 3, a_base = 0, b_base = 16, c_base = 32
      : (!elizanpu.ring, !elizanpu.scratch) -> (!elizanpu.ring, !elizanpu.scratch)
  return
}
