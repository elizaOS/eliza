// RUN: elizanpu-opt --elizanpu-legalize-ring --verify-diagnostics %s

func.func @ring_overflow(%addr: i32, %op_b: i32, %acc: i32) -> () {
  %ring = elizanpu.acquire_ring : !elizanpu.ring
  // expected-error@+1 {{descriptor ring overflow: 9 submissions in one region exceeds 8-entry ring}}
  %r1 = elizanpu.submit_descriptor %ring, opcode = 0, src = %addr, offset = 0, bytes = 4, op_b = %op_b, acc = %acc {writeback_request = false} : (!elizanpu.ring, i32, i32, i32) -> !elizanpu.ring
  %r2 = elizanpu.submit_descriptor %r1, opcode = 0, src = %addr, offset = 0, bytes = 4, op_b = %op_b, acc = %acc {writeback_request = false} : (!elizanpu.ring, i32, i32, i32) -> !elizanpu.ring
  %r3 = elizanpu.submit_descriptor %r2, opcode = 0, src = %addr, offset = 0, bytes = 4, op_b = %op_b, acc = %acc {writeback_request = false} : (!elizanpu.ring, i32, i32, i32) -> !elizanpu.ring
  %r4 = elizanpu.submit_descriptor %r3, opcode = 0, src = %addr, offset = 0, bytes = 4, op_b = %op_b, acc = %acc {writeback_request = false} : (!elizanpu.ring, i32, i32, i32) -> !elizanpu.ring
  %r5 = elizanpu.submit_descriptor %r4, opcode = 0, src = %addr, offset = 0, bytes = 4, op_b = %op_b, acc = %acc {writeback_request = false} : (!elizanpu.ring, i32, i32, i32) -> !elizanpu.ring
  %r6 = elizanpu.submit_descriptor %r5, opcode = 0, src = %addr, offset = 0, bytes = 4, op_b = %op_b, acc = %acc {writeback_request = false} : (!elizanpu.ring, i32, i32, i32) -> !elizanpu.ring
  %r7 = elizanpu.submit_descriptor %r6, opcode = 0, src = %addr, offset = 0, bytes = 4, op_b = %op_b, acc = %acc {writeback_request = false} : (!elizanpu.ring, i32, i32, i32) -> !elizanpu.ring
  %r8 = elizanpu.submit_descriptor %r7, opcode = 0, src = %addr, offset = 0, bytes = 4, op_b = %op_b, acc = %acc {writeback_request = false} : (!elizanpu.ring, i32, i32, i32) -> !elizanpu.ring
  %r9 = elizanpu.submit_descriptor %r8, opcode = 0, src = %addr, offset = 0, bytes = 4, op_b = %op_b, acc = %acc {writeback_request = false} : (!elizanpu.ring, i32, i32, i32) -> !elizanpu.ring
  return
}
