import { describe, expect, it } from "vitest";

import {
  analyzeVulkanDispatchLog,
  compareVulkanDispatchLogs,
} from "./vulkan-dispatch-log.mjs";

describe("vulkan dispatch log analyzer", () => {
  it("counts subgroup, q8_1, generic, and split-k matmul dispatches", () => {
    const log = [
      "ggml_vk_mul_mat_q_f16((0x1, name=blk.0.attn_q.weight, type=Q4_K, ne0=5120, ne1=5120, ne2=1, ne3=1, nb0=1",
      "ggml_vk_dispatch_pipeline(matmul_subgroup_q4_k_q8_1_aligned, { ... })",
      "ggml_vk_dispatch_pipeline(matmul_id_q4_k_f32, { ... })",
      "ggml_vk_dispatch_pipeline(mul_mat_mat_split_k_reduce, { ... })",
      "ggml_vk_dispatch_pipeline(add_f32, { ... })",
    ].join("\n");

    const summary = analyzeVulkanDispatchLog(log);

    expect(summary.totalDispatches).toBe(4);
    expect(summary.matmulDispatches).toBe(3);
    expect(summary.subgroupDispatches).toBe(1);
    expect(summary.q8_1Dispatches).toBe(1);
    expect(summary.genericMatmulDispatches).toBe(1);
    expect(summary.splitKDispatches).toBe(1);
    expect(summary.matmulOps).toEqual([
      {
        op: "mul_mat_q_f16",
        tensor: "blk.0.attn_q.weight",
        src0Type: "Q4_K",
        src0Shape: [5120, 5120, 1, 1],
      },
    ]);
  });

  it("reports candidate deltas against a baseline log", () => {
    const baseline =
      "ggml_vk_dispatch_pipeline(matmul_subgroup_q4_k_q8_1_aligned, { ... })";
    const candidate = [
      "ggml_vk_dispatch_pipeline(matmul_q4_k_f32, { ... })",
      "ggml_vk_dispatch_pipeline(matmul_q4_k_f32, { ... })",
    ].join("\n");

    const compared = compareVulkanDispatchLogs(baseline, candidate);

    expect(compared.delta.subgroupDispatches).toBe(-1);
    expect(compared.delta.genericMatmulDispatches).toBe(2);
    expect(compared.delta.matmulDispatches).toBe(1);
  });
});
