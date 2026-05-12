// CPU thread-parallelism for the QJL attention ops in the elizaOS/llama.cpp fork (v1.0.0-eliza).
//
// What this module does (applied after `git reset --hard` on the cached
// fork checkout, every build):
//
//   1. ggml/src/ggml-cpu/ggml-cpu.c — task-count switch: bumps
//      GGML_OP_ATTN_SCORE_QJL and GGML_OP_FUSED_ATTN_QJL_TBQ from
//      `n_tasks = 1` to `n_tasks = n_threads`, and adds a work-size case
//      for GGML_OP_FUSED_ATTN_QJL_TBQ so each task gets its own
//      n_kv_tokens-sized fp32 softmax-weight scratch slice in `wdata`.
//
//   2. ggml/src/ggml-cpu/qjl/quants-qjl.c — rewrites
//      ggml_compute_forward_attn_score_qjl to split the flattened
//      (i3, i2, h_q) output space over ith/nth. Each task owns a disjoint
//      set of (plane, head) score rows; the QJL score kernel is per-head
//      and stateless, so calling it with n_heads=1/n_kv_heads=1 plus the
//      right q / packed_k / scores offsets is a clean shard.
//
//   3. ggml/src/ggml-cpu/fused-attn-qjl-tbq.c — rewrites
//      ggml_compute_forward_fused_attn_qjl_tbq to split the same flattened
//      (i3, i2, h_q) space. Each task uses `params->wdata + ith *
//      n_kv_tokens` for its softmax scratch (no shared scratch race); the
//      per-kv-head staging buffers were already `__thread`-local.
//
// Both halves ship together — bumping n_tasks without the ith/nth split
// would be a data race. Idempotent: each mutation carries a
// `// ELIZA-CPU-THREAD-PARALLELISM-V1` sentinel (or `# ...` in CMake-ish
// contexts, but these are all .c here) and the patcher no-ops if present.

import fs from "node:fs";
import path from "node:path";

const SENTINEL = "ELIZA-CPU-THREAD-PARALLELISM-V1";

// --- 1. ggml-cpu.c: task-count + work-size ---------------------------------

function patchGgmlCpuTaskCount(cacheDir) {
  const p = path.join(cacheDir, "ggml", "src", "ggml-cpu", "ggml-cpu.c");
  if (!fs.existsSync(p)) {
    throw new Error(`[cpu-thread-parallelism] missing ${p}`);
  }
  const original = fs.readFileSync(p, "utf8");
  if (original.includes(SENTINEL)) return { path: p, changed: false };
  let patched = original;

  // (a) task count: replace the single-threaded body of the
  // ATTN_SCORE_QJL / FUSED_ATTN_QJL_TBQ case with `n_tasks = n_threads`.
  const taskCaseRe =
    /(case GGML_OP_ATTN_SCORE_QJL:\s*\n\s*case GGML_OP_FUSED_ATTN_QJL_TBQ:\s*\n\s*\{\s*\n)([\s\S]*?)(\n\s*\} break;)/;
  const tm = patched.match(taskCaseRe);
  if (!tm) {
    throw new Error(
      "[cpu-thread-parallelism] ATTN_SCORE_QJL/FUSED_ATTN_QJL_TBQ task-count case not found in ggml-cpu.c",
    );
  }
  const newTaskBody = `                // ${SENTINEL}
                // QJL score forward and the fused QJL-K + TBQ-V kernel
                // both split the flattened (ne3, n_batch, h_q) output
                // space over ith/nth — each task owns disjoint score rows
                // / head outputs, no shared scratch race (the fused op
                // takes a per-task wdata slice; see the work-size case).
                n_tasks = n_threads;`;
  patched = patched.replace(taskCaseRe, `$1${newTaskBody}$3`);

  // (b) work size: give each task its own n_kv_tokens fp32 scratch for
  // the fused op's softmax weights. Insert right after the
  // GGML_OP_FLASH_ATTN_EXT case in the work-size switch.
  const faExtEndRe =
    /(case GGML_OP_FLASH_ATTN_EXT:\s*\n\s*\{[\s\S]*?cur \+= MAX\(prefill, decode\);\s*\n\s*\} break;\n)/;
  const fm = patched.match(faExtEndRe);
  if (!fm) {
    throw new Error(
      "[cpu-thread-parallelism] GGML_OP_FLASH_ATTN_EXT work-size case not found in ggml-cpu.c",
    );
  }
  const wsizeCase = `                // ${SENTINEL}
                case GGML_OP_FUSED_ATTN_QJL_TBQ:
                    {
                        // per-task softmax-weight scratch: n_kv_tokens fp32.
                        // src[1] is the packed K cache, ne[1] = n_kv_tokens.
                        cur += sizeof(float) * node->src[1]->ne[1] * n_tasks;
                    } break;
`;
  patched = patched.replace(faExtEndRe, `$1${wsizeCase}`);

  if (patched === original) {
    throw new Error(
      "[cpu-thread-parallelism] ggml-cpu.c unchanged after patch attempt",
    );
  }
  fs.writeFileSync(p, patched, "utf8");
  return { path: p, changed: true };
}

// --- 2. quants-qjl.c: ggml_compute_forward_attn_score_qjl ------------------

const ATTN_SCORE_QJL_FN = `void ggml_compute_forward_attn_score_qjl(
        const struct ggml_compute_params * params,
        struct ggml_tensor * dst) {
    /* ${SENTINEL} — ith/nth split over flattened (ne3, n_batch, h_q). */
    const struct ggml_tensor * q  = dst->src[0];
    const struct ggml_tensor * pk = dst->src[1];

    GGML_ASSERT(q->type == GGML_TYPE_F32);
    GGML_ASSERT(pk->type == GGML_TYPE_QJL1_256);
    GGML_ASSERT(q->ne[0] == QK_QJL);
    GGML_ASSERT(pk->ne[0] == QJL_HEAD_DIM); /* head_dim, not sketch_dim */

    const int n_heads     = (int) q->ne[1];
    const int n_kv_heads  = ((const int32_t *) dst->op_params)[0];
    const int n_kv_tokens = (int) pk->ne[1];

    GGML_ASSERT(n_kv_heads > 0);
    GGML_ASSERT((n_heads % n_kv_heads) == 0);
    GGML_ASSERT(pk->ne[2] == (int64_t) n_kv_heads);

    const int64_t n_batch = q->ne[2];
    const int64_t ne3     = q->ne[3];
    GGML_ASSERT(pk->ne[3] == ne3);

    const size_t q_stride_b   = q->nb[2];
    const size_t q_stride_3   = q->nb[3];
    const size_t pk_stride_3  = pk->nb[3];
    const size_t s_stride_b   = dst->nb[2];
    const size_t s_stride_3   = dst->nb[3];

    GGML_ASSERT(pk->nb[1] == sizeof(block_qjl1_256));
    GGML_ASSERT(pk->nb[2] == (size_t) n_kv_tokens * sizeof(block_qjl1_256));

    const int gqa = n_heads / n_kv_heads;

    /* Flatten the (ne3, n_batch, h_q) output space; distribute over
     * ith/nth. Each (i3,i2,hq) work unit owns the scores row for one head
     * of one batch plane — the QJL score kernel is per-head and stateless,
     * so calling it with n_heads=1/n_kv_heads=1 plus offset q/packed_k/
     * scores pointers shards cleanly with no shared state. */
    const int64_t n_work = ne3 * n_batch * (int64_t) n_heads;
    const int ith = params->ith;
    const int nth = params->nth;

    for (int64_t w = ith; w < n_work; w += nth) {
        const int64_t hq = w % n_heads;
        const int64_t bi = w / n_heads;          /* i3*n_batch + i2 */
        const int64_t i2 = bi % n_batch;
        const int64_t i3 = bi / n_batch;
        const int64_t hk = hq / gqa;

        const float * q_plane = (const float *) ((const char *) q->data
            + i2 * q_stride_b + i3 * q_stride_3);
        float       * s_plane = (float *)       ((char *)       dst->data
            + i2 * s_stride_b + i3 * s_stride_3);
        const char  * pk_plane = (const char *) pk->data + i3 * pk_stride_3;

        const float * q_head = q_plane + hq * QK_QJL;
        float       * s_head = s_plane + hq * n_kv_tokens;
        const qjl_block_qjl1_256 * pk_head =
            (const qjl_block_qjl1_256 *) (pk_plane + hk * pk->nb[2]);

        /* n_heads=1, n_kv_heads=1 -> gqa=1, hk=0 inside the kernel, so
         * pk_head[0..n_kv_tokens) is exactly this kv-head's blocks. */
        qjl_score_qk(q_head, pk_head, 1, 1, n_kv_tokens, s_head);
    }
}`;

function patchQuantsQjl(cacheDir) {
  const p = path.join(
    cacheDir,
    "ggml",
    "src",
    "ggml-cpu",
    "qjl",
    "quants-qjl.c",
  );
  if (!fs.existsSync(p)) {
    throw new Error(`[cpu-thread-parallelism] missing ${p}`);
  }
  const original = fs.readFileSync(p, "utf8");
  if (original.includes(SENTINEL)) return { path: p, changed: false };
  // Match the whole function body from the signature to the matching brace.
  // The function is the last thing in the file and ends the file; match up
  // to a closing `}` at column 0 followed by optional whitespace + EOF, or
  // the next top-level token. Be conservative: anchor on the known last
  // line of the original body.
  const fnRe =
    /void ggml_compute_forward_attn_score_qjl\(\s*\n\s*const struct ggml_compute_params \* params,\s*\n\s*struct ggml_tensor \* dst\) \{[\s\S]*?\n\}\s*$/;
  if (!fnRe.test(original)) {
    throw new Error(
      "[cpu-thread-parallelism] ggml_compute_forward_attn_score_qjl body not matched in quants-qjl.c",
    );
  }
  const patched = original.replace(fnRe, ATTN_SCORE_QJL_FN + "\n");
  if (patched === original) {
    throw new Error(
      "[cpu-thread-parallelism] quants-qjl.c unchanged after patch attempt",
    );
  }
  fs.writeFileSync(p, patched, "utf8");
  return { path: p, changed: true };
}

// --- 3. fused-attn-qjl-tbq.c: ggml_compute_forward_fused_attn_qjl_tbq ------

const FUSED_ATTN_FN = `void ggml_compute_forward_fused_attn_qjl_tbq(
        const struct ggml_compute_params * params,
        struct ggml_tensor * dst) {
    /* ${SENTINEL} — ith/nth split over flattened (ne3, n_batch, h_q). */
    const struct ggml_tensor * q  = dst->src[0];
    const struct ggml_tensor * pk = dst->src[1];
    const struct ggml_tensor * pv = dst->src[2];

    GGML_ASSERT(q->type  == GGML_TYPE_F32);
    GGML_ASSERT(pk->type == GGML_TYPE_QJL1_256);
    GGML_ASSERT(pv->type == GGML_TYPE_TBQ3_0);
    GGML_ASSERT(q->ne[0]  == FUSED_QJL_PROJ_DIM);
    GGML_ASSERT(pk->ne[0] == FUSED_QJL_HEAD_DIM);
    GGML_ASSERT(pv->ne[0] == FUSED_QJL_HEAD_DIM);

    const int n_heads     = (int) q->ne[1];
    const int n_kv_heads  = ((const int32_t *) dst->op_params)[0];
    const int n_kv_tokens = (int) pk->ne[1];

    union { int32_t i; float f; } scale_bits;
    scale_bits.i = ((const int32_t *) dst->op_params)[1];
    const float sm_scale = scale_bits.f;

    GGML_ASSERT(n_kv_heads > 0);
    GGML_ASSERT((n_heads % n_kv_heads) == 0);
    GGML_ASSERT(pk->ne[2] == (int64_t) n_kv_heads);
    GGML_ASSERT(pv->ne[2] == (int64_t) n_kv_heads);
    GGML_ASSERT(pv->ne[1] == (int64_t) n_kv_tokens);
    GGML_ASSERT(pk->nb[1] == 34); /* sizeof(block_qjl1_256) */

    const int gqa = n_heads / n_kv_heads;
    const int64_t n_batch = q->ne[2];
    const int64_t ne3 = q->ne[3];

    GGML_ASSERT(n_kv_tokens > 0 && n_kv_tokens <= 256 * 1024);

    /* Per-task softmax-weight scratch: n_kv_tokens fp32. ggml-cpu.c's
     * work-size case sizes wdata as n_tasks * n_kv_tokens * sizeof(float),
     * so task ith owns the slice [ith*n_kv_tokens, (ith+1)*n_kv_tokens).
     * No wdata (synthetic single-thread callers): fall back to a small
     * alloca, only valid for nth==1. */
    float * scratch;
    if (params->wdata != NULL) {
        scratch = (float *) params->wdata + (size_t) params->ith * n_kv_tokens;
    } else {
        GGML_ASSERT(params->nth == 1 &&
            "fused-attn: multi-thread path requires wdata");
        GGML_ASSERT(n_kv_tokens <= 8192 &&
            "fused-attn: provide wdata for contexts > 8192 tokens");
        scratch = (float *) alloca((size_t) n_kv_tokens * sizeof(float));
    }

    static const size_t QJL_BLK = 34; /* signs[32] then d (uint16_t) */
    const size_t TBQ_BLK = sizeof(ggml_half) + (FUSED_TBQ_BLOCK * 3 / 8);

    const int64_t n_work = ne3 * n_batch * (int64_t) n_heads;
    const int ith = params->ith;
    const int nth = params->nth;

    for (int64_t w = ith; w < n_work; w += nth) {
        const int64_t hq = w % n_heads;
        const int64_t bi = w / n_heads;          /* i3*n_batch + i2 */
        const int64_t i2 = bi % n_batch;
        const int64_t i3 = bi / n_batch;
        const int64_t hk = hq / gqa;

        const float * q_plane = (const float *) ((const char *) q->data
            + i2 * q->nb[2] + i3 * q->nb[3]);
        float * out_plane = (float *) ((char *) dst->data
            + i2 * dst->nb[2] + i3 * dst->nb[3]);

        const float * q_sketch = q_plane + hq * FUSED_QJL_PROJ_DIM;
        float * out_head = out_plane + hq * FUSED_QJL_HEAD_DIM;

        /* K side: contiguous signs/norms staging, per-thread. */
        const char * pk_plane = (const char *) pk->data
            + i3 * pk->nb[3] + hk * pk->nb[2];
        static __thread uint8_t  k_signs_buf[256 * 1024];   /* bytes */
        static __thread uint16_t k_norms_buf[8 * 1024];     /* tokens */
        GGML_ASSERT((size_t) n_kv_tokens * 32 <= sizeof(k_signs_buf));
        GGML_ASSERT((size_t) n_kv_tokens     <= sizeof(k_norms_buf) / sizeof(uint16_t));
        for (int t = 0; t < n_kv_tokens; t++) {
            memcpy(k_signs_buf + (size_t) t * 32, pk_plane + (size_t) t * QJL_BLK, 32);
            uint16_t d;
            memcpy(&d, pk_plane + (size_t) t * QJL_BLK + 32, sizeof(uint16_t));
            k_norms_buf[t] = d;
        }

        /* V side: tbq3_0, FUSED_TBQ_PER_TOKEN blocks/token, per-thread. */
        const char * pv_plane = (const char *) pv->data
            + i3 * pv->nb[3] + hk * pv->nb[2];
        static __thread uint8_t  v_codes_buf[8 * 1024 * 4 * 12];
        static __thread uint16_t v_scales_buf[8 * 1024 * 4];
        const size_t n_v_blocks = (size_t) n_kv_tokens * FUSED_TBQ_PER_TOKEN;
        GGML_ASSERT(n_v_blocks * 12 <= sizeof(v_codes_buf));
        GGML_ASSERT(n_v_blocks      <= sizeof(v_scales_buf) / sizeof(uint16_t));
        for (size_t blk = 0; blk < n_v_blocks; blk++) {
            const char * src = pv_plane + blk * TBQ_BLK;
            ggml_half d;
            memcpy(&d, src, sizeof(ggml_half));
            v_scales_buf[blk] = (uint16_t) d;
            memcpy(v_codes_buf + blk * (FUSED_TBQ_BLOCK * 3 / 8),
                   src + sizeof(ggml_half),
                   FUSED_TBQ_BLOCK * 3 / 8);
        }

        fused_attn_qjl_tbq_ref(n_kv_tokens, q_sketch,
                                k_signs_buf, k_norms_buf,
                                v_codes_buf, v_scales_buf,
                                sm_scale, scratch, out_head);
    }
}`;

function patchFusedAttn(cacheDir) {
  const p = path.join(
    cacheDir,
    "ggml",
    "src",
    "ggml-cpu",
    "fused-attn-qjl-tbq.c",
  );
  if (!fs.existsSync(p)) {
    throw new Error(`[cpu-thread-parallelism] missing ${p}`);
  }
  const original = fs.readFileSync(p, "utf8");
  if (original.includes(SENTINEL)) return { path: p, changed: false };
  const fnRe =
    /void ggml_compute_forward_fused_attn_qjl_tbq\(\s*\n\s*const struct ggml_compute_params \* params,\s*\n\s*struct ggml_tensor \* dst\) \{[\s\S]*?\n\}\s*$/;
  if (!fnRe.test(original)) {
    throw new Error(
      "[cpu-thread-parallelism] ggml_compute_forward_fused_attn_qjl_tbq body not matched in fused-attn-qjl-tbq.c",
    );
  }
  const patched = original.replace(fnRe, FUSED_ATTN_FN + "\n");
  if (patched === original) {
    throw new Error(
      "[cpu-thread-parallelism] fused-attn-qjl-tbq.c unchanged after patch attempt",
    );
  }
  fs.writeFileSync(p, patched, "utf8");
  return { path: p, changed: true };
}

export function patchCpuThreadParallelism(cacheDir, { dryRun = false } = {}) {
  if (!cacheDir || !fs.existsSync(cacheDir)) {
    throw new Error(
      `[cpu-thread-parallelism] cacheDir does not exist: ${cacheDir}`,
    );
  }
  if (dryRun) {
    console.log(
      "[cpu-thread-parallelism] (dry-run) would parallelize GGML_OP_ATTN_SCORE_QJL + GGML_OP_FUSED_ATTN_QJL_TBQ over ith/nth",
    );
    return { dryRun: true };
  }
  const a = patchGgmlCpuTaskCount(cacheDir);
  const b = patchQuantsQjl(cacheDir);
  const c = patchFusedAttn(cacheDir);
  console.log(
    `[cpu-thread-parallelism] ggml-cpu.c ${a.changed ? "patched" : "already-current"}; ` +
      `quants-qjl.c ${b.changed ? "patched" : "already-current"}; ` +
      `fused-attn-qjl-tbq.c ${c.changed ? "patched" : "already-current"} ` +
      "(ATTN_SCORE_QJL + FUSED_ATTN_QJL_TBQ now split over ith/nth).",
  );
  return { ggmlCpu: a, quantsQjl: b, fusedAttn: c };
}
