`timescale 1ns/1ps

// e1_mmio_decode
//
// Address decode for the v0 32-bit MMIO debug aperture shared by e1_soc_top
// and e1_soc_integrated. Emits the select strobes both tops have in common
// (bootrom / peripherals / dma / npu / display / weight-buffer SRAM / CLINT /
// behavioural DRAM) plus the two qualifier signals (word_aligned,
// implemented_window). The integrated top layers its extra cross-domain
// selects (pmc / iommu / iommu_dma / slc) on top of these locally.
//
// Decode map (unchanged from the inlined logic in both tops except for the
// secure boot ROM aperture, which spans 64 KiB):
//   implemented_window = mmio_addr[11:8]==0 && word_aligned
//   bootrom @ 0x0000_xxxx   periph @ 0x1000_0xxx   dma @ 0x1001_0xxx
//   npu     @ 0x1002_0xxx   display @ 0x1003_0xxx  wbuf @ 0x1004_0xxx
//   clint   @ 0x0200_xxxx (mmio_addr[15:14]!=2'b11)
//   dram    @ 0x8000_0xxx

module e1_mmio_decode (
    input  logic [31:0] mmio_addr,
    output logic        word_aligned,
    output logic        implemented_window,
    output logic        bootrom_sel,
    output logic        periph_sel,
    output logic        dma_sel,
    output logic        npu_sel,
    output logic        display_sel,
    output logic        wbuf_sel,
    output logic        clint_sel,
    output logic        dram_sel
);
    assign word_aligned       = mmio_addr[1:0] == 2'b00;
    assign implemented_window = mmio_addr[11:8] == 4'h0 && word_aligned;
    assign bootrom_sel = word_aligned && mmio_addr[31:16] == 16'h0000;
    assign periph_sel  = implemented_window && mmio_addr[31:12] == 20'h1000_0;
    assign dma_sel     = implemented_window && mmio_addr[31:12] == 20'h1001_0;
    assign npu_sel     = implemented_window && mmio_addr[31:12] == 20'h1002_0;
    assign display_sel = implemented_window && mmio_addr[31:12] == 20'h1003_0;
    assign wbuf_sel    = word_aligned && mmio_addr[31:12] == 20'h1004_0;
    assign clint_sel   = word_aligned && mmio_addr[31:16] == 16'h0200 &&
                         mmio_addr[15:14] != 2'b11;
    assign dram_sel    = word_aligned && mmio_addr[31:12] == 20'h8000_0;

endmodule : e1_mmio_decode
