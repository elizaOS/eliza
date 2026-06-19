// -----------------------------------------------------------------------------
// Eliza E1 — Power Management Core (PMC) top
//
// AON-resident wrapper for the Ibex RV32IMC management core. This module
// exposes:
//   - 4 KiB AHB-Lite-equivalent mailbox window for the S-mode Linux/SBI
//     stack (PMC_REG_* offsets in rtl/power/power_pkg.sv).
//   - External PMIC interface stubs (SPMI v2 master + I2C-FM-plus fallback).
//   - Droop / AVFS telemetry from the six DVFS-managed rails.
//
// The Ibex core itself is pinned via the BSP manifest; do NOT vendor sources.
// This wrapper instantiates a "u_ibex_pmc" symbolic black-box: actual binding
// resolves at integration in rtl/top/. See docs/pd/power-management-firmware.md
// and external manifest entry "ibex_pmc" for the pinned upstream tag.
// -----------------------------------------------------------------------------
`timescale 1ns/1ps

module pmc_top
    import power_pkg::*;
#(
    // PMC firmware reset vector. Must match the ORIGIN of AON_SRAM in
    // fw/pmc/link.ld. Override in integration only if the linker script is
    // changed in lockstep.
    parameter logic [31:0] PMC_BOOT_ADDR = 32'h1005_0000
) (
    input  logic        clk_aon,                // AON clock (32 kHz ref divided to PMC PLL)
    input  logic        clk_sample,             // 200 MHz sample reference
    input  logic        rst_n,

    // S-mode mailbox interface (AHB-Lite-equivalent slave to SoC fabric)
    input  logic                          mbox_valid_i,
    input  logic                          mbox_write_i,
    input  logic [PMC_MBOX_AW-1:0]        mbox_addr_i,
    input  logic [PMC_MBOX_DW-1:0]        mbox_wdata_i,
    output logic [PMC_MBOX_DW-1:0]        mbox_rdata_o,
    output logic                          mbox_ready_o,

    // PMIC SPMI v2 master pins (open-drain, requires foundry IO cell)
    output logic        spmi_sclk_o,
    inout  wire         spmi_sdata_io,
    output logic        spmi_enable_o,

    // I2C-FM-plus fallback
    inout  wire         i2c_scl_io,
    inout  wire         i2c_sda_io,

    // Droop / AVFS telemetry inputs (per DVFS rail)
    input  logic [DVFS_RAIL_COUNT-1:0]                droop_alarm_i,
    input  logic [DVFS_RAIL_COUNT-1:0][31:0]          droop_event_count_i,
    input  logic [DVFS_RAIL_COUNT-1:0][DVFS_CODE_WIDTH-1:0] avfs_target_code_i,
    input  logic [DVFS_RAIL_COUNT-1:0][31:0]          avfs_raise_count_i,
    input  logic [DVFS_RAIL_COUNT-1:0][31:0]          avfs_lower_count_i,
    input  logic [DVFS_RAIL_COUNT-1:0]                avfs_fault_i,

    // Outbound DVFS request per rail
    output logic [DVFS_RAIL_COUNT-1:0][DVFS_CODE_WIDTH-1:0] dvfs_request_code_o,
    output logic [DVFS_RAIL_COUNT-1:0]                dvfs_request_valid_o,

    // PMIC enable lines (one per off-chip regulator; pin at integration)
    output logic [15:0] pmic_enable_o,

    // Wake / IRQ to AP
    output logic        wake_irq_o,
    output logic        thermal_irq_o
);

    // -------------------------------------------------------------------------
    // Mailbox register bank
    // -------------------------------------------------------------------------
    logic [PMC_MBOX_DW-1:0] reg_status_q;
    logic [PMC_MBOX_DW-1:0] reg_ctrl_q;
    logic [PMC_MBOX_DW-1:0] reg_dvfs_q [DVFS_RAIL_COUNT];

    // RPMI v1.0 mailbox TX/RX scratch. Until the AON Ibex firmware is bound,
    // the wrapper exposes a simple TX_HEAD/TX_DATA/RX_HEAD/RX_DATA register
    // bank. The Ibex firmware drains TX side and posts to RX side. For
    // pre-firmware bring-up cocotb tests, TX_DATA loopbacks to RX_DATA on
    // the next clk_aon so a host-side RPMI envelope writes can be observed.
    logic [PMC_MBOX_DW-1:0] reg_tx_head_q;
    logic [PMC_MBOX_DW-1:0] reg_tx_data_q;
    logic [PMC_MBOX_DW-1:0] reg_rx_head_q;
    logic [PMC_MBOX_DW-1:0] reg_rx_data_q;

    // Aggregate droop telemetry. `droop_total_q` is the present-cycle sum
    // across all rails (combinational behavior across sample periods).
    // `droop_sticky_q` accumulates the *increase* in droop_total_q since the
    // last clk_aon mailbox W1C clear, so firmware can drain events without
    // races against the per-rail counters.
    logic [31:0] droop_total_q;
    logic [31:0] droop_total_prev_q;
    logic [31:0] droop_sticky_q;
    // Cross-domain pulse: the AON mailbox decode produces a W1C mask, which is
    // sampled into the sample-clock domain through the simple two-flop synch
    // pattern shown in droop_sensor.sv for the same direction.
    logic [31:0] droop_sticky_w1c_mask_aon;
    logic [31:0] droop_sticky_w1c_mask_sample;
    logic [31:0] droop_sticky_w1c_mask_sample_q;
    always_ff @(posedge clk_sample or negedge rst_n) begin
        if (!rst_n) begin
            droop_sticky_w1c_mask_sample_q <= 32'h0;
            droop_sticky_w1c_mask_sample   <= 32'h0;
        end else begin
            droop_sticky_w1c_mask_sample_q <= droop_sticky_w1c_mask_aon;
            droop_sticky_w1c_mask_sample   <= droop_sticky_w1c_mask_sample_q;
        end
    end

    always_ff @(posedge clk_sample or negedge rst_n) begin
        if (!rst_n) begin
            droop_total_q      <= 32'h0;
            droop_total_prev_q <= 32'h0;
            droop_sticky_q     <= 32'h0;
        end else begin
            droop_total_q <= droop_event_count_i[0]
                          + droop_event_count_i[1]
                          + droop_event_count_i[2]
                          + droop_event_count_i[3]
                          + droop_event_count_i[4]
                          + droop_event_count_i[5];
            droop_total_prev_q <= droop_total_q;
            // Accumulate the rising delta only; per-rail counters are
            // monotone-increasing telemetry, so a negative delta means a
            // wraparound or an upstream reset and is ignored.
            if (droop_total_q > droop_total_prev_q) begin
                droop_sticky_q <= (droop_sticky_q & ~droop_sticky_w1c_mask_sample)
                                + (droop_total_q - droop_total_prev_q);
            end else begin
                droop_sticky_q <= droop_sticky_q & ~droop_sticky_w1c_mask_sample;
            end
        end
    end

    // Aggregate AVFS fault
    logic any_avfs_fault;
    assign any_avfs_fault = |avfs_fault_i;

    // Status register composition
    always_ff @(posedge clk_aon or negedge rst_n) begin
        if (!rst_n) begin
            reg_status_q <= '0;
        end else begin
            reg_status_q                                <= '0;
            reg_status_q[PMC_STATUS_BUSY]               <= 1'b0;
            reg_status_q[PMC_STATUS_FAULT]              <= any_avfs_fault;
            reg_status_q[PMC_STATUS_TX_FULL]            <= 1'b0;
            reg_status_q[PMC_STATUS_RX_VALID]           <= 1'b0;
        end
    end

    // Mailbox read/write decode. Read path is registered to clk_aon.
    logic [PMC_MBOX_DW-1:0] rdata_q;
    always_ff @(posedge clk_aon or negedge rst_n) begin
        if (!rst_n) begin
            rdata_q                     <= '0;
            reg_ctrl_q                  <= '0;
            reg_tx_head_q               <= '0;
            reg_tx_data_q               <= '0;
            reg_rx_head_q               <= '0;
            reg_rx_data_q               <= '0;
            droop_sticky_w1c_mask_aon   <= '0;
            for (int i = 0; i < DVFS_RAIL_COUNT; i++) begin
                reg_dvfs_q[i] <= '0;
            end
        end else begin
            // W1C mask is a single-cycle pulse; clear unless the host writes
            // it again on this clk_aon edge.
            droop_sticky_w1c_mask_aon <= '0;
            if (mbox_valid_i) begin
                if (mbox_write_i) begin
                    case (mbox_addr_i)
                        PMC_REG_CTRL:         reg_ctrl_q    <= mbox_wdata_i;
                        PMC_REG_DROOP_STICKY: droop_sticky_w1c_mask_aon <= mbox_wdata_i;
                        PMC_REG_MBOX_TX_HEAD: reg_tx_head_q <= mbox_wdata_i;
                        PMC_REG_MBOX_TX_DATA: begin
                            // Host posts a 32b word into TX; Ibex (or the
                            // loopback path below) consumes it and produces an
                            // RX_DATA word. Until the Ibex is bound, TX_DATA
                            // loops back into RX_DATA on the same cycle so a
                            // cocotb harness can verify the mailbox surface.
                            reg_tx_data_q <= mbox_wdata_i;
                            reg_rx_data_q <= mbox_wdata_i;
                            reg_rx_head_q <= reg_tx_head_q;
                        end
                        PMC_REG_MBOX_RX_HEAD: reg_rx_head_q <= mbox_wdata_i;
                        default: begin
                            for (int i = 0; i < DVFS_RAIL_COUNT; i++) begin
                                if (mbox_addr_i == (PMC_REG_DVFS_BASE +
                                                    PMC_MBOX_AW'(i * 4))) begin
                                    reg_dvfs_q[i] <= mbox_wdata_i;
                                end
                            end
                        end
                    endcase
                end else begin
                    case (mbox_addr_i)
                        PMC_REG_STATUS:       rdata_q <= reg_status_q;
                        PMC_REG_CTRL:         rdata_q <= reg_ctrl_q;
                        PMC_REG_DROOP_COUNT:  rdata_q <= droop_total_q;
                        PMC_REG_AVFS_STATUS:  rdata_q <= {28'h0, avfs_fault_i};
                        PMC_REG_DROOP_STICKY: rdata_q <= droop_sticky_q;
                        PMC_REG_MBOX_TX_HEAD: rdata_q <= reg_tx_head_q;
                        PMC_REG_MBOX_TX_DATA: rdata_q <= reg_tx_data_q;
                        PMC_REG_MBOX_RX_HEAD: rdata_q <= reg_rx_head_q;
                        PMC_REG_MBOX_RX_DATA: rdata_q <= reg_rx_data_q;
                        default: begin
                            rdata_q <= '0;
                            for (int i = 0; i < DVFS_RAIL_COUNT; i++) begin
                                if (mbox_addr_i == (PMC_REG_DVFS_BASE +
                                                    PMC_MBOX_AW'(i * 4))) begin
                                    rdata_q <= reg_dvfs_q[i];
                                end
                            end
                        end
                    endcase
                end
            end
        end
    end

    assign mbox_rdata_o = rdata_q;
    assign mbox_ready_o = mbox_valid_i;

    // DVFS request fan-out from mailbox writes
    for (genvar g = 0; g < DVFS_RAIL_COUNT; g++) begin : gen_dvfs_out
        assign dvfs_request_code_o[g]  = reg_dvfs_q[g][DVFS_CODE_WIDTH-1:0];
        assign dvfs_request_valid_o[g] = reg_dvfs_q[g][31];
    end

    // -------------------------------------------------------------------------
    // PMIC interfaces — tied off here; real drivers run on Ibex firmware.
    // -------------------------------------------------------------------------
    assign spmi_sclk_o   = 1'b0;
    assign spmi_enable_o = reg_ctrl_q[0];
    assign pmic_enable_o = reg_ctrl_q[31:16];

    // Open-drain inout stubs: PMC firmware drives via bit-bang / SPMI master.
    /* verilator lint_off UNUSED */
    wire _unused_io = spmi_sdata_io ^ i2c_scl_io ^ i2c_sda_io;
    /* verilator lint_on UNUSED */

    // Wake / thermal IRQ outputs
    assign wake_irq_o    = reg_ctrl_q[1];
    assign thermal_irq_o = any_avfs_fault;

    // -------------------------------------------------------------------------
    // Ibex management core (lowRISC ibex_top, Apache-2.0). Pinned via
    // external/ibex/pin-manifest.json. Resolved only when the integrator has
    // pulled the source and defined PMC_INSTANTIATE_IBEX. Until then the
    // mailbox + telemetry surface above is the testable contract.
    //
    // The minimum config (RV32IMC, no I$, no branch predictor, no writeback
    // stage) is declared in external/ibex/pin-manifest.json::config_target.
    // Wrapper pin-out follows lowRISC ibex_top from
    // external/ibex/ibex/rtl/ibex_top.sv at the pinned commit.
    // -------------------------------------------------------------------------
`ifdef PMC_INSTANTIATE_IBEX
    // -------------------------------------------------------------------------
    // AON SRAM (16 KiB) at PMC_BOOT_ADDR — backs the firmware text/data/bss
    // sections from fw/pmc/link.ld. The cocotb harness preloads this memory
    // with fw/pmc/build/pmc.elf via $readmemh on `+PMC_AON_SRAM_HEX=<path>`,
    // matching the contract recorded in docs/evidence/power/pmc-fw-build-
    // evidence.yaml. Verilator initialises unloaded words to 0 (NOP at reset).
    // -------------------------------------------------------------------------
    localparam int unsigned AON_SRAM_BYTES = 16 * 1024;
    localparam int unsigned AON_SRAM_WORDS = AON_SRAM_BYTES / 4;
    localparam int unsigned AON_SRAM_AW    = $clog2(AON_SRAM_WORDS);

    logic [31:0] aon_sram_q [AON_SRAM_WORDS];

    initial begin : pmc_aon_sram_preload
        string aon_hex_path;
        for (int unsigned w = 0; w < AON_SRAM_WORDS; w++) begin
            aon_sram_q[w] = 32'h0000_0013;  // RV32 NOP (addi x0,x0,0)
        end
        if ($value$plusargs("PMC_AON_SRAM_HEX=%s", aon_hex_path)) begin
            $display("[pmc_top] preloading AON SRAM from %s", aon_hex_path);
            $readmemh(aon_hex_path, aon_sram_q);
        end
    end

    logic        ibex_instr_req;
    logic        ibex_instr_gnt;
    logic        ibex_instr_rvalid;
    logic [31:0] ibex_instr_addr;
    logic [31:0] ibex_instr_rdata;
    logic        ibex_instr_err;
    logic        ibex_data_req;
    logic        ibex_data_gnt;
    logic        ibex_data_rvalid;
    logic        ibex_data_we;
    logic [3:0]  ibex_data_be;
    logic [31:0] ibex_data_addr;
    logic [31:0] ibex_data_wdata;
    logic [31:0] ibex_data_rdata;
    logic        ibex_data_err;
    logic        ibex_core_sleep;

    // Word-aligned offsets inside the AON SRAM aperture (PMC_BOOT_ADDR
    // .. PMC_BOOT_ADDR + AON_SRAM_BYTES). Anything outside the aperture
    // raises an err to the Ibex bus and the firmware will trap.
    logic [AON_SRAM_AW-1:0] instr_word_idx;
    logic [AON_SRAM_AW-1:0] data_word_idx;
    logic                   instr_in_aon;
    logic                   data_in_aon;

    assign instr_in_aon   = (ibex_instr_addr[31:14] == PMC_BOOT_ADDR[31:14]);
    assign data_in_aon    = (ibex_data_addr [31:14] == PMC_BOOT_ADDR[31:14]);
    assign instr_word_idx = ibex_instr_addr[AON_SRAM_AW+2-1:2];
    assign data_word_idx  = ibex_data_addr [AON_SRAM_AW+2-1:2];

    // Single-cycle response. The AON SRAM model accepts both instr+data
    // requests simultaneously; the real macro will be dual-port. For the
    // cocotb smoke this is a sufficient functional model.
    always_ff @(posedge clk_aon or negedge rst_n) begin
        if (!rst_n) begin
            ibex_instr_gnt    <= 1'b0;
            ibex_instr_rvalid <= 1'b0;
            ibex_instr_rdata  <= 32'h0;
            ibex_instr_err    <= 1'b0;
            ibex_data_gnt     <= 1'b0;
            ibex_data_rvalid  <= 1'b0;
            ibex_data_rdata   <= 32'h0;
            ibex_data_err     <= 1'b0;
        end else begin
            ibex_instr_gnt    <= ibex_instr_req;
            ibex_instr_rvalid <= ibex_instr_req;
            ibex_instr_err    <= ibex_instr_req && !instr_in_aon;
            if (ibex_instr_req && instr_in_aon) begin
                ibex_instr_rdata <= aon_sram_q[instr_word_idx];
            end

            ibex_data_gnt    <= ibex_data_req;
            ibex_data_rvalid <= ibex_data_req;
            ibex_data_err    <= ibex_data_req && !data_in_aon;
            if (ibex_data_req && data_in_aon) begin
                if (ibex_data_we) begin
                    if (ibex_data_be[0]) aon_sram_q[data_word_idx][ 7: 0] <= ibex_data_wdata[ 7: 0];
                    if (ibex_data_be[1]) aon_sram_q[data_word_idx][15: 8] <= ibex_data_wdata[15: 8];
                    if (ibex_data_be[2]) aon_sram_q[data_word_idx][23:16] <= ibex_data_wdata[23:16];
                    if (ibex_data_be[3]) aon_sram_q[data_word_idx][31:24] <= ibex_data_wdata[31:24];
                end
                ibex_data_rdata <= aon_sram_q[data_word_idx];
            end
        end
    end

    ibex_top #(
        .RV32M               (ibex_pkg::RV32MSlow),
        .RV32E               (1'b0),
        .BranchTargetALU     (1'b0),
        .WritebackStage      (1'b0),
        .ICache              (1'b0),
        .ICacheECC           (1'b0),
        .BranchPredictor     (1'b0),
        .DbgTriggerEn        (1'b1),
        .DbgHwBreakNum       (4),
        .SecureIbex          (1'b0)
    ) u_ibex_pmc (
        .clk_i                     (clk_aon),
        .rst_ni                    (rst_n),
        .test_en_i                 (1'b0),
        .ram_cfg_icache_tag_i      (prim_ram_1p_pkg::RAM_1P_CFG_DEFAULT),
        .ram_cfg_rsp_icache_tag_o  (),
        .ram_cfg_icache_data_i     (prim_ram_1p_pkg::RAM_1P_CFG_DEFAULT),
        .ram_cfg_rsp_icache_data_o (),
        .hart_id_i                 (32'h0),
        .boot_addr_i               (PMC_BOOT_ADDR),

        .instr_req_o               (ibex_instr_req),
        .instr_gnt_i               (ibex_instr_gnt),
        .instr_rvalid_i            (ibex_instr_rvalid),
        .instr_addr_o              (ibex_instr_addr),
        .instr_rdata_i             (ibex_instr_rdata),
        .instr_rdata_intg_i        (7'h0),
        .instr_err_i               (ibex_instr_err),

        .data_req_o                (ibex_data_req),
        .data_gnt_i                (ibex_data_gnt),
        .data_rvalid_i             (ibex_data_rvalid),
        .data_we_o                 (ibex_data_we),
        .data_be_o                 (ibex_data_be),
        .data_addr_o               (ibex_data_addr),
        .data_wdata_o              (ibex_data_wdata),
        .data_wdata_intg_o         (),
        .data_rdata_i              (ibex_data_rdata),
        .data_rdata_intg_i         (7'h0),
        .data_err_i                (ibex_data_err),

        .irq_software_i            (1'b0),
        .irq_timer_i               (1'b0),
        .irq_external_i            (any_avfs_fault),
        .irq_fast_i                (15'h0),
        .irq_nm_i                  (1'b0),

        .scramble_key_valid_i      (1'b0),
        .scramble_key_i            ('0),
        .scramble_nonce_i          ('0),
        .scramble_req_o            (),

        .debug_req_i               (1'b0),
        .crash_dump_o              (),
        .double_fault_seen_o       (),

        .fetch_enable_i            (ibex_pkg::IbexMuBiOn),
        .alert_minor_o             (),
        .alert_major_internal_o    (),
        .alert_major_bus_o         (),
        .core_sleep_o              (ibex_core_sleep),
        .scan_rst_ni               (rst_n),

        .lockstep_cmp_en_o         (),
        .data_req_shadow_o         (),
        .data_we_shadow_o          (),
        .data_be_shadow_o          (),
        .data_addr_shadow_o        (),
        .data_wdata_shadow_o       (),
        .data_wdata_intg_shadow_o  (),
        .instr_req_shadow_o        (),
        .instr_addr_shadow_o       ()
    );

    /* verilator lint_off UNUSED */
    wire _unused_ibex = ibex_core_sleep;
    /* verilator lint_on UNUSED */
`endif

    // Suppress unused on clk_sample / avfs_target_code_i / counters — exposed
    // via additional mailbox offsets in fw/pmc telemetry aggregator.
    /* verilator lint_off UNUSED */
    /* verilator lint_off UNUSEDSIGNAL */
    wire _unused_sample = clk_sample;
    wire _unused_avfs_t = |avfs_target_code_i;
    wire _unused_avfs_r = |avfs_raise_count_i;
    wire _unused_avfs_l = |avfs_lower_count_i;
    wire _unused_droop  = |droop_alarm_i;
    /* verilator lint_on UNUSEDSIGNAL */
    /* verilator lint_on UNUSED */

endmodule : pmc_top
