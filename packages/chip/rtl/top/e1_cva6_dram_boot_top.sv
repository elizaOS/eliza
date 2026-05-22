`timescale 1ns/1ps

// e1_cva6_dram_boot_top
//
// CPU-execution substrate for booting the E1 SoC: a REAL CVA6 RV64 core
// fetching and executing an M-mode firmware image from the REAL AXI4 DRAM
// controller, across the REAL on-chip fabric, with the REAL CLINT/PLIC
// driving its timer/software/external interrupt lines, released by the REAL
// RoT reset sequencer.
//
// This top is the missing link between e1_soc_top (which integrates the real
// CLINT/PLIC/DRAM behind an MMIO *debug* master) and a Linux boot: here the
// bus is driven by an instruction stream the CPU fetches, not by an MMIO
// fixture.  It is deliberately a focused execution-proof top — it does not
// carry the full peripheral/BPU/cache surface of e1_soc_integrated — so the
// CVA6↔fabric↔DRAM↔CLINT datapath can be elaborated and proven end to end
// without the rest of the SoC's port count.
//
// Datapath (all blocks are the production RTL, no stubs):
//
//   e1_cpu_subsystem (rtl/cpu/e1_cva6_wrapper.sv, +define+E1_HAVE_CVA6)
//     └─ CVA6 v5.3.0 cv64a6_imafdc_sv39  →  noc_req/resp structs
//        └─ e1_cva6_to_e1axi4 (adapter, inside the wrapper)  →  64-bit AXI4
//           └─ e1_axi4_width_converter  64 → 128 (AXI4 IHI 0022 A8.4.1)
//              └─ e1_axi4_interconnect (1 master, 2 slaves, 128-bit fabric)
//                 ├─ slave 0  e1_dram_ctrl   @ 0x8000_0000 (real controller)
//                 └─ slave 1  e1_clint (via AXI4→AXI-Lite shim) @ 0x0200_0000
//
//   Interrupts:  e1_clint.mtip_o → CVA6 time_irq_i, e1_clint.msip_o → ipi_i,
//                e1_plic.irq_o   → CVA6 irq_i[1] (M-mode external).
//
//   Reset gate:  e1_rot_reset_seq holds CVA6 in reset until boot_verified_i
//                AND iopmp_policy_ready_i; lc_scrap_i latches a hard halt
//                (fail-closed, no timeout release).
//
// Firmware preload: the DRAM controller's sim-only backing store is loaded
// from the `+E1_DRAM_PRELOAD_HEX=<file>` plusarg ($readmemh, one 128-bit beat
// per line) — the deterministic stand-in for the secure boot-ROM / loader
// that places M-mode firmware in DRAM before the application core is
// released.  The CPU then fetches that image from 0x8000_0000.
//
// What this is NOT: not a Linux boot, not silicon (the LPDDR5X PHY is
// physical).  It is the executable substrate that the OS bring-up sits on.

module e1_cva6_dram_boot_top
    import e1_axi4_pkg::*;
#(
    // DRAM window decode for the fabric (256 MiB at the controller base; the
    // real e1_dram_ctrl advertises 2 GiB capacity but a 256 MiB decode mask
    // matches the e1-platform memory node and keeps the in-range check tight).
    parameter logic [39:0] DRAM_BASE  = 40'h00_8000_0000,
    parameter logic [39:0] DRAM_MASK  = 40'h00_0FFF_FFFF,
    // CLINT window decode (64 KiB at 0x0200_0000).
    parameter logic [39:0] CLINT_BASE = 40'h00_0200_0000,
    parameter logic [39:0] CLINT_MASK = 40'h00_0000_FFFF,
    // ns16550a UART window decode (4 KiB at 0x1000_1000) — the OpenSBI console.
    parameter logic [39:0] UART_BASE  = 40'h00_1000_1000,
    parameter logic [39:0] UART_MASK  = 40'h00_0000_0FFF,
    // DRAM preload depth (16-byte beats).  The bare-metal proof fits in the
    // default 4096 beats (64 KiB); an OpenSBI fw_jump image + DTB + S-mode
    // payload needs a deeper window, so this is overridable from the TB.
    parameter int unsigned DRAM_PRELOAD_BEATS = 4096,
    // CVA6 reset vector.  Defaults to the DRAM base (the bare-metal proof links
    // there).  The OpenSBI boot overrides this to a small entry shim placed
    // above the OpenSBI image, so OpenSBI itself can keep FW_TEXT_START aligned
    // at 0x8000_0000 (its domain/PMP init requires fw_start be aligned to the
    // fw_rw offset, which 0x8000_0000 satisfies and an offset base does not).
    parameter logic [63:0] CVA6_BOOT_ADDR = 64'h0000_0000_8000_0000
) (
    input  logic clk,
    input  logic rst_n,

    // RoT release inputs (fail-closed): CVA6 stays in reset until both assert.
    input  logic boot_verified_i,
    input  logic iopmp_policy_ready_i,
    input  logic lc_scrap_i,

    // External device IRQ sources into the PLIC gateway (index 0 == source 1).
    input  logic [3:0] plic_sources_i,

    // ── Observability for cocotb (no functional role) ────────────────────
    output logic [2:0]  rot_state_o,
    output logic        platform_released_o,
    output logic        rot_halted_o,
    output logic        cva6_rst_n_o,
    output logic        mtip_o,
    output logic        msip_o,
    output logic        meip_o,
    output logic [63:0] mtime_o,
    output logic [63:0] mem_base_addr_o,
    output logic [63:0] mem_capacity_bytes_o,
    // AXI4 traffic counters at the DRAM controller slave port — structural
    // proof the CPU fetched + accessed real DRAM through the real fabric.
    output logic [31:0] dram_ar_xfers_o,
    output logic [31:0] dram_aw_xfers_o,
    output logic [31:0] dram_w_xfers_o,
    output logic [31:0] dram_r_xfers_o,
    output logic [31:0] dram_b_xfers_o,
    // CLINT slave AXI-Lite handshake counters — proof the CPU programmed the
    // timer through the real fabric.
    output logic [31:0] clint_aw_xfers_o,
    output logic [31:0] clint_ar_xfers_o,

    // DRAM write-stream marker snoop.  These latch the 64-bit values the CPU
    // writes to the firmware's marker offsets in DRAM (0x8000_2000 +) as the
    // write beats reach the DRAM controller's slave port — the observable
    // image of "the CPU's stores landed in real DRAM".  Exposed as flat ports
    // because Verilator's GPI does not surface the controller's sim-only
    // associative backing store; this snoop reads the live AXI4 write channel.
    output logic [63:0] mark_alive_o,    // DRAM[0x2000] : store proof
    output logic [63:0] mark_echo_o,     // DRAM[0x2008] : load round-trip
    output logic [63:0] mark_trap_o,     // DRAM[0x2010] : trap-taken flag
    output logic [63:0] mark_mcause_o,   // DRAM[0x2018] : trap mcause
    output logic [63:0] mark_mepc_o,     // DRAM[0x2020] : trap mepc
    output logic [63:0] mark_bootok_lo_o,// DRAM[0x2030] : "E1BOOT-O"
    output logic [63:0] mark_bootok_hi_o,// DRAM[0x2038] : "K\0"

    // ns16550a console TX scrape.  `uart_tx_valid_o` pulses for one cycle each
    // time the CPU writes a byte to the UART THR; `uart_tx_byte_o` carries the
    // byte.  cocotb assembles these into the OpenSBI transcript.
    output logic       uart_tx_valid_o,
    output logic [7:0] uart_tx_byte_o,
    // UART write-transfer counter at the UART slave port — structural evidence
    // the CPU programmed + drove the console through the real fabric.
    output logic [31:0] uart_aw_xfers_o
);
    // ----------------------------------------------------------------------
    // Geometry.  CVA6 native AXI is 4-bit ID / 64-bit addr / 64-bit data.
    // The fabric is 128-bit; per-master ID is 4 bits and the fabric widens
    // it by clog2(NUM_MASTERS+1)=1 on the slave side, so slaves see 5-bit IDs.
    // ----------------------------------------------------------------------
    localparam int unsigned CVA6_ID_W   = 4;
    localparam int unsigned CVA6_ADDR_W = 64;
    localparam int unsigned CVA6_DATA_W = 64;
    localparam int unsigned CVA6_USER_W = 1;

    localparam int unsigned FAB_ADDR_W  = 40;
    localparam int unsigned FAB_DATA_W  = 128;
    localparam int unsigned FAB_ID_W    = 4;
    localparam int unsigned FAB_USER_W  = 8;
    localparam int unsigned NUM_MASTERS = 1;
    // The fabric's per-slave base/mask parameter arrays default to NUM_SLAVES=4;
    // keep that shape (slave0=DRAM, slave1=CLINT, slave2=ns16550a UART, slave3
    // is an unmapped sentinel that never decodes) so the array-literal override
    // matches the declared parameter type, matching the e1_soc_integrated
    // convention.
    localparam int unsigned NUM_SLAVES  = 4;
    localparam int unsigned WIDE_ID_W   = FAB_ID_W + $clog2(NUM_MASTERS + 1); // 5
    // Unmapped sentinel region (never matched by the decoder).
    localparam logic [39:0] UNMAP_BASE  = 40'hFF_FFFF_F000;
    localparam logic [39:0] UNMAP_MASK  = 40'h00_0000_0FFF;

    // Boot vector.  0x8000_0000 (and any higher DRAM address) is CVA6 cv64a6's
    // executable + cached PMA region (ExecuteRegionAddrBase[0], length 1 GiB).
    localparam logic [63:0] BOOT_ADDR = CVA6_BOOT_ADDR;

    // ----------------------------------------------------------------------
    // RoT reset sequencer — gates the CVA6 application core.
    // ----------------------------------------------------------------------
    logic rot_cva6_rst_no;
    /* verilator lint_off UNUSEDSIGNAL */
    logic rot_rot_rst_no, rot_pmc_rst_no;
    /* verilator lint_on UNUSEDSIGNAL */
    e1_rot_reset_seq u_rot (
        .clk_i                (clk),
        .rst_ni               (rst_n),
        .boot_verified_i      (boot_verified_i),
        .iopmp_policy_ready_i (iopmp_policy_ready_i),
        .lc_scrap_i           (lc_scrap_i),
        .rot_rst_no           (rot_rot_rst_no),
        .cva6_rst_no          (rot_cva6_rst_no),
        .pmc_rst_no           (rot_pmc_rst_no),
        .state_o              (rot_state_o),
        .platform_released_o  (platform_released_o),
        .halted_o             (rot_halted_o)
    );
    wire cva6_rst_n = rst_n & rot_cva6_rst_no;
    assign cva6_rst_n_o = cva6_rst_n;

    // ----------------------------------------------------------------------
    // CVA6 64-bit AXI4 master nets.
    // ----------------------------------------------------------------------
    logic [CVA6_ID_W-1:0]       c_ar_id;
    logic [CVA6_ADDR_W-1:0]     c_ar_addr;
    logic [7:0]                 c_ar_len;
    logic [2:0]                 c_ar_size;
    logic [1:0]                 c_ar_burst;
    logic                       c_ar_lock;
    logic [3:0]                 c_ar_cache;
    logic [2:0]                 c_ar_prot;
    logic [3:0]                 c_ar_qos;
    logic [3:0]                 c_ar_region;
    logic [CVA6_USER_W-1:0]     c_ar_user;
    logic                       c_ar_valid, c_ar_ready;
    logic [CVA6_ID_W-1:0]       c_r_id;
    logic [CVA6_DATA_W-1:0]     c_r_data;
    logic [1:0]                 c_r_resp;
    logic                       c_r_last;
    logic [CVA6_USER_W-1:0]     c_r_user;
    logic                       c_r_valid, c_r_ready;
    logic [CVA6_ID_W-1:0]       c_aw_id;
    logic [CVA6_ADDR_W-1:0]     c_aw_addr;
    logic [7:0]                 c_aw_len;
    logic [2:0]                 c_aw_size;
    logic [1:0]                 c_aw_burst;
    logic                       c_aw_lock;
    logic [3:0]                 c_aw_cache;
    logic [2:0]                 c_aw_prot;
    logic [3:0]                 c_aw_qos;
    logic [3:0]                 c_aw_region;
    logic [5:0]                 c_aw_atop;
    logic [CVA6_USER_W-1:0]     c_aw_user;
    logic                       c_aw_valid, c_aw_ready;
    logic [CVA6_DATA_W-1:0]     c_w_data;
    logic [(CVA6_DATA_W/8)-1:0] c_w_strb;
    logic                       c_w_last;
    logic [CVA6_USER_W-1:0]     c_w_user;
    logic                       c_w_valid, c_w_ready;
    logic [CVA6_ID_W-1:0]       c_b_id;
    logic [1:0]                 c_b_resp;
    logic [CVA6_USER_W-1:0]     c_b_user;
    logic                       c_b_valid, c_b_ready;

    e1_cpu_subsystem #(
        .BOOT_ADDR  (BOOT_ADDR),
        .AXI_ID_W   (CVA6_ID_W),
        .AXI_ADDR_W (CVA6_ADDR_W),
        .AXI_DATA_W (CVA6_DATA_W),
        .AXI_USER_W (CVA6_USER_W)
    ) u_cva6 (
        .clk_i        (clk),
        .rst_ni       (cva6_rst_n),
        .irq_i        ({meip_o, 1'b0}),  // [1]=M-mode ext (PLIC), [0]=S-mode
        .ipi_i        (msip_o),          // CLINT software IRQ
        .time_irq_i   (mtip_o),          // CLINT timer IRQ
        .debug_req_i  (1'b0),
        .axi_ar_id    (c_ar_id),    .axi_ar_addr  (c_ar_addr),
        .axi_ar_len   (c_ar_len),   .axi_ar_size  (c_ar_size),
        .axi_ar_burst (c_ar_burst), .axi_ar_lock  (c_ar_lock),
        .axi_ar_cache (c_ar_cache), .axi_ar_prot  (c_ar_prot),
        .axi_ar_qos   (c_ar_qos),   .axi_ar_region(c_ar_region),
        .axi_ar_user  (c_ar_user),  .axi_ar_valid (c_ar_valid),
        .axi_ar_ready (c_ar_ready),
        .axi_r_id     (c_r_id),     .axi_r_data   (c_r_data),
        .axi_r_resp   (c_r_resp),   .axi_r_last   (c_r_last),
        .axi_r_user   (c_r_user),   .axi_r_valid  (c_r_valid),
        .axi_r_ready  (c_r_ready),
        .axi_aw_id    (c_aw_id),    .axi_aw_addr  (c_aw_addr),
        .axi_aw_len   (c_aw_len),   .axi_aw_size  (c_aw_size),
        .axi_aw_burst (c_aw_burst), .axi_aw_lock  (c_aw_lock),
        .axi_aw_cache (c_aw_cache), .axi_aw_prot  (c_aw_prot),
        .axi_aw_qos   (c_aw_qos),   .axi_aw_region(c_aw_region),
        .axi_aw_atop  (c_aw_atop),  .axi_aw_user  (c_aw_user),
        .axi_aw_valid (c_aw_valid), .axi_aw_ready (c_aw_ready),
        .axi_w_data   (c_w_data),   .axi_w_strb   (c_w_strb),
        .axi_w_last   (c_w_last),   .axi_w_user   (c_w_user),
        .axi_w_valid  (c_w_valid),  .axi_w_ready  (c_w_ready),
        .axi_b_id     (c_b_id),     .axi_b_resp   (c_b_resp),
        .axi_b_user   (c_b_user),   .axi_b_valid  (c_b_valid),
        .axi_b_ready  (c_b_ready),
        .hart_id_i    (64'h0),
        .dbg_pc_o     (),           .dbg_valid_o  ()
    );

    // ----------------------------------------------------------------------
    // AXI4 atomics adapter.  CVA6 emits RISC-V `amo*` as AXI5 AWATOP atomic
    // writes that expect the old value returned on R; the downstream fabric +
    // DRAM controller have no atomic support, so this adapter resolves each
    // atomic into a read-modify-write and synthesises the R response.  Normal
    // (atop==0) traffic passes through transparently.  Without this, OpenSBI's
    // boot lottery `amoswap.w` never gets its R response and the core deadlocks.
    // ----------------------------------------------------------------------
    logic [CVA6_ID_W-1:0]       a_ar_id;
    logic [CVA6_ADDR_W-1:0]     a_ar_addr;
    logic [7:0]                 a_ar_len;
    logic [2:0]                 a_ar_size;
    logic [1:0]                 a_ar_burst;
    logic                       a_ar_lock;
    logic [3:0]                 a_ar_cache;
    logic [2:0]                 a_ar_prot;
    logic [3:0]                 a_ar_qos;
    logic [3:0]                 a_ar_region;
    logic [CVA6_USER_W-1:0]     a_ar_user;
    logic                       a_ar_valid, a_ar_ready;
    logic [CVA6_ID_W-1:0]       a_r_id;
    logic [CVA6_DATA_W-1:0]     a_r_data;
    logic [1:0]                 a_r_resp;
    logic                       a_r_last;
    logic [CVA6_USER_W-1:0]     a_r_user;
    logic                       a_r_valid, a_r_ready;
    logic [CVA6_ID_W-1:0]       a_aw_id;
    logic [CVA6_ADDR_W-1:0]     a_aw_addr;
    logic [7:0]                 a_aw_len;
    logic [2:0]                 a_aw_size;
    logic [1:0]                 a_aw_burst;
    logic                       a_aw_lock;
    logic [3:0]                 a_aw_cache;
    logic [2:0]                 a_aw_prot;
    logic [3:0]                 a_aw_qos;
    logic [3:0]                 a_aw_region;
    logic [5:0]                 a_aw_atop;
    logic [CVA6_USER_W-1:0]     a_aw_user;
    logic                       a_aw_valid, a_aw_ready;
    logic [CVA6_DATA_W-1:0]     a_w_data;
    logic [(CVA6_DATA_W/8)-1:0] a_w_strb;
    logic                       a_w_last;
    logic [CVA6_USER_W-1:0]     a_w_user;
    logic                       a_w_valid, a_w_ready;
    logic [CVA6_ID_W-1:0]       a_b_id;
    logic [1:0]                 a_b_resp;
    logic [CVA6_USER_W-1:0]     a_b_user;
    logic                       a_b_valid, a_b_ready;

    e1_axi4_amo_adapter #(
        .ID_W   (CVA6_ID_W),
        .ADDR_W (CVA6_ADDR_W),
        .DATA_W (CVA6_DATA_W),
        .USER_W (CVA6_USER_W)
    ) u_amo (
        .clk (clk), .rst_n (cva6_rst_n),
        .u_aw_id   (c_aw_id),    .u_aw_addr (c_aw_addr),
        .u_aw_len  (c_aw_len),   .u_aw_size (c_aw_size),
        .u_aw_burst(c_aw_burst), .u_aw_lock (c_aw_lock),
        .u_aw_cache(c_aw_cache), .u_aw_prot (c_aw_prot),
        .u_aw_qos  (c_aw_qos),   .u_aw_region(c_aw_region),
        .u_aw_atop (c_aw_atop),  .u_aw_user (c_aw_user),
        .u_aw_valid(c_aw_valid), .u_aw_ready(c_aw_ready),
        .u_w_data  (c_w_data),   .u_w_strb  (c_w_strb),
        .u_w_last  (c_w_last),   .u_w_user  (c_w_user),
        .u_w_valid (c_w_valid),  .u_w_ready (c_w_ready),
        .u_b_id    (c_b_id),     .u_b_resp  (c_b_resp),
        .u_b_user  (c_b_user),   .u_b_valid (c_b_valid),
        .u_b_ready (c_b_ready),
        .u_ar_id   (c_ar_id),    .u_ar_addr (c_ar_addr),
        .u_ar_len  (c_ar_len),   .u_ar_size (c_ar_size),
        .u_ar_burst(c_ar_burst), .u_ar_lock (c_ar_lock),
        .u_ar_cache(c_ar_cache), .u_ar_prot (c_ar_prot),
        .u_ar_qos  (c_ar_qos),   .u_ar_region(c_ar_region),
        .u_ar_user (c_ar_user),  .u_ar_valid(c_ar_valid),
        .u_ar_ready(c_ar_ready),
        .u_r_id    (c_r_id),     .u_r_data  (c_r_data),
        .u_r_resp  (c_r_resp),   .u_r_last  (c_r_last),
        .u_r_user  (c_r_user),   .u_r_valid (c_r_valid),
        .u_r_ready (c_r_ready),
        .d_aw_id   (a_aw_id),    .d_aw_addr (a_aw_addr),
        .d_aw_len  (a_aw_len),   .d_aw_size (a_aw_size),
        .d_aw_burst(a_aw_burst), .d_aw_lock (a_aw_lock),
        .d_aw_cache(a_aw_cache), .d_aw_prot (a_aw_prot),
        .d_aw_qos  (a_aw_qos),   .d_aw_region(a_aw_region),
        .d_aw_atop (a_aw_atop),  .d_aw_user (a_aw_user),
        .d_aw_valid(a_aw_valid), .d_aw_ready(a_aw_ready),
        .d_w_data  (a_w_data),   .d_w_strb  (a_w_strb),
        .d_w_last  (a_w_last),   .d_w_user  (a_w_user),
        .d_w_valid (a_w_valid),  .d_w_ready (a_w_ready),
        .d_b_id    (a_b_id),     .d_b_resp  (a_b_resp),
        .d_b_user  (a_b_user),   .d_b_valid (a_b_valid),
        .d_b_ready (a_b_ready),
        .d_ar_id   (a_ar_id),    .d_ar_addr (a_ar_addr),
        .d_ar_len  (a_ar_len),   .d_ar_size (a_ar_size),
        .d_ar_burst(a_ar_burst), .d_ar_lock (a_ar_lock),
        .d_ar_cache(a_ar_cache), .d_ar_prot (a_ar_prot),
        .d_ar_qos  (a_ar_qos),   .d_ar_region(a_ar_region),
        .d_ar_user (a_ar_user),  .d_ar_valid(a_ar_valid),
        .d_ar_ready(a_ar_ready),
        .d_r_id    (a_r_id),     .d_r_data  (a_r_data),
        .d_r_resp  (a_r_resp),   .d_r_last  (a_r_last),
        .d_r_user  (a_r_user),   .d_r_valid (a_r_valid),
        .d_r_ready (a_r_ready)
    );

    // ----------------------------------------------------------------------
    // 64 → 128 width converter (AXI4 upsizing).  Produces a 128-bit master
    // at the CVA6 address width (64); the fabric address slice happens below.
    // ----------------------------------------------------------------------
    logic [CVA6_ID_W-1:0]       w_ar_id;
    logic [CVA6_ADDR_W-1:0]     w_ar_addr;
    logic [7:0]                 w_ar_len;
    logic [2:0]                 w_ar_size;
    logic [1:0]                 w_ar_burst;
    logic                       w_ar_lock;
    logic [3:0]                 w_ar_cache;
    logic [2:0]                 w_ar_prot;
    logic [3:0]                 w_ar_qos;
    logic [3:0]                 w_ar_region;
    logic [CVA6_USER_W-1:0]     w_ar_user;
    logic                       w_ar_valid, w_ar_ready;
    logic [CVA6_ID_W-1:0]       w_r_id;
    logic [FAB_DATA_W-1:0]      w_r_data;
    logic [1:0]                 w_r_resp;
    logic                       w_r_last;
    logic [CVA6_USER_W-1:0]     w_r_user;
    logic                       w_r_valid, w_r_ready;
    logic [CVA6_ID_W-1:0]       w_aw_id;
    logic [CVA6_ADDR_W-1:0]     w_aw_addr;
    logic [7:0]                 w_aw_len;
    logic [2:0]                 w_aw_size;
    logic [1:0]                 w_aw_burst;
    logic                       w_aw_lock;
    logic [3:0]                 w_aw_cache;
    logic [2:0]                 w_aw_prot;
    logic [3:0]                 w_aw_qos;
    logic [3:0]                 w_aw_region;
    logic [5:0]                 w_aw_atop;
    logic [CVA6_USER_W-1:0]     w_aw_user;
    logic                       w_aw_valid, w_aw_ready;
    logic [FAB_DATA_W-1:0]      w_w_data;
    logic [(FAB_DATA_W/8)-1:0]  w_w_strb;
    logic                       w_w_last;
    logic [CVA6_USER_W-1:0]     w_w_user;
    logic                       w_w_valid, w_w_ready;
    logic [CVA6_ID_W-1:0]       w_b_id;
    logic [1:0]                 w_b_resp;
    logic [CVA6_USER_W-1:0]     w_b_user;
    logic                       w_b_valid, w_b_ready;

    e1_axi4_width_converter #(
        .UPSTREAM_DATA_W  (CVA6_DATA_W),
        .DOWNSTREAM_DATA_W(FAB_DATA_W),
        .ID_W             (CVA6_ID_W),
        .ADDR_W           (CVA6_ADDR_W),
        .USER_W           (CVA6_USER_W),
        .BURST_LEN_W      (8)
    ) u_width (
        .clk_i (clk), .rst_ni (cva6_rst_n),
        .up_aw_id   (a_aw_id),    .up_aw_addr (a_aw_addr),
        .up_aw_len  (a_aw_len),   .up_aw_size (a_aw_size),
        .up_aw_burst(a_aw_burst), .up_aw_lock (a_aw_lock),
        .up_aw_cache(a_aw_cache), .up_aw_prot (a_aw_prot),
        .up_aw_qos  (a_aw_qos),   .up_aw_region(a_aw_region),
        .up_aw_atop (a_aw_atop),  .up_aw_user (a_aw_user),
        .up_aw_valid(a_aw_valid), .up_aw_ready(a_aw_ready),
        .up_w_data  (a_w_data),   .up_w_strb  (a_w_strb),
        .up_w_last  (a_w_last),   .up_w_user  (a_w_user),
        .up_w_valid (a_w_valid),  .up_w_ready (a_w_ready),
        .up_b_id    (a_b_id),     .up_b_resp  (a_b_resp),
        .up_b_user  (a_b_user),   .up_b_valid (a_b_valid),
        .up_b_ready (a_b_ready),
        .up_ar_id   (a_ar_id),    .up_ar_addr (a_ar_addr),
        .up_ar_len  (a_ar_len),   .up_ar_size (a_ar_size),
        .up_ar_burst(a_ar_burst), .up_ar_lock (a_ar_lock),
        .up_ar_cache(a_ar_cache), .up_ar_prot (a_ar_prot),
        .up_ar_qos  (a_ar_qos),   .up_ar_region(a_ar_region),
        .up_ar_user (a_ar_user),  .up_ar_valid(a_ar_valid),
        .up_ar_ready(a_ar_ready),
        .up_r_id    (a_r_id),     .up_r_data  (a_r_data),
        .up_r_resp  (a_r_resp),   .up_r_last  (a_r_last),
        .up_r_user  (a_r_user),   .up_r_valid (a_r_valid),
        .up_r_ready (a_r_ready),
        .dn_aw_id   (w_aw_id),    .dn_aw_addr (w_aw_addr),
        .dn_aw_len  (w_aw_len),   .dn_aw_size (w_aw_size),
        .dn_aw_burst(w_aw_burst), .dn_aw_lock (w_aw_lock),
        .dn_aw_cache(w_aw_cache), .dn_aw_prot (w_aw_prot),
        .dn_aw_qos  (w_aw_qos),   .dn_aw_region(w_aw_region),
        .dn_aw_atop (w_aw_atop),  .dn_aw_user (w_aw_user),
        .dn_aw_valid(w_aw_valid), .dn_aw_ready(w_aw_ready),
        .dn_w_data  (w_w_data),   .dn_w_strb  (w_w_strb),
        .dn_w_last  (w_w_last),   .dn_w_user  (w_w_user),
        .dn_w_valid (w_w_valid),  .dn_w_ready (w_w_ready),
        .dn_b_id    (w_b_id),     .dn_b_resp  (w_b_resp),
        .dn_b_user  (w_b_user),   .dn_b_valid (w_b_valid),
        .dn_b_ready (w_b_ready),
        .dn_ar_id   (w_ar_id),    .dn_ar_addr (w_ar_addr),
        .dn_ar_len  (w_ar_len),   .dn_ar_size (w_ar_size),
        .dn_ar_burst(w_ar_burst), .dn_ar_lock (w_ar_lock),
        .dn_ar_cache(w_ar_cache), .dn_ar_prot (w_ar_prot),
        .dn_ar_qos  (w_ar_qos),   .dn_ar_region(w_ar_region),
        .dn_ar_user (w_ar_user),  .dn_ar_valid(w_ar_valid),
        .dn_ar_ready(w_ar_ready),
        .dn_r_id    (w_r_id),     .dn_r_data  (w_r_data),
        .dn_r_resp  (w_r_resp),   .dn_r_last  (w_r_last),
        .dn_r_user  (w_r_user),   .dn_r_valid (w_r_valid),
        .dn_r_ready (w_r_ready)
    );

    // ----------------------------------------------------------------------
    // Fabric master[0] inputs.  The fabric carries USER_W=8; CVA6 USER is 1
    // bit, zero-extended.  Address is sliced from 64 → 40 (the firmware uses
    // only 0x0200_0000 / 0x8000_0000, both < 2^40).
    // ----------------------------------------------------------------------
    logic [NUM_MASTERS-1:0]                  m_awvalid, m_awready;
    logic [NUM_MASTERS-1:0][FAB_ID_W-1:0]    m_awid;
    logic [NUM_MASTERS-1:0][FAB_ADDR_W-1:0]  m_awaddr;
    logic [NUM_MASTERS-1:0][7:0]             m_awlen;
    logic [NUM_MASTERS-1:0][2:0]             m_awsize;
    logic [NUM_MASTERS-1:0][1:0]             m_awburst;
    logic [NUM_MASTERS-1:0]                  m_awlock;
    logic [NUM_MASTERS-1:0][3:0]             m_awcache;
    logic [NUM_MASTERS-1:0][2:0]             m_awprot;
    logic [NUM_MASTERS-1:0][3:0]             m_awqos;
    logic [NUM_MASTERS-1:0][FAB_USER_W-1:0]  m_awuser;
    logic [NUM_MASTERS-1:0]                  m_wvalid, m_wready;
    logic [NUM_MASTERS-1:0][FAB_DATA_W-1:0]  m_wdata;
    logic [NUM_MASTERS-1:0][FAB_DATA_W/8-1:0]m_wstrb;
    logic [NUM_MASTERS-1:0]                  m_wlast;
    logic [NUM_MASTERS-1:0]                  m_bvalid, m_bready;
    logic [NUM_MASTERS-1:0][FAB_ID_W-1:0]    m_bid;
    logic [NUM_MASTERS-1:0][1:0]             m_bresp;
    logic [NUM_MASTERS-1:0]                  m_arvalid, m_arready;
    logic [NUM_MASTERS-1:0][FAB_ID_W-1:0]    m_arid;
    logic [NUM_MASTERS-1:0][FAB_ADDR_W-1:0]  m_araddr;
    logic [NUM_MASTERS-1:0][7:0]             m_arlen;
    logic [NUM_MASTERS-1:0][2:0]             m_arsize;
    logic [NUM_MASTERS-1:0][1:0]             m_arburst;
    logic [NUM_MASTERS-1:0]                  m_arlock;
    logic [NUM_MASTERS-1:0][3:0]             m_arcache;
    logic [NUM_MASTERS-1:0][2:0]             m_arprot;
    logic [NUM_MASTERS-1:0][3:0]             m_arqos;
    logic [NUM_MASTERS-1:0][FAB_USER_W-1:0]  m_aruser;
    logic [NUM_MASTERS-1:0]                  m_rvalid, m_rready;
    logic [NUM_MASTERS-1:0][FAB_ID_W-1:0]    m_rid;
    logic [NUM_MASTERS-1:0][FAB_DATA_W-1:0]  m_rdata;
    logic [NUM_MASTERS-1:0][1:0]             m_rresp;
    logic [NUM_MASTERS-1:0]                  m_rlast;

    assign m_awvalid[0] = w_aw_valid;
    assign m_awid[0]    = w_aw_id;
    assign m_awaddr[0]  = w_aw_addr[FAB_ADDR_W-1:0];
    assign m_awlen[0]   = w_aw_len;
    assign m_awsize[0]  = w_aw_size;
    assign m_awburst[0] = w_aw_burst;
    assign m_awlock[0]  = w_aw_lock;
    assign m_awcache[0] = w_aw_cache;
    assign m_awprot[0]  = w_aw_prot;
    assign m_awqos[0]   = w_aw_qos;
    assign m_awuser[0]  = {{(FAB_USER_W-CVA6_USER_W){1'b0}}, w_aw_user};
    assign w_aw_ready   = m_awready[0];
    assign m_wvalid[0]  = w_w_valid;
    assign m_wdata[0]   = w_w_data;
    assign m_wstrb[0]   = w_w_strb;
    assign m_wlast[0]   = w_w_last;
    assign w_w_ready    = m_wready[0];
    assign w_b_valid    = m_bvalid[0];
    assign w_b_id       = m_bid[0];
    assign w_b_resp     = m_bresp[0];
    assign w_b_user     = '0;
    assign m_bready[0]  = w_b_ready;
    assign m_arvalid[0] = w_ar_valid;
    assign m_arid[0]    = w_ar_id;
    assign m_araddr[0]  = w_ar_addr[FAB_ADDR_W-1:0];
    assign m_arlen[0]   = w_ar_len;
    assign m_arsize[0]  = w_ar_size;
    assign m_arburst[0] = w_ar_burst;
    assign m_arlock[0]  = w_ar_lock;
    assign m_arcache[0] = w_ar_cache;
    assign m_arprot[0]  = w_ar_prot;
    assign m_arqos[0]   = w_ar_qos;
    assign m_aruser[0]  = {{(FAB_USER_W-CVA6_USER_W){1'b0}}, w_ar_user};
    assign w_ar_ready   = m_arready[0];
    assign w_r_valid    = m_rvalid[0];
    assign w_r_id       = m_rid[0];
    assign w_r_data     = m_rdata[0];
    assign w_r_resp     = m_rresp[0];
    assign w_r_last     = m_rlast[0];
    assign w_r_user     = '0;
    assign m_rready[0]  = w_r_ready;

    // ----------------------------------------------------------------------
    // Slave-side fabric nets.  AxID is widened to WIDE_ID_W on the slave side.
    // ----------------------------------------------------------------------
    logic [NUM_SLAVES-1:0]                   s_awvalid, s_awready;
    logic [NUM_SLAVES-1:0][WIDE_ID_W-1:0]    s_awid;
    logic [NUM_SLAVES-1:0][FAB_ADDR_W-1:0]   s_awaddr;
    logic [NUM_SLAVES-1:0][7:0]              s_awlen;
    logic [NUM_SLAVES-1:0][2:0]              s_awsize;
    logic [NUM_SLAVES-1:0][1:0]              s_awburst;
    logic [NUM_SLAVES-1:0]                   s_awlock;
    logic [NUM_SLAVES-1:0][3:0]              s_awcache;
    logic [NUM_SLAVES-1:0][2:0]              s_awprot;
    logic [NUM_SLAVES-1:0][3:0]              s_awqos;
    logic [NUM_SLAVES-1:0][FAB_USER_W-1:0]   s_awuser;
    logic [NUM_SLAVES-1:0]                   s_wvalid, s_wready;
    logic [NUM_SLAVES-1:0][FAB_DATA_W-1:0]   s_wdata;
    logic [NUM_SLAVES-1:0][FAB_DATA_W/8-1:0] s_wstrb;
    logic [NUM_SLAVES-1:0]                   s_wlast;
    logic [NUM_SLAVES-1:0]                   s_bvalid, s_bready;
    logic [NUM_SLAVES-1:0][WIDE_ID_W-1:0]    s_bid;
    logic [NUM_SLAVES-1:0][1:0]              s_bresp;
    logic [NUM_SLAVES-1:0]                   s_arvalid, s_arready;
    logic [NUM_SLAVES-1:0][WIDE_ID_W-1:0]    s_arid;
    logic [NUM_SLAVES-1:0][FAB_ADDR_W-1:0]   s_araddr;
    logic [NUM_SLAVES-1:0][7:0]              s_arlen;
    logic [NUM_SLAVES-1:0][2:0]              s_arsize;
    logic [NUM_SLAVES-1:0][1:0]              s_arburst;
    logic [NUM_SLAVES-1:0]                   s_arlock;
    logic [NUM_SLAVES-1:0][3:0]              s_arcache;
    logic [NUM_SLAVES-1:0][2:0]              s_arprot;
    logic [NUM_SLAVES-1:0][3:0]              s_arqos;
    logic [NUM_SLAVES-1:0][FAB_USER_W-1:0]   s_aruser;
    logic [NUM_SLAVES-1:0]                   s_rvalid, s_rready;
    logic [NUM_SLAVES-1:0][WIDE_ID_W-1:0]    s_rid;
    logic [NUM_SLAVES-1:0][FAB_DATA_W-1:0]   s_rdata;
    logic [NUM_SLAVES-1:0][1:0]              s_rresp;
    logic [NUM_SLAVES-1:0]                   s_rlast;

    // Per-slave decode: slave0 = DRAM, slave1 = CLINT, slave2 = UART.
    logic [FAB_ADDR_W-1:0] slv_base [0:NUM_SLAVES-1];
    logic [FAB_ADDR_W-1:0] slv_mask [0:NUM_SLAVES-1];
    assign slv_base[0] = DRAM_BASE;  assign slv_mask[0] = DRAM_MASK;
    assign slv_base[1] = CLINT_BASE; assign slv_mask[1] = CLINT_MASK;
    assign slv_base[2] = UART_BASE;  assign slv_mask[2] = UART_MASK;

    /* verilator lint_off UNUSEDSIGNAL */
    logic [NUM_MASTERS-1:0]       ic_decode_err_irq, ic_excl_fail_irq;
    logic [NUM_MASTERS-1:0][31:0] ic_outstanding_dbg;
    /* verilator lint_on UNUSEDSIGNAL */

    e1_axi4_interconnect #(
        .NUM_MASTERS (NUM_MASTERS),
        .NUM_SLAVES  (NUM_SLAVES),
        .ADDR_WIDTH  (FAB_ADDR_W),
        .DATA_WIDTH  (FAB_DATA_W),
        .ID_WIDTH    (FAB_ID_W),
        .USER_WIDTH  (FAB_USER_W),
        .BURST_LEN_W (8),
        .SLAVE_BASE  ('{DRAM_BASE, CLINT_BASE, UART_BASE, UNMAP_BASE}),
        .SLAVE_MASK  ('{DRAM_MASK, CLINT_MASK, UART_MASK, UNMAP_MASK})
    ) u_fabric (
        .clk (clk), .rst_n (cva6_rst_n),
        .m_awvalid (m_awvalid), .m_awready (m_awready), .m_awid (m_awid),
        .m_awaddr (m_awaddr),   .m_awlen (m_awlen),     .m_awsize (m_awsize),
        .m_awburst (m_awburst), .m_awlock (m_awlock),   .m_awcache (m_awcache),
        .m_awprot (m_awprot),   .m_awqos (m_awqos),     .m_awuser (m_awuser),
        .m_wvalid (m_wvalid),   .m_wready (m_wready),   .m_wdata (m_wdata),
        .m_wstrb (m_wstrb),     .m_wlast (m_wlast),
        .m_bvalid (m_bvalid),   .m_bready (m_bready),   .m_bid (m_bid),
        .m_bresp (m_bresp),
        .m_arvalid (m_arvalid), .m_arready (m_arready), .m_arid (m_arid),
        .m_araddr (m_araddr),   .m_arlen (m_arlen),     .m_arsize (m_arsize),
        .m_arburst (m_arburst), .m_arlock (m_arlock),   .m_arcache (m_arcache),
        .m_arprot (m_arprot),   .m_arqos (m_arqos),     .m_aruser (m_aruser),
        .m_rvalid (m_rvalid),   .m_rready (m_rready),   .m_rid (m_rid),
        .m_rdata (m_rdata),     .m_rresp (m_rresp),     .m_rlast (m_rlast),
        .s_awvalid (s_awvalid), .s_awready (s_awready), .s_awid (s_awid),
        .s_awaddr (s_awaddr),   .s_awlen (s_awlen),     .s_awsize (s_awsize),
        .s_awburst (s_awburst), .s_awlock (s_awlock),   .s_awcache (s_awcache),
        .s_awprot (s_awprot),   .s_awqos (s_awqos),     .s_awuser (s_awuser),
        .s_wvalid (s_wvalid),   .s_wready (s_wready),   .s_wdata (s_wdata),
        .s_wstrb (s_wstrb),     .s_wlast (s_wlast),
        .s_bvalid (s_bvalid),   .s_bready (s_bready),   .s_bid (s_bid),
        .s_bresp (s_bresp),
        .s_arvalid (s_arvalid), .s_arready (s_arready), .s_arid (s_arid),
        .s_araddr (s_araddr),   .s_arlen (s_arlen),     .s_arsize (s_arsize),
        .s_arburst (s_arburst), .s_arlock (s_arlock),   .s_arcache (s_arcache),
        .s_arprot (s_arprot),   .s_arqos (s_arqos),     .s_aruser (s_aruser),
        .s_rvalid (s_rvalid),   .s_rready (s_rready),   .s_rid (s_rid),
        .s_rdata (s_rdata),     .s_rresp (s_rresp),     .s_rlast (s_rlast),
        .decode_err_irq        (ic_decode_err_irq),
        .exclusive_fail_irq    (ic_excl_fail_irq),
        .outstanding_count_dbg (ic_outstanding_dbg),
        .irq_status_clear_we              (1'b0),
        .irq_status_decode_err_clear_mask (1'b0),
        .irq_status_excl_fail_clear_mask  (1'b0)
    );

    /* verilator lint_off UNUSEDSIGNAL */
    logic unused_slv_base_mask;
    assign unused_slv_base_mask = ^{slv_base[0], slv_base[1], slv_base[2],
                                    slv_mask[0], slv_mask[1], slv_mask[2]};
    /* verilator lint_on UNUSEDSIGNAL */

    // ----------------------------------------------------------------------
    // Slave 0 — real AXI4 DRAM controller @ 0x8000_0000.
    // The DFI south boundary is the physical LPDDR5X PHY (not modelled at the
    // analog level); tie its inputs to the benign "init complete / no read
    // data" values, exactly as e1_soc_real_subsys does.  In sim the
    // authoritative data path is the controller's behavioural backing store,
    // preloaded from +E1_DRAM_PRELOAD_HEX.
    // ----------------------------------------------------------------------
    /* verilator lint_off UNUSEDSIGNAL */
    logic [FAB_ADDR_W-1:0] dfi_addr;
    logic [3:0]            dfi_bank;
    logic                  dfi_cs_n, dfi_act_n, dfi_ras_n, dfi_cas_n, dfi_we_n;
    logic                  dfi_reset_n, dfi_cke, dfi_odt;
    logic [FAB_DATA_W-1:0] dfi_wrdata;
    logic [FAB_DATA_W/8-1:0] dfi_wrdata_mask;
    logic                  dfi_wrdata_en, dfi_rddata_en;
    logic                  dfi_init_start, dfi_ctrlupd_req, dfi_dram_clk_disable;
    logic                  refresh_active, zqcs_active, zqcl_active;
    logic [31:0]           odecc_c, odecc_u, linkecc_c, linkecc_u;
    logic                  ecc_uncorrected_irq;
    /* verilator lint_on UNUSEDSIGNAL */

    e1_dram_ctrl #(
        .ID_WIDTH   (WIDE_ID_W),
        .ADDR_WIDTH (FAB_ADDR_W),
        .DATA_WIDTH (FAB_DATA_W),
        .USER_WIDTH (FAB_USER_W),
        .MEM_PRELOAD_MAX_BEATS (DRAM_PRELOAD_BEATS)
    ) u_dram (
        .clk (clk), .rst_n (cva6_rst_n),
        .s_awvalid (s_awvalid[0]), .s_awready (s_awready[0]),
        .s_awid (s_awid[0]),       .s_awaddr (s_awaddr[0]),
        .s_awlen (s_awlen[0]),     .s_awsize (s_awsize[0]),
        .s_awburst (s_awburst[0]), .s_awlock (s_awlock[0]),
        .s_awcache (s_awcache[0]), .s_awprot (s_awprot[0]),
        .s_awqos (s_awqos[0]),     .s_awuser (s_awuser[0]),
        .s_wvalid (s_wvalid[0]),   .s_wready (s_wready[0]),
        .s_wdata (s_wdata[0]),     .s_wstrb (s_wstrb[0]),
        .s_wlast (s_wlast[0]),
        .s_bvalid (s_bvalid[0]),   .s_bready (s_bready[0]),
        .s_bid (s_bid[0]),         .s_bresp (s_bresp[0]),
        .s_arvalid (s_arvalid[0]), .s_arready (s_arready[0]),
        .s_arid (s_arid[0]),       .s_araddr (s_araddr[0]),
        .s_arlen (s_arlen[0]),     .s_arsize (s_arsize[0]),
        .s_arburst (s_arburst[0]), .s_arlock (s_arlock[0]),
        .s_arcache (s_arcache[0]), .s_arprot (s_arprot[0]),
        .s_arqos (s_arqos[0]),     .s_aruser (s_aruser[0]),
        .s_rvalid (s_rvalid[0]),   .s_rready (s_rready[0]),
        .s_rid (s_rid[0]),         .s_rdata (s_rdata[0]),
        .s_rresp (s_rresp[0]),     .s_rlast (s_rlast[0]),
        .mem_base_addr      (mem_base_addr_o),
        .mem_capacity_bytes (mem_capacity_bytes_o),
        .dfi_addr (dfi_addr), .dfi_bank (dfi_bank), .dfi_cs_n (dfi_cs_n),
        .dfi_act_n (dfi_act_n), .dfi_ras_n (dfi_ras_n), .dfi_cas_n (dfi_cas_n),
        .dfi_we_n (dfi_we_n), .dfi_reset_n (dfi_reset_n), .dfi_cke (dfi_cke),
        .dfi_odt (dfi_odt), .dfi_wrdata (dfi_wrdata),
        .dfi_wrdata_mask (dfi_wrdata_mask), .dfi_wrdata_en (dfi_wrdata_en),
        .dfi_rddata ('0), .dfi_rddata_valid (1'b0), .dfi_rddata_en (dfi_rddata_en),
        .dfi_init_start (dfi_init_start), .dfi_init_complete (1'b1),
        .dfi_ctrlupd_req (dfi_ctrlupd_req), .dfi_ctrlupd_ack (1'b1),
        .dfi_dram_clk_disable (dfi_dram_clk_disable),
        .refresh_active (refresh_active), .zqcs_active (zqcs_active),
        .zqcl_active (zqcl_active),
        .odecc_corrected_count (odecc_c), .odecc_uncorrected_count (odecc_u),
        .linkecc_corrected_count (linkecc_c), .linkecc_uncorrected_count (linkecc_u),
        .ecc_uncorrected_irq (ecc_uncorrected_irq)
    );

    // ----------------------------------------------------------------------
    // Slave 1 — real CLINT @ 0x0200_0000, behind an AXI4(128)→AXI-Lite(32)
    // slave shim.  CVA6 issues single-beat (AxLEN=0) word accesses to the
    // uncached CLINT region; the firmware uses 4-byte lw/sw, so each access
    // maps to one AXI-Lite transfer with the 32-bit lane selected by the
    // address's low bits within the 128-bit beat.
    // ----------------------------------------------------------------------
    logic        clint_awvalid, clint_awready;
    logic [31:0] clint_awaddr;
    logic        clint_wvalid,  clint_wready;
    logic [31:0] clint_wdata;
    logic [3:0]  clint_wstrb;
    logic        clint_bvalid,  clint_bready;
    logic [1:0]  clint_bresp;
    logic        clint_arvalid, clint_arready;
    logic [31:0] clint_araddr;
    logic        clint_rvalid,  clint_rready;
    logic [31:0] clint_rdata;
    logic [1:0]  clint_rresp;

    e1_axi4_to_axilite_slave #(
        .ID_W   (WIDE_ID_W),
        .ADDR_W (FAB_ADDR_W),
        .DATA_W (FAB_DATA_W)
    ) u_clint_shim (
        .clk (clk), .rst_n (cva6_rst_n),
        .s_awvalid (s_awvalid[1]), .s_awready (s_awready[1]),
        .s_awid (s_awid[1]),       .s_awaddr (s_awaddr[1]),
        .s_awlen (s_awlen[1]),     .s_awsize (s_awsize[1]),
        .s_awburst (s_awburst[1]),
        .s_wvalid (s_wvalid[1]),   .s_wready (s_wready[1]),
        .s_wdata (s_wdata[1]),     .s_wstrb (s_wstrb[1]),
        .s_wlast (s_wlast[1]),
        .s_bvalid (s_bvalid[1]),   .s_bready (s_bready[1]),
        .s_bid (s_bid[1]),         .s_bresp (s_bresp[1]),
        .s_arvalid (s_arvalid[1]), .s_arready (s_arready[1]),
        .s_arid (s_arid[1]),       .s_araddr (s_araddr[1]),
        .s_arlen (s_arlen[1]),     .s_arsize (s_arsize[1]),
        .s_arburst (s_arburst[1]),
        .s_rvalid (s_rvalid[1]),   .s_rready (s_rready[1]),
        .s_rid (s_rid[1]),         .s_rdata (s_rdata[1]),
        .s_rresp (s_rresp[1]),     .s_rlast (s_rlast[1]),
        .l_awvalid (clint_awvalid), .l_awready (clint_awready),
        .l_awaddr (clint_awaddr),
        .l_wvalid (clint_wvalid),   .l_wready (clint_wready),
        .l_wdata (clint_wdata),     .l_wstrb (clint_wstrb),
        .l_bvalid (clint_bvalid),   .l_bready (clint_bready),
        .l_bresp (clint_bresp),
        .l_arvalid (clint_arvalid), .l_arready (clint_arready),
        .l_araddr (clint_araddr),
        .l_rvalid (clint_rvalid),   .l_rready (clint_rready),
        .l_rdata (clint_rdata),     .l_rresp (clint_rresp)
    );

    logic clint_mtip, clint_msip;
    e1_clint #(.NUM_HARTS(1)) u_clint (
        .clk (clk), .rst_n (cva6_rst_n),
        .msip_o (clint_msip), .mtip_o (clint_mtip), .mtime_o (mtime_o),
        .s_axil_awvalid (clint_awvalid), .s_axil_awready (clint_awready),
        .s_axil_awaddr (clint_awaddr),
        .s_axil_wvalid (clint_wvalid),   .s_axil_wready (clint_wready),
        .s_axil_wdata (clint_wdata),     .s_axil_wstrb (clint_wstrb),
        .s_axil_bvalid (clint_bvalid),   .s_axil_bready (clint_bready),
        .s_axil_bresp (clint_bresp),
        .s_axil_arvalid (clint_arvalid), .s_axil_arready (clint_arready),
        .s_axil_araddr (clint_araddr),
        .s_axil_rvalid (clint_rvalid),   .s_axil_rready (clint_rready),
        .s_axil_rdata (clint_rdata),     .s_axil_rresp (clint_rresp)
    );
    assign mtip_o = clint_mtip;
    assign msip_o = clint_msip;

    // ----------------------------------------------------------------------
    // Real PLIC.  External device sources route to the M-mode context output
    // which drives CVA6 irq_i[1].  The firmware proof exercises the CLINT
    // timer trap; the PLIC is wired structurally so the external-IRQ path is
    // present and elaborated (and so a follow-on test can claim/complete it).
    // ----------------------------------------------------------------------
    // ----------------------------------------------------------------------
    // Slave 2 — ns16550a-compatible UART @ 0x1000_1000, the OpenSBI console.
    // OpenSBI's uart8250 driver polls LSR.THRE then writes the character to
    // THR; this model accepts each write and emits the byte on the TX scrape
    // ports for cocotb to assemble into the boot transcript.
    // ----------------------------------------------------------------------
    e1_uart_ns16550 #(
        .ID_W   (WIDE_ID_W),
        .ADDR_W (FAB_ADDR_W),
        .DATA_W (FAB_DATA_W)
    ) u_uart (
        .clk (clk), .rst_n (cva6_rst_n),
        .s_awvalid (s_awvalid[2]), .s_awready (s_awready[2]),
        .s_awid (s_awid[2]),       .s_awaddr (s_awaddr[2]),
        .s_awlen (s_awlen[2]),     .s_awsize (s_awsize[2]),
        .s_awburst (s_awburst[2]),
        .s_wvalid (s_wvalid[2]),   .s_wready (s_wready[2]),
        .s_wdata (s_wdata[2]),     .s_wstrb (s_wstrb[2]),
        .s_wlast (s_wlast[2]),
        .s_bvalid (s_bvalid[2]),   .s_bready (s_bready[2]),
        .s_bid (s_bid[2]),         .s_bresp (s_bresp[2]),
        .s_arvalid (s_arvalid[2]), .s_arready (s_arready[2]),
        .s_arid (s_arid[2]),       .s_araddr (s_araddr[2]),
        .s_arlen (s_arlen[2]),     .s_arsize (s_arsize[2]),
        .s_arburst (s_arburst[2]),
        .s_rvalid (s_rvalid[2]),   .s_rready (s_rready[2]),
        .s_rid (s_rid[2]),         .s_rdata (s_rdata[2]),
        .s_rresp (s_rresp[2]),     .s_rlast (s_rlast[2]),
        .tx_valid_o (uart_tx_valid_o),
        .tx_byte_o  (uart_tx_byte_o)
    );

    // Unmapped sentinel slave (3): never decoded, so the fabric never
    // forwards an address phase to it.  Tie its response inputs to idle.
    for (genvar gs = 3; gs < NUM_SLAVES; gs++) begin : g_unmapped_slaves
        assign s_awready[gs] = 1'b0;
        assign s_wready[gs]  = 1'b0;
        assign s_bvalid[gs]  = 1'b0;
        assign s_bid[gs]     = '0;
        assign s_bresp[gs]   = 2'b00;
        assign s_arready[gs] = 1'b0;
        assign s_rvalid[gs]  = 1'b0;
        assign s_rid[gs]     = '0;
        assign s_rdata[gs]   = '0;
        assign s_rresp[gs]   = 2'b00;
        assign s_rlast[gs]   = 1'b0;
    end

    logic plic_meip;
    /* verilator lint_off PINCONNECTEMPTY */
    e1_plic #(.NUM_SOURCES (4), .NUM_CONTEXTS (1)) u_plic (
        .clk (clk), .rst_n (cva6_rst_n),
        .irq_sources (plic_sources_i),
        .irq_o (plic_meip),
        // PLIC programming port is unused in the bare-metal timer proof; tie
        // off the request side so it is quiescent (no spurious claim path).
        .s_axil_awvalid (1'b0), .s_axil_awready (),
        .s_axil_awaddr (32'h0),
        .s_axil_wvalid (1'b0), .s_axil_wready (),
        .s_axil_wdata (32'h0), .s_axil_wstrb (4'h0),
        .s_axil_bvalid (), .s_axil_bready (1'b1), .s_axil_bresp (),
        .s_axil_arvalid (1'b0), .s_axil_arready (),
        .s_axil_araddr (32'h0),
        .s_axil_rvalid (), .s_axil_rready (1'b1),
        .s_axil_rdata (), .s_axil_rresp ()
    );
    /* verilator lint_on PINCONNECTEMPTY */
    assign meip_o = plic_meip;

    // ----------------------------------------------------------------------
    // DRAM + CLINT traffic counters (structural execution evidence).
    // ----------------------------------------------------------------------
    always_ff @(posedge clk or negedge cva6_rst_n) begin
        if (!cva6_rst_n) begin
            dram_ar_xfers_o <= '0; dram_aw_xfers_o <= '0; dram_w_xfers_o <= '0;
            dram_r_xfers_o  <= '0; dram_b_xfers_o  <= '0;
            clint_aw_xfers_o <= '0; clint_ar_xfers_o <= '0;
        end else begin
            if (s_arvalid[0] && s_arready[0]) dram_ar_xfers_o <= dram_ar_xfers_o + 1;
            if (s_awvalid[0] && s_awready[0]) dram_aw_xfers_o <= dram_aw_xfers_o + 1;
            if (s_wvalid[0]  && s_wready[0])  dram_w_xfers_o  <= dram_w_xfers_o  + 1;
            if (s_rvalid[0]  && s_rready[0])  dram_r_xfers_o  <= dram_r_xfers_o  + 1;
            if (s_bvalid[0]  && s_bready[0])  dram_b_xfers_o  <= dram_b_xfers_o  + 1;
            if (clint_awvalid && clint_awready) clint_aw_xfers_o <= clint_aw_xfers_o + 1;
            if (clint_arvalid && clint_arready) clint_ar_xfers_o <= clint_ar_xfers_o + 1;
        end
    end

    // UART write-transfer counter at the UART slave port.
    always_ff @(posedge clk or negedge cva6_rst_n) begin
        if (!cva6_rst_n) uart_aw_xfers_o <= '0;
        else if (s_awvalid[2] && s_awready[2]) uart_aw_xfers_o <= uart_aw_xfers_o + 1;
    end

    // ----------------------------------------------------------------------
    // DRAM write-stream marker snoop.  Latches the firmware's 64-bit marker
    // words as the CPU's write beats reach the DRAM controller's slave port.
    // The DRAM bus is 128-bit; each marker offset maps to one 64-bit lane of
    // the beat addressed by aw_addr_q.  Writes are byte-strobed, so a marker
    // lane is captured only when its byte strobes are active.  This snoops the
    // REAL write traffic into the REAL controller — it does not bypass it.
    //
    // Marker byte offsets from DRAM base (see boot.S):
    //   0x2000 alive | 0x2008 echo | 0x2010 trap | 0x2018 mcause
    //   0x2020 mepc  | 0x2030 boot-OK lo | 0x2038 boot-OK hi
    // ----------------------------------------------------------------------
    localparam logic [39:0] MK = DRAM_BASE + 40'h2000;  // marker base PA

    logic [FAB_ADDR_W-1:0] dram_aw_addr_q;
    logic                  dram_aw_pend_q;

    function automatic logic [63:0] wlane(input logic [FAB_DATA_W-1:0] d,
                                          input logic                  hi);
        wlane = hi ? d[127:64] : d[63:0];
    endfunction
    function automatic logic lane_strobed(input logic [FAB_DATA_W/8-1:0] strb,
                                          input logic hi);
        lane_strobed = hi ? (|strb[15:8]) : (|strb[7:0]);
    endfunction

    always_ff @(posedge clk or negedge cva6_rst_n) begin
        if (!cva6_rst_n) begin
            dram_aw_addr_q   <= '0;
            dram_aw_pend_q   <= 1'b0;
            mark_alive_o     <= '0;
            mark_echo_o      <= '0;
            mark_trap_o      <= '0;
            mark_mcause_o    <= '0;
            mark_mepc_o      <= '0;
            mark_bootok_lo_o <= '0;
            mark_bootok_hi_o <= '0;
        end else begin
            if (s_awvalid[0] && s_awready[0]) begin
                dram_aw_addr_q <= s_awaddr[0];
                dram_aw_pend_q <= 1'b1;
            end
            if (s_wvalid[0] && s_wready[0] && dram_aw_pend_q) begin
                // Each W beat covers 16 bytes at {addr[39:4],4'h0}; lane hi =
                // addr bit3.  Advance the beat address per beat so a cache-line
                // INCR burst (4 x 128-bit beats) lands each marker correctly.
                logic [FAB_ADDR_W-1:0] beat_base;
                beat_base = {dram_aw_addr_q[FAB_ADDR_W-1:4], 4'h0};
                dram_aw_addr_q <= dram_aw_addr_q + 40'h10;
                // 0x2000 (alive) / 0x2008 (echo) live in beat MK
                if (beat_base == MK) begin
                    if (lane_strobed(s_wstrb[0], 1'b0))
                        mark_alive_o <= wlane(s_wdata[0], 1'b0);
                    if (lane_strobed(s_wstrb[0], 1'b1))
                        mark_echo_o  <= wlane(s_wdata[0], 1'b1);
                end
                // 0x2010 (trap) / 0x2018 (mcause) in beat MK+0x10
                if (beat_base == (MK + 40'h10)) begin
                    if (lane_strobed(s_wstrb[0], 1'b0))
                        mark_trap_o   <= wlane(s_wdata[0], 1'b0);
                    if (lane_strobed(s_wstrb[0], 1'b1))
                        mark_mcause_o <= wlane(s_wdata[0], 1'b1);
                end
                // 0x2020 (mepc) in beat MK+0x20 (low lane)
                if (beat_base == (MK + 40'h20)) begin
                    if (lane_strobed(s_wstrb[0], 1'b0))
                        mark_mepc_o <= wlane(s_wdata[0], 1'b0);
                end
                // 0x2030 (boot-OK lo) / 0x2038 (boot-OK hi) in beat MK+0x30
                if (beat_base == (MK + 40'h30)) begin
                    if (lane_strobed(s_wstrb[0], 1'b0))
                        mark_bootok_lo_o <= wlane(s_wdata[0], 1'b0);
                    if (lane_strobed(s_wstrb[0], 1'b1))
                        mark_bootok_hi_o <= wlane(s_wdata[0], 1'b1);
                end
                if (s_wlast[0]) dram_aw_pend_q <= 1'b0;
            end
        end
    end

endmodule

// ----------------------------------------------------------------------
// e1_axi4_to_axilite_slave
//
// Single-outstanding AXI4 (wide-data, widened-ID) slave that bridges to a
// 32-bit AXI-Lite slave (CLINT/PLIC class).  Accepts AxLEN=0 single beats
// (CVA6 issues single-beat uncached MMIO accesses); the 32-bit lane within
// the wide beat is selected by the access address's low bits.  The widened
// AxID is latched and echoed on the B/R response so the fabric routes the
// response back to the originating master.  This is the read/write twin of
// e1_axi4_mmio_shim but driven from an AXI4 master (the CPU) rather than the
// MMIO debug aperture.
// ----------------------------------------------------------------------
module e1_axi4_to_axilite_slave
    import e1_axi4_pkg::*;
#(
    parameter int unsigned ID_W   = 5,
    parameter int unsigned ADDR_W = 40,
    parameter int unsigned DATA_W = 128
) (
    input  logic clk,
    input  logic rst_n,

    // AXI4 slave (from the fabric)
    input  logic              s_awvalid,
    output logic              s_awready,
    input  logic [ID_W-1:0]   s_awid,
    input  logic [ADDR_W-1:0] s_awaddr,
    input  logic [7:0]        s_awlen,
    input  logic [2:0]        s_awsize,
    input  logic [1:0]        s_awburst,
    input  logic              s_wvalid,
    output logic              s_wready,
    input  logic [DATA_W-1:0] s_wdata,
    input  logic [DATA_W/8-1:0] s_wstrb,
    input  logic              s_wlast,
    output logic              s_bvalid,
    input  logic              s_bready,
    output logic [ID_W-1:0]   s_bid,
    output logic [1:0]        s_bresp,
    input  logic              s_arvalid,
    output logic              s_arready,
    input  logic [ID_W-1:0]   s_arid,
    input  logic [ADDR_W-1:0] s_araddr,
    input  logic [7:0]        s_arlen,
    input  logic [2:0]        s_arsize,
    input  logic [1:0]        s_arburst,
    output logic              s_rvalid,
    input  logic              s_rready,
    output logic [ID_W-1:0]   s_rid,
    output logic [DATA_W-1:0] s_rdata,
    output logic [1:0]        s_rresp,
    output logic              s_rlast,

    // AXI-Lite master (to the CLINT/PLIC leaf)
    output logic        l_awvalid,
    input  logic        l_awready,
    output logic [31:0] l_awaddr,
    output logic        l_wvalid,
    input  logic        l_wready,
    output logic [31:0] l_wdata,
    output logic [3:0]  l_wstrb,
    input  logic        l_bvalid,
    output logic        l_bready,
    input  logic [1:0]  l_bresp,
    output logic        l_arvalid,
    input  logic        l_arready,
    output logic [31:0] l_araddr,
    input  logic        l_rvalid,
    output logic        l_rready,
    input  logic [31:0] l_rdata,
    input  logic [1:0]  l_rresp
);
    localparam int unsigned LANE_LSB = $clog2(DATA_W/8); // 4 for 128-bit bus

    // FSM: capture the AW (or AR) address phase, then accept the single W beat
    // (write) and drive the AXI-Lite AW+W (or AR), wait for the leaf B (or R),
    // and return the response with the latched ID.  Single outstanding.
    typedef enum logic [2:0] {
        S_IDLE, S_WDATA, S_AWW, S_B, S_AR, S_R
    } st_e;
    st_e st;

    logic [ID_W-1:0]     id_q;
    logic [LANE_LSB-1:2] lane_q;       // 32-bit lane index within the beat
    logic [ADDR_W-1:0]   addr_q;       // captured low address
    logic [31:0]         wdata_q;      // captured 32-bit write lane
    logic [31:0]         rdata_q;      // captured 32-bit read result

    // Accept the address phases only when idle; give writes priority.
    assign s_awready = (st == S_IDLE);
    assign s_arready = (st == S_IDLE) && !s_awvalid;
    // Accept the single W beat in S_WDATA.
    assign s_wready  = (st == S_WDATA);

    logic aw_done_q, w_done_q;   // AXI-Lite AW / W phases accepted
    // The AXI-Lite leaf is a 32-bit-address slave that masks its own window;
    // the fabric address is wider (ADDR_W), so pass the low 32 bits.  CLINT's
    // 64 KiB window fits comfortably (it uses only the low 16 bits).
    assign l_awaddr  = addr_q[31:0];
    assign l_araddr  = addr_q[31:0];
    assign l_wstrb   = 4'hF;
    assign l_wdata   = wdata_q;
    assign l_awvalid = (st == S_AWW) && !aw_done_q;
    assign l_wvalid  = (st == S_AWW) && !w_done_q;
    assign l_arvalid = (st == S_AR);
    assign l_bready  = 1'b1;
    assign l_rready  = 1'b1;

    logic resp_ok_q;   // leaf B/R seen — gates the AXI4 response valid
    assign s_bid    = id_q;
    assign s_bresp  = RESP_OKAY;
    assign s_rid    = id_q;
    assign s_rresp  = RESP_OKAY;
    assign s_rlast  = 1'b1;
    assign s_bvalid = (st == S_B) && resp_ok_q;
    assign s_rvalid = (st == S_R) && resp_ok_q;
    always_comb begin
        s_rdata = '0;
        s_rdata[{lane_q, 5'b0} +: 32] = rdata_q;
    end

    /* verilator lint_off UNUSEDSIGNAL */
    logic unused;
    assign unused = ^{s_awlen, s_awsize, s_awburst, s_arlen, s_arsize,
                      s_arburst, s_wlast, l_bresp, l_rresp};
    /* verilator lint_on UNUSEDSIGNAL */

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            st        <= S_IDLE;
            id_q      <= '0;
            lane_q    <= '0;
            addr_q    <= '0;
            wdata_q   <= 32'h0;
            rdata_q   <= 32'h0;
            resp_ok_q <= 1'b0;
            aw_done_q <= 1'b0;
            w_done_q  <= 1'b0;
        end else begin
            unique case (st)
                S_IDLE: begin
                    resp_ok_q <= 1'b0;
                    aw_done_q <= 1'b0;
                    w_done_q  <= 1'b0;
                    if (s_awvalid && s_awready) begin
                        id_q   <= s_awid;
                        lane_q <= s_awaddr[LANE_LSB-1:2];
                        addr_q <= s_awaddr;
                        st     <= S_WDATA;
                    end else if (s_arvalid && s_arready) begin
                        id_q   <= s_arid;
                        lane_q <= s_araddr[LANE_LSB-1:2];
                        addr_q <= s_araddr;
                        st     <= S_AR;
                    end
                end
                S_WDATA: begin
                    if (s_wvalid && s_wready) begin
                        wdata_q <= s_wdata[{lane_q, 5'b0} +: 32];
                        st      <= S_AWW;
                    end
                end
                S_AWW: begin
                    // Drive AW + W to the leaf; each clears as it is accepted.
                    if (l_awvalid && l_awready) aw_done_q <= 1'b1;
                    if (l_wvalid  && l_wready)  w_done_q  <= 1'b1;
                    // Once the leaf returns B, present it upstream.
                    if (l_bvalid) begin
                        resp_ok_q <= 1'b1;
                        st        <= S_B;
                    end
                end
                S_B: begin
                    if (s_bvalid && s_bready) begin
                        resp_ok_q <= 1'b0;
                        st        <= S_IDLE;
                    end
                end
                S_AR: begin
                    if (l_arvalid && l_arready) st <= S_R;
                end
                S_R: begin
                    if (l_rvalid) begin
                        rdata_q   <= l_rdata;
                        resp_ok_q <= 1'b1;
                    end
                    if (s_rvalid && s_rready) begin
                        resp_ok_q <= 1'b0;
                        st        <= S_IDLE;
                    end
                end
                default: st <= S_IDLE;
            endcase
        end
    end

endmodule
