`timescale 1ns/1ps

// e1_axi4_riscv_atomics
//
// Thin port-adapter around the vendored pulp-platform `axi_riscv_atomics`
// filter (external/cva6/cva6/vendor/pulp-platform/axi_riscv_atomics) that lives
// in CVA6's own vendor tree.  It maps the boot top's flat AXI4 net names onto
// the vendored module's slv_*/mst_* port set.  This is the single atomics path
// for e1_cva6_dram_boot_top across all three boot tests (bare-metal, OpenSBI,
// Linux).
//
// Why the vendored filter: CVA6's `wt_axi_adapter` tracks each outstanding
// write in an internal ID FIFO and assumes the downstream resolves RISC-V
// atomics with the exact AXI ordering the RVWMO model prescribes — an atomic's
// B (and, for load-type atomics, R) must be returned in the order CVA6's
// write-tracking FIFO expects, and LR/SC exclusive responses must reflect a
// real reservation.  The bespoke read-modify-write adapter approximated that
// ordering for the boot lottery but did not hold it once OpenSBI's post-banner
// printing interleaves ordinary stores with lr/sc, tripping
// `i_wr_dcache_id.empty_read`.  `axi_riscv_atomics` is the upstream-correct
// implementation (RVWMO-compliant AMO engine + a real LR/SC reservation table),
// so it preserves the ordering CVA6 assumes and the assertion no longer fires.
//
// Downstream sees only plain AXI4: the filter fully resolves every AMO into a
// read-modify-write burst and every LR/SC into an ordinary read / conditional
// write, emitting AWATOP==0 and AxLOCK==0.  The fabric and DRAM controller
// therefore need no atomic or exclusive-access support.
//
// Geometry: the single in-order CVA6 cv64a6 master is 64-bit data / 64-bit
// addr / 4-bit ID, RV64 (RISCV_WORD_WIDTH=64, so both .w and .d AMOs resolve
// from the write strobes).  AXI_MAX_WRITE_TXNS bounds the filter's outstanding
// write tracking; CVA6's write-through dcache issues one write transaction at a
// time on this port, so a small depth is sufficient — keep margin at 4.

module e1_axi4_riscv_atomics #(
    parameter int unsigned ID_W            = 4,
    parameter int unsigned ADDR_W          = 64,
    parameter int unsigned DATA_W          = 64,
    parameter int unsigned USER_W          = 1,
    parameter int unsigned MAX_WRITE_TXNS  = 4,
    parameter int unsigned RISCV_WORD_WIDTH = 64
) (
    input  logic clk,
    input  logic rst_n,

    // ── Upstream slave (the CVA6 master) ──────────────────────────────────
    input  logic [ID_W-1:0]     u_aw_id,
    input  logic [ADDR_W-1:0]   u_aw_addr,
    input  logic [7:0]          u_aw_len,
    input  logic [2:0]          u_aw_size,
    input  logic [1:0]          u_aw_burst,
    input  logic                u_aw_lock,
    input  logic [3:0]          u_aw_cache,
    input  logic [2:0]          u_aw_prot,
    input  logic [3:0]          u_aw_qos,
    input  logic [3:0]          u_aw_region,
    input  logic [5:0]          u_aw_atop,
    input  logic [USER_W-1:0]   u_aw_user,
    input  logic                u_aw_valid,
    output logic                u_aw_ready,
    input  logic [DATA_W-1:0]   u_w_data,
    input  logic [DATA_W/8-1:0] u_w_strb,
    input  logic                u_w_last,
    input  logic [USER_W-1:0]   u_w_user,
    input  logic                u_w_valid,
    output logic                u_w_ready,
    output logic [ID_W-1:0]     u_b_id,
    output logic [1:0]          u_b_resp,
    output logic [USER_W-1:0]   u_b_user,
    output logic                u_b_valid,
    input  logic                u_b_ready,
    input  logic [ID_W-1:0]     u_ar_id,
    input  logic [ADDR_W-1:0]   u_ar_addr,
    input  logic [7:0]          u_ar_len,
    input  logic [2:0]          u_ar_size,
    input  logic [1:0]          u_ar_burst,
    input  logic                u_ar_lock,
    input  logic [3:0]          u_ar_cache,
    input  logic [2:0]          u_ar_prot,
    input  logic [3:0]          u_ar_qos,
    input  logic [3:0]          u_ar_region,
    input  logic [USER_W-1:0]   u_ar_user,
    input  logic                u_ar_valid,
    output logic                u_ar_ready,
    output logic [ID_W-1:0]     u_r_id,
    output logic [DATA_W-1:0]   u_r_data,
    output logic [1:0]          u_r_resp,
    output logic                u_r_last,
    output logic [USER_W-1:0]   u_r_user,
    output logic                u_r_valid,
    input  logic                u_r_ready,

    // ── Downstream master (to the width converter / fabric) ───────────────
    output logic [ID_W-1:0]     d_aw_id,
    output logic [ADDR_W-1:0]   d_aw_addr,
    output logic [7:0]          d_aw_len,
    output logic [2:0]          d_aw_size,
    output logic [1:0]          d_aw_burst,
    output logic                d_aw_lock,
    output logic [3:0]          d_aw_cache,
    output logic [2:0]          d_aw_prot,
    output logic [3:0]          d_aw_qos,
    output logic [3:0]          d_aw_region,
    output logic [5:0]          d_aw_atop,
    output logic [USER_W-1:0]   d_aw_user,
    output logic                d_aw_valid,
    input  logic                d_aw_ready,
    output logic [DATA_W-1:0]   d_w_data,
    output logic [DATA_W/8-1:0] d_w_strb,
    output logic                d_w_last,
    output logic [USER_W-1:0]   d_w_user,
    output logic                d_w_valid,
    input  logic                d_w_ready,
    input  logic [ID_W-1:0]     d_b_id,
    input  logic [1:0]          d_b_resp,
    input  logic [USER_W-1:0]   d_b_user,
    input  logic                d_b_valid,
    output logic                d_b_ready,
    output logic [ID_W-1:0]     d_ar_id,
    output logic [ADDR_W-1:0]   d_ar_addr,
    output logic [7:0]          d_ar_len,
    output logic [2:0]          d_ar_size,
    output logic [1:0]          d_ar_burst,
    output logic                d_ar_lock,
    output logic [3:0]          d_ar_cache,
    output logic [2:0]          d_ar_prot,
    output logic [3:0]          d_ar_qos,
    output logic [3:0]          d_ar_region,
    output logic [USER_W-1:0]   d_ar_user,
    output logic                d_ar_valid,
    input  logic                d_ar_ready,
    input  logic [ID_W-1:0]     d_r_id,
    input  logic [DATA_W-1:0]   d_r_data,
    input  logic [1:0]          d_r_resp,
    input  logic                d_r_last,
    input  logic [USER_W-1:0]   d_r_user,
    input  logic                d_r_valid,
    output logic                d_r_ready
);
    // The vendored module carries no AxPROT/AxREGION mismatch with CVA6's 3-bit
    // prot / 4-bit region, and resolves AxLOCK internally (LR/SC reservation
    // table), so the downstream AxLOCK output is always 0 — the fabric needs no
    // exclusive monitor.  ar has no atop field (reads carry no atomics).
    axi_riscv_atomics #(
        .AXI_ADDR_WIDTH     (ADDR_W),
        .AXI_DATA_WIDTH     (DATA_W),
        .AXI_ID_WIDTH       (ID_W),
        .AXI_USER_WIDTH     (USER_W),
        .AXI_MAX_WRITE_TXNS (MAX_WRITE_TXNS),
        .RISCV_WORD_WIDTH   (RISCV_WORD_WIDTH)
    ) i_atomics (
        .clk_i           (clk),
        .rst_ni          (rst_n),
        // Slave (CVA6) side
        .slv_aw_addr_i   (u_aw_addr),
        .slv_aw_prot_i   (u_aw_prot),
        .slv_aw_region_i (u_aw_region),
        .slv_aw_atop_i   (u_aw_atop),
        .slv_aw_len_i    (u_aw_len),
        .slv_aw_size_i   (u_aw_size),
        .slv_aw_burst_i  (u_aw_burst),
        .slv_aw_lock_i   (u_aw_lock),
        .slv_aw_cache_i  (u_aw_cache),
        .slv_aw_qos_i    (u_aw_qos),
        .slv_aw_id_i     (u_aw_id),
        .slv_aw_user_i   (u_aw_user),
        .slv_aw_ready_o  (u_aw_ready),
        .slv_aw_valid_i  (u_aw_valid),
        .slv_ar_addr_i   (u_ar_addr),
        .slv_ar_prot_i   (u_ar_prot),
        .slv_ar_region_i (u_ar_region),
        .slv_ar_len_i    (u_ar_len),
        .slv_ar_size_i   (u_ar_size),
        .slv_ar_burst_i  (u_ar_burst),
        .slv_ar_lock_i   (u_ar_lock),
        .slv_ar_cache_i  (u_ar_cache),
        .slv_ar_qos_i    (u_ar_qos),
        .slv_ar_id_i     (u_ar_id),
        .slv_ar_user_i   (u_ar_user),
        .slv_ar_ready_o  (u_ar_ready),
        .slv_ar_valid_i  (u_ar_valid),
        .slv_w_data_i    (u_w_data),
        .slv_w_strb_i    (u_w_strb),
        .slv_w_user_i    (u_w_user),
        .slv_w_last_i    (u_w_last),
        .slv_w_ready_o   (u_w_ready),
        .slv_w_valid_i   (u_w_valid),
        .slv_r_data_o    (u_r_data),
        .slv_r_resp_o    (u_r_resp),
        .slv_r_last_o    (u_r_last),
        .slv_r_id_o      (u_r_id),
        .slv_r_user_o    (u_r_user),
        .slv_r_ready_i   (u_r_ready),
        .slv_r_valid_o   (u_r_valid),
        .slv_b_resp_o    (u_b_resp),
        .slv_b_id_o      (u_b_id),
        .slv_b_user_o    (u_b_user),
        .slv_b_ready_i   (u_b_ready),
        .slv_b_valid_o   (u_b_valid),
        // Master (fabric) side
        .mst_aw_addr_o   (d_aw_addr),
        .mst_aw_prot_o   (d_aw_prot),
        .mst_aw_region_o (d_aw_region),
        .mst_aw_atop_o   (d_aw_atop),
        .mst_aw_len_o    (d_aw_len),
        .mst_aw_size_o   (d_aw_size),
        .mst_aw_burst_o  (d_aw_burst),
        .mst_aw_lock_o   (d_aw_lock),
        .mst_aw_cache_o  (d_aw_cache),
        .mst_aw_qos_o    (d_aw_qos),
        .mst_aw_id_o     (d_aw_id),
        .mst_aw_user_o   (d_aw_user),
        .mst_aw_ready_i  (d_aw_ready),
        .mst_aw_valid_o  (d_aw_valid),
        .mst_ar_addr_o   (d_ar_addr),
        .mst_ar_prot_o   (d_ar_prot),
        .mst_ar_region_o (d_ar_region),
        .mst_ar_len_o    (d_ar_len),
        .mst_ar_size_o   (d_ar_size),
        .mst_ar_burst_o  (d_ar_burst),
        .mst_ar_lock_o   (d_ar_lock),
        .mst_ar_cache_o  (d_ar_cache),
        .mst_ar_qos_o    (d_ar_qos),
        .mst_ar_id_o     (d_ar_id),
        .mst_ar_user_o   (d_ar_user),
        .mst_ar_ready_i  (d_ar_ready),
        .mst_ar_valid_o  (d_ar_valid),
        .mst_w_data_o    (d_w_data),
        .mst_w_strb_o    (d_w_strb),
        .mst_w_user_o    (d_w_user),
        .mst_w_last_o    (d_w_last),
        .mst_w_ready_i   (d_w_ready),
        .mst_w_valid_o   (d_w_valid),
        .mst_r_data_i    (d_r_data),
        .mst_r_resp_i    (d_r_resp),
        .mst_r_last_i    (d_r_last),
        .mst_r_id_i      (d_r_id),
        .mst_r_user_i    (d_r_user),
        .mst_r_ready_o   (d_r_ready),
        .mst_r_valid_i   (d_r_valid),
        .mst_b_resp_i    (d_b_resp),
        .mst_b_id_i      (d_b_id),
        .mst_b_user_i    (d_b_user),
        .mst_b_ready_o   (d_b_ready),
        .mst_b_valid_i   (d_b_valid)
    );

endmodule
