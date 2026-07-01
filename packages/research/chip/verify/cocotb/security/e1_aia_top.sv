`timescale 1ns/1ps

// e1_aia_top — verification harness wiring the AIA APLIC to the IMSIC.
//
// This is a test-only top (under verify/) that connects e1_aplic's MSI emit
// port to e1_imsic's memory-mapped doorbell, with a mux that lets the cocotb
// KAT also inject a "raw device MSI" directly into the doorbell (modelling a
// device or the IOMMU MSI-translation stage). It exposes the IMSIC xtopei
// claim interface and the APLIC config port flattened to scalar ports so the
// cocotb testbench can drive them.
//
// Files: per hart, file 0 = S (host) file, file 1 = secure/monitor file
// (SECURE_FILE=1, NUM_GUESTS=0). With NUM_HARTS harts the flat file index is
// f = hart*2 + local. The IMSIC doorbell page for flat file f is at
// f*PAGE_BYTES.

module e1_aia_top #(
    parameter int unsigned NUM_SOURCES = 4,
    parameter int unsigned NUM_HARTS   = 1,
    parameter int unsigned NUM_IDS     = 63,
    parameter int unsigned PAGE_BYTES  = 4096,
    parameter int unsigned NUM_FILES   = 2,                 // S file + secure file
    parameter int unsigned NUM_FLAT    = NUM_HARTS * NUM_FILES,
    parameter int unsigned ID_W        = $clog2(NUM_IDS + 1),
    parameter int unsigned SRC_W       = $clog2(NUM_SOURCES + 1)
) (
    input  logic clk,
    input  logic rst_n,

    // Wired interrupt sources into the APLIC.
    input  logic [NUM_SOURCES-1:0] irq_sources,

    // APLIC config port.
    input  logic               cfg_we_i,
    input  logic               cfg_domain_i,
    input  logic [SRC_W-1:0]   cfg_src_i,
    input  logic [1:0]         cfg_field_i,
    input  logic [31:0]        cfg_wdata_i,

    // Raw device-MSI injection (bypasses the APLIC; models a device/IOMMU).
    input  logic               dev_we_i,
    input  logic [31:0]        dev_addr_i,
    input  logic [31:0]        dev_id_i,
    input  logic               dev_world_i,

    // IMSIC doorbell observation.
    output logic               msi_accept_o,
    output logic               msi_reject_o,

    // IMSIC CSR-side enable/threshold programming.
    input  logic [NUM_FLAT-1:0] eie_we_i,
    input  logic [ID_W-1:0]     eie_id_i,
    input  logic [NUM_FLAT-1:0] eie_val_i,
    input  logic [NUM_FLAT-1:0] thr_we_i,
    input  logic [ID_W-1:0]     thr_val_i,

    // IMSIC xtopei claim interface (flattened topei id per flat file).
    output logic [NUM_FLAT-1:0]              eip_any_o,
    output logic [NUM_FLAT*ID_W-1:0]         topei_id_flat_o,
    input  logic [NUM_FLAT-1:0]              topei_claim_i,
    output logic [NUM_FLAT-1:0]              irq_o
);
    // APLIC -> IMSIC MSI channel.
    logic        aplic_we;
    logic [31:0] aplic_addr;
    logic [31:0] aplic_id;
    logic        aplic_world;

    e1_aplic #(
        .NUM_SOURCES(NUM_SOURCES),
        .NUM_IDS(NUM_IDS),
        .NUM_TARGETS(NUM_FLAT),
        .IMSIC_PAGE_BYTES(PAGE_BYTES)
    ) u_aplic (
        .clk(clk),
        .rst_n(rst_n),
        .irq_sources(irq_sources),
        .cfg_we_i(cfg_we_i),
        .cfg_domain_i(cfg_domain_i),
        .cfg_src_i(cfg_src_i),
        .cfg_field_i(cfg_field_i),
        .cfg_wdata_i(cfg_wdata_i),
        .msi_we_o(aplic_we),
        .msi_addr_o(aplic_addr),
        .msi_id_o(aplic_id),
        .msi_world_o(aplic_world)
    );

    // Doorbell mux: a raw device write takes the channel when asserted, else
    // the APLIC-generated MSI drives it. (The KAT never asserts both at once.)
    wire        db_we    = dev_we_i ? 1'b1        : aplic_we;
    wire [31:0] db_addr  = dev_we_i ? dev_addr_i  : aplic_addr;
    wire [31:0] db_id    = dev_we_i ? dev_id_i    : aplic_id;
    wire        db_world = dev_we_i ? dev_world_i : aplic_world;

    // Per-file topei id, unflattened from the IMSIC then re-flattened to a bus.
    logic [ID_W-1:0] topei_id   [NUM_FLAT];
    logic [ID_W-1:0] topei_prio [NUM_FLAT];

    e1_imsic #(
        .NUM_HARTS(NUM_HARTS),
        .NUM_IDS(NUM_IDS),
        .NUM_GUESTS(0),
        .SECURE_FILE(1'b1),
        .PAGE_BYTES(PAGE_BYTES)
    ) u_imsic (
        .clk(clk),
        .rst_n(rst_n),
        .msi_we_i(db_we),
        .msi_addr_i(db_addr),
        .msi_id_i(db_id),
        .msi_world_i(db_world),
        .msi_accept_o(msi_accept_o),
        .msi_reject_o(msi_reject_o),
        .eip_any_o(eip_any_o),
        .topei_id_o(topei_id),
        .topei_prio_o(topei_prio),
        .topei_claim_i(topei_claim_i),
        .eie_we_i(eie_we_i),
        .eie_id_i(eie_id_i),
        .eie_val_i(eie_val_i),
        .thr_we_i(thr_we_i),
        .thr_val_i(thr_val_i),
        .irq_o(irq_o)
    );

    always_comb begin
        for (int unsigned f = 0; f < NUM_FLAT; f++)
            topei_id_flat_o[f*ID_W +: ID_W] = topei_id[f];
    end

    /* verilator lint_off UNUSEDSIGNAL */
    logic unused;
    /* verilator lint_on UNUSEDSIGNAL */
    assign unused = ^{topei_prio[0]};

endmodule : e1_aia_top
