`timescale 1ns/1ps

// e1_cva6_unit_tb
//
// Cocotb harness that instantiates the standalone CVA6 wrapper
// (`rtl/cpu/e1_cva6_wrapper.sv`) under `+define+E1_HAVE_CVA6` and ties
// its flat AXI4 master port to a minimal in-TB memory model that
// serves a small program from the boot address downward and accepts
// scratch writes/reads to a DRAM-class region.
//
// This testbench exists so the two cocotb cases below can drive the
// real CVA6 v5.3.0 RTL:
//
//   - test_cva6_executes_bootrom_program.py
//       Releases reset on CVA6 with a 4-instruction program at the boot
//       address; checks that the decoded RVFI retirement stream commits
//       the expected instruction prefix.
//
//   - test_cva6_dram_read_write.py
//       Runs a small program that writes a constant to DRAM_BASE and
//       reads it back; asserts the AXI4 traffic matches the expected
//       address + data pattern.
//
// The TB is intentionally minimal: it only exposes the signals the two
// tests need (clk, rst_n, IRQ inputs, debug PC, RVFI retirement fields,
// and AXI4 traffic counters).  The full CVA6 source tree lives under
// `external/cva6/cva6`
// and is pinned to v5.3.0 (commit 2ef1c1b); the cocotb Makefile is
// responsible for adding the CVA6 Flist sources to the compile.

module e1_cva6_unit_tb (
    input  logic        clk,
    input  logic        rst_n,

    // IRQ injection (default 0 — caller pulses for IRQ tests)
    input  logic [1:0]  irq_i,
    input  logic        ipi_i,
    input  logic        time_irq_i,
    input  logic        debug_req_i,

    // Observability outputs surfaced to cocotb
    output logic [63:0] dbg_pc_o,
    output logic        dbg_valid_o,
    // Decoded RVFI retirement surface from e1_cva6_wrapper.sv.  The TB
    // keeps the public cocotb port list stable even when compiled without
    // E1_RVFI, but Makefile.cva6 defines E1_RVFI for this evidence path.
    output logic        rvfi_valid_o,
    output logic [63:0] rvfi_order_o,
    output logic [31:0] rvfi_insn_o,
    output logic        rvfi_trap_o,
    output logic [63:0] rvfi_pc_rdata_o,
    output logic [31:0] rvfi_retire_count_o,
    output logic [127:0] rvfi_first4_insn_o,
    output logic [255:0] rvfi_first4_pc_o,
    output logic [3:0]   rvfi_first4_trap_o,
    // AXI4 traffic counters — increment each handshake so the test can
    // confirm CVA6 actually issues fetch / load / store transactions.
    output logic [31:0] ar_xfer_count_o,
    output logic [31:0] aw_xfer_count_o,
    output logic [31:0] w_xfer_count_o,
    output logic [31:0] r_xfer_count_o,
    output logic [31:0] b_xfer_count_o,
    // Mirrors of the first ROM/DRAM words so the test can verify cocotb's
    // unpacked-array writes landed (Verilator's GPI table does not always
    // surface every element of `logic [63:0] boot_rom [...]`).
    output logic [63:0] boot_rom_word0_o,
    output logic [63:0] boot_rom_word1_o,
    output logic [63:0] boot_rom_word2_o,
    output logic [63:0] dram_mem_word0_o
);

    // CVA6 wrapper-side AXI4 nets at the cv64a6_imafdc_sv39 native
    // geometry: 4-bit ID, 64-bit address, 64-bit data.
    localparam int unsigned AXI_ID_W   = 4;
    localparam int unsigned AXI_ADDR_W = 64;
    localparam int unsigned AXI_DATA_W = 64;
    localparam int unsigned AXI_USER_W = 1;
    // Boot vector — boot ROM lives in CVA6's second default execute region
    // (`ExecuteRegionAddrBase[1] = 0x1_0000`, length `0x10000`).  The first
    // execute region covers only [0, 0x1000) so the historical 0x1000 value
    // sat just outside any executable PMA window and CVA6 raised
    // INSTR_ACCESS_FAULT before it ever issued a fetch.  See
    // `external/cva6/cva6/core/include/cv64a6_imafdc_sv39_config_pkg.sv`
    // `ExecuteRegionAddrBase` / `ExecuteRegionLength`.
    localparam logic [63:0] BOOT_ADDR  = 64'h0000_0000_0001_0000;

    // Wrapper AXI4 master signals
    logic [AXI_ID_W-1:0]         w_ar_id;
    logic [AXI_ADDR_W-1:0]       w_ar_addr;
    logic [7:0]                  w_ar_len;
    logic [2:0]                  w_ar_size;
    logic [1:0]                  w_ar_burst;
    logic                        w_ar_lock;
    logic [3:0]                  w_ar_cache;
    logic [2:0]                  w_ar_prot;
    logic [3:0]                  w_ar_qos;
    logic [3:0]                  w_ar_region;
    logic [AXI_USER_W-1:0]       w_ar_user;
    logic                        w_ar_valid;
    logic                        w_ar_ready;
    logic [AXI_ID_W-1:0]         w_r_id;
    logic [AXI_DATA_W-1:0]       w_r_data;
    logic [1:0]                  w_r_resp;
    logic                        w_r_last;
    logic [AXI_USER_W-1:0]       w_r_user;
    logic                        w_r_valid;
    logic                        w_r_ready;
    logic [AXI_ID_W-1:0]         w_aw_id;
    logic [AXI_ADDR_W-1:0]       w_aw_addr;
    logic [7:0]                  w_aw_len;
    logic [2:0]                  w_aw_size;
    logic [1:0]                  w_aw_burst;
    logic                        w_aw_lock;
    logic [3:0]                  w_aw_cache;
    logic [2:0]                  w_aw_prot;
    logic [3:0]                  w_aw_qos;
    logic [3:0]                  w_aw_region;
    logic [5:0]                  w_aw_atop;
    logic [AXI_USER_W-1:0]       w_aw_user;
    logic                        w_aw_valid;
    logic                        w_aw_ready;
    logic [AXI_DATA_W-1:0]       w_w_data;
    logic [(AXI_DATA_W/8)-1:0]   w_w_strb;
    logic                        w_w_last;
    logic [AXI_USER_W-1:0]       w_w_user;
    logic                        w_w_valid;
    logic                        w_w_ready;
    logic [AXI_ID_W-1:0]         w_b_id;
    logic [1:0]                  w_b_resp;
    logic [AXI_USER_W-1:0]       w_b_user;
    logic                        w_b_valid;
    logic                        w_b_ready;

`ifdef E1_RVFI
    logic [`E1_RVFI_NRET-1:0]        w_rvfi_valid;
    logic [`E1_RVFI_NRET-1:0][63:0] w_rvfi_order;
    logic [`E1_RVFI_NRET-1:0][31:0] w_rvfi_insn;
    logic [`E1_RVFI_NRET-1:0]        w_rvfi_trap;
    logic [`E1_RVFI_NRET-1:0][1:0]  w_rvfi_mode_unused;
    logic [`E1_RVFI_NRET-1:0][4:0]  w_rvfi_rd_addr_unused;
    logic [`E1_RVFI_NRET-1:0][63:0] w_rvfi_rd_wdata_unused;
    logic [`E1_RVFI_NRET-1:0][63:0] w_rvfi_pc_rdata;
`endif

    // ── CVA6 wrapper instance ─────────────────────────────────────────
    e1_cpu_subsystem #(
        .BOOT_ADDR  (BOOT_ADDR),
        .AXI_ID_W   (AXI_ID_W),
        .AXI_ADDR_W (AXI_ADDR_W),
        .AXI_DATA_W (AXI_DATA_W),
        .AXI_USER_W (AXI_USER_W)
    ) u_cva6 (
        .clk_i         (clk),
        .rst_ni        (rst_n),
        .irq_i         (irq_i),
        .ipi_i         (ipi_i),
        .time_irq_i    (time_irq_i),
        .debug_req_i   (debug_req_i),
        .axi_ar_id     (w_ar_id),
        .axi_ar_addr   (w_ar_addr),
        .axi_ar_len    (w_ar_len),
        .axi_ar_size   (w_ar_size),
        .axi_ar_burst  (w_ar_burst),
        .axi_ar_lock   (w_ar_lock),
        .axi_ar_cache  (w_ar_cache),
        .axi_ar_prot   (w_ar_prot),
        .axi_ar_qos    (w_ar_qos),
        .axi_ar_region (w_ar_region),
        .axi_ar_user   (w_ar_user),
        .axi_ar_valid  (w_ar_valid),
        .axi_ar_ready  (w_ar_ready),
        .axi_r_id      (w_r_id),
        .axi_r_data    (w_r_data),
        .axi_r_resp    (w_r_resp),
        .axi_r_last    (w_r_last),
        .axi_r_user    (w_r_user),
        .axi_r_valid   (w_r_valid),
        .axi_r_ready   (w_r_ready),
        .axi_aw_id     (w_aw_id),
        .axi_aw_addr   (w_aw_addr),
        .axi_aw_len    (w_aw_len),
        .axi_aw_size   (w_aw_size),
        .axi_aw_burst  (w_aw_burst),
        .axi_aw_lock   (w_aw_lock),
        .axi_aw_cache  (w_aw_cache),
        .axi_aw_prot   (w_aw_prot),
        .axi_aw_qos    (w_aw_qos),
        .axi_aw_region (w_aw_region),
        .axi_aw_atop   (w_aw_atop),
        .axi_aw_user   (w_aw_user),
        .axi_aw_valid  (w_aw_valid),
        .axi_aw_ready  (w_aw_ready),
        .axi_w_data    (w_w_data),
        .axi_w_strb    (w_w_strb),
        .axi_w_last    (w_w_last),
        .axi_w_user    (w_w_user),
        .axi_w_valid   (w_w_valid),
        .axi_w_ready   (w_w_ready),
        .axi_b_id      (w_b_id),
        .axi_b_resp    (w_b_resp),
        .axi_b_user    (w_b_user),
        .axi_b_valid   (w_b_valid),
        .axi_b_ready   (w_b_ready),
        .hart_id_i     (64'h0),
        .dbg_pc_o      (dbg_pc_o),
        .dbg_valid_o   (dbg_valid_o)
`ifdef E1_RVFI
        ,
        .rvfi_valid_o    (w_rvfi_valid),
        .rvfi_order_o    (w_rvfi_order),
        .rvfi_insn_o     (w_rvfi_insn),
        .rvfi_trap_o     (w_rvfi_trap),
        .rvfi_mode_o     (w_rvfi_mode_unused),
        .rvfi_rd_addr_o  (w_rvfi_rd_addr_unused),
        .rvfi_rd_wdata_o (w_rvfi_rd_wdata_unused),
        .rvfi_pc_rdata_o (w_rvfi_pc_rdata)
`endif
    );

`ifdef E1_RVFI
    assign rvfi_valid_o    = |w_rvfi_valid;
    assign rvfi_order_o    = w_rvfi_order[0];
    assign rvfi_insn_o     = w_rvfi_insn[0];
    assign rvfi_trap_o     = w_rvfi_trap[0];
    assign rvfi_pc_rdata_o = w_rvfi_pc_rdata[0];
`else
    assign rvfi_valid_o    = 1'b0;
    assign rvfi_order_o    = 64'h0;
    assign rvfi_insn_o     = 32'h0;
    assign rvfi_trap_o     = 1'b0;
    assign rvfi_pc_rdata_o = 64'h0;
`endif

    // ── Minimal AXI4 memory model ─────────────────────────────────────
    // Two regions:
    //   - boot ROM  : 0x0000_0000 .. 0x0001_0000 (64 KiB), preloaded by
    //                 cocotb via `dut.u_cva6_unit_tb.boot_rom.write_word()`
    //                 (force on the array signal).
    //   - DRAM      : 0x8000_0000 .. 0x8000_4000 (16 KiB), backs RW.
    // Both regions are word-addressable 64-bit storage; reads & writes
    // are accepted on the same beat as the request handshake. No burst
    // pipelining — CVA6 issues short bursts in this config which fit in
    // a single response with last=1 for len=0.
    localparam int unsigned ROM_WORDS  = 8192;  // 64 KiB / 8 B
    localparam int unsigned DRAM_WORDS = 2048;  // 16 KiB / 8 B
    // ROM_BASE must match BOOT_ADDR (CVA6's executable PMA region 1 starts
    // at 0x1_0000).  DRAM_BASE matches CVA6's cacheable + executable region
    // at 0x8000_0000.
    localparam logic [63:0] ROM_BASE   = 64'h0000_0000_0001_0000;
    localparam logic [63:0] DRAM_BASE  = 64'h0000_0000_8000_0000;

    logic [63:0] boot_rom  [0:ROM_WORDS-1];
    logic [63:0] dram_mem  [0:DRAM_WORDS-1];

    // Initialise to 0, then preload the boot ROM from a $readmemh-friendly
    // hex file.  Cocotb writes the program payload into the file before
    // simulation starts; the TB picks the path up from the BOOT_ROM_HEX
    // plusarg (default "boot_rom.hex" relative to the simulator cwd).
    // This indirection avoids the Verilator+cocotb-GPI limitation where
    // `dut.boot_rom[i].value = X` silently no-ops because Verilator's GPI
    // does not register a writable handle for every element of an
    // unpacked logic array; the cocotb test additionally enforces a
    // sanity check on the flat-port mirrors (`boot_rom_word0_o` ..) so a
    // missing/empty hex file fails the test loudly.
    initial begin : init_mem
        string rom_path;
        for (int i = 0; i < ROM_WORDS;  i++) boot_rom[i] = 64'h0;
        for (int i = 0; i < DRAM_WORDS; i++) dram_mem[i] = 64'h0;
        if (!$value$plusargs("BOOT_ROM_HEX=%s", rom_path)) begin
            rom_path = "boot_rom.hex";
        end
        $readmemh(rom_path, boot_rom);
    end

    // ── Cocotb-observable mirrors of the first ROM/DRAM words ──────────
    // The simulator does not surface every element of an unpacked array
    // in its GPI signal handle table or the VCD by default.  These mirror
    // nets re-export the first three ROM words (the cocotb tests preload
    // a 4-instruction or 6-instruction program here) so the tests can
    // assert the preload actually landed before releasing reset.
    assign boot_rom_word0_o = boot_rom[0];
    assign boot_rom_word1_o = boot_rom[1];
    assign boot_rom_word2_o = boot_rom[2];
    assign dram_mem_word0_o = dram_mem[0];

    // Optional VCD trace gated by +trace plusarg.
    // Simulator must enable trace support for $dumpfile/$dumpvars to emit.
    initial begin
        if ($test$plusargs("trace")) begin
            $dumpfile("e1_cva6_unit_tb.vcd");
            $dumpvars(0, e1_cva6_unit_tb);
        end
    end

    // Region select helpers
    function automatic logic is_rom_addr(input logic [63:0] addr);
        return (addr >= ROM_BASE) && (addr < (ROM_BASE + ROM_WORDS*8));
    endfunction
    function automatic logic is_dram_addr(input logic [63:0] addr);
        return (addr >= DRAM_BASE) && (addr < (DRAM_BASE + DRAM_WORDS*8));
    endfunction

    // Outstanding read FSM (single-beat at a time)
    typedef enum logic [1:0] {R_IDLE, R_RESPOND} read_state_t;
    read_state_t   r_state;
    logic [AXI_ID_W-1:0]   r_pending_id;
    logic [AXI_ADDR_W-1:0] r_pending_addr;
    logic [7:0]            r_pending_beats; // remaining beats after current
    logic [7:0]            r_beat_idx;

    // Outstanding write FSM
    typedef enum logic [1:0] {W_IDLE, W_DATA, W_RESP} write_state_t;
    write_state_t  w_state;
    logic [AXI_ID_W-1:0]   w_pending_id;
    logic [AXI_ADDR_W-1:0] w_pending_addr;
    logic [7:0]            w_pending_beats;
    logic [7:0]            w_beat_idx;

    // Read channel
    assign w_ar_ready = (r_state == R_IDLE);
    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            r_state         <= R_IDLE;
            r_pending_id    <= '0;
            r_pending_addr  <= '0;
            r_pending_beats <= '0;
            r_beat_idx      <= '0;
            w_r_valid       <= 1'b0;
            w_r_id          <= '0;
            w_r_data        <= '0;
            w_r_resp        <= 2'b00;
            w_r_last        <= 1'b0;
            w_r_user        <= '0;
        end else begin
            unique case (r_state)
                R_IDLE: begin
                    w_r_valid <= 1'b0;
                    w_r_last  <= 1'b0;
                    if (w_ar_valid && w_ar_ready) begin
                        r_state         <= R_RESPOND;
                        r_pending_id    <= w_ar_id;
                        r_pending_addr  <= w_ar_addr;
                        r_pending_beats <= w_ar_len;
                        r_beat_idx      <= 8'd0;
                    end
                end
                R_RESPOND: begin
                    w_r_valid <= 1'b1;
                    w_r_id    <= r_pending_id;
                    if (is_rom_addr(r_pending_addr + (r_beat_idx * 8))) begin
                        w_r_data <= boot_rom[((r_pending_addr - ROM_BASE) >> 3) + r_beat_idx];
                        w_r_resp <= 2'b00;
                    end else if (is_dram_addr(r_pending_addr + (r_beat_idx * 8))) begin
                        w_r_data <= dram_mem[((r_pending_addr - DRAM_BASE) >> 3) + r_beat_idx];
                        w_r_resp <= 2'b00;
                    end else begin
                        w_r_data <= 64'h0;
                        w_r_resp <= 2'b11; // DECERR for unmapped region
                    end
                    w_r_last  <= (r_beat_idx == r_pending_beats);
                    if (w_r_valid && w_r_ready) begin
                        if (r_beat_idx == r_pending_beats) begin
                            r_state   <= R_IDLE;
                            w_r_valid <= 1'b0;
                            w_r_last  <= 1'b0;
                        end else begin
                            r_beat_idx <= r_beat_idx + 8'd1;
                        end
                    end
                end
                default: r_state <= R_IDLE;
            endcase
        end
    end

    // Write channel
    assign w_aw_ready = (w_state == W_IDLE);
    assign w_w_ready  = (w_state == W_DATA);
    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            w_state         <= W_IDLE;
            w_pending_id    <= '0;
            w_pending_addr  <= '0;
            w_pending_beats <= '0;
            w_beat_idx      <= '0;
            w_b_valid       <= 1'b0;
            w_b_id          <= '0;
            w_b_resp        <= 2'b00;
            w_b_user        <= '0;
        end else begin
            unique case (w_state)
                W_IDLE: begin
                    w_b_valid <= 1'b0;
                    if (w_aw_valid && w_aw_ready) begin
                        w_state         <= W_DATA;
                        w_pending_id    <= w_aw_id;
                        w_pending_addr  <= w_aw_addr;
                        w_pending_beats <= w_aw_len;
                        w_beat_idx      <= 8'd0;
                    end
                end
                W_DATA: begin
                    if (w_w_valid && w_w_ready) begin
                        if (is_dram_addr(w_pending_addr + (w_beat_idx * 8))) begin
                            dram_mem[((w_pending_addr - DRAM_BASE) >> 3) + w_beat_idx] <= w_w_data;
                        end
                        // (ROM writes are silently dropped; tests should
                        // not target the ROM with writes.)
                        if (w_w_last) begin
                            w_state   <= W_RESP;
                            w_b_id    <= w_pending_id;
                            w_b_resp  <= 2'b00;
                            w_b_valid <= 1'b1;
                        end else begin
                            w_beat_idx <= w_beat_idx + 8'd1;
                        end
                    end
                end
                W_RESP: begin
                    if (w_b_valid && w_b_ready) begin
                        w_state   <= W_IDLE;
                        w_b_valid <= 1'b0;
                    end
                end
                default: w_state <= W_IDLE;
            endcase
        end
    end

    // ── AXI4 traffic counters ─────────────────────────────────────────
    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            ar_xfer_count_o <= '0;
            aw_xfer_count_o <= '0;
            w_xfer_count_o  <= '0;
            r_xfer_count_o  <= '0;
            b_xfer_count_o  <= '0;
        end else begin
            if (w_ar_valid && w_ar_ready) ar_xfer_count_o <= ar_xfer_count_o + 32'd1;
            if (w_aw_valid && w_aw_ready) aw_xfer_count_o <= aw_xfer_count_o + 32'd1;
            if (w_w_valid  && w_w_ready)  w_xfer_count_o  <= w_xfer_count_o  + 32'd1;
            if (w_r_valid  && w_r_ready)  r_xfer_count_o  <= r_xfer_count_o  + 32'd1;
            if (w_b_valid  && w_b_ready)  b_xfer_count_o  <= b_xfer_count_o  + 32'd1;
        end
    end

    // ── RVFI retirement capture ───────────────────────────────────────
    // Keep a tiny prefix trace in public TB outputs so cocotb can prove the
    // bootrom path commits instructions, not merely fetches them over AXI.
    always_ff @(posedge clk or negedge rst_n) begin
        logic [31:0] retire_count_n;
        if (!rst_n) begin
            rvfi_retire_count_o <= '0;
            rvfi_first4_insn_o  <= '0;
            rvfi_first4_pc_o    <= '0;
            rvfi_first4_trap_o  <= '0;
        end else begin
            retire_count_n = rvfi_retire_count_o;
`ifdef E1_RVFI
            for (int p = 0; p < `E1_RVFI_NRET; p++) begin
                if (w_rvfi_valid[p]) begin
                    if (retire_count_n < 32'd4) begin
                        rvfi_first4_insn_o[retire_count_n*32 +: 32] <= w_rvfi_insn[p];
                        rvfi_first4_pc_o[retire_count_n*64 +: 64]   <= w_rvfi_pc_rdata[p];
                        rvfi_first4_trap_o[retire_count_n]          <= w_rvfi_trap[p];
                    end
                    retire_count_n = retire_count_n + 32'd1;
                end
            end
`endif
            rvfi_retire_count_o <= retire_count_n;
        end
    end

endmodule
