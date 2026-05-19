`timescale 1ns/1ps

// e1_axi4_pkg
//
// Local AXI4 constants and helper types used by the burst-capable interconnect,
// CHI bridge, IOMMU, and DRAM controller RTL.  Keep this file self-contained:
// no upstream package imports.  Constants follow the AMBA AXI4 specification
// (IHI 0022) and the RISC-V IOMMU v1.0.1 architecture document.

package e1_axi4_pkg;

    // ------------------------------------------------------------------
    // AXI4 burst types
    // ------------------------------------------------------------------
    localparam logic [1:0] BURST_FIXED = 2'b00;
    localparam logic [1:0] BURST_INCR  = 2'b01;
    localparam logic [1:0] BURST_WRAP  = 2'b10;

    // ------------------------------------------------------------------
    // AXI4 response codes
    // ------------------------------------------------------------------
    localparam logic [1:0] RESP_OKAY   = 2'b00;
    localparam logic [1:0] RESP_EXOKAY = 2'b01;  // exclusive access success
    localparam logic [1:0] RESP_SLVERR = 2'b10;
    localparam logic [1:0] RESP_DECERR = 2'b11;

    // ------------------------------------------------------------------
    // AxSIZE encodings (bytes per beat = 1 << size)
    // ------------------------------------------------------------------
    localparam logic [2:0] SIZE_1B   = 3'b000;
    localparam logic [2:0] SIZE_2B   = 3'b001;
    localparam logic [2:0] SIZE_4B   = 3'b010;
    localparam logic [2:0] SIZE_8B   = 3'b011;
    localparam logic [2:0] SIZE_16B  = 3'b100;
    localparam logic [2:0] SIZE_32B  = 3'b101;
    localparam logic [2:0] SIZE_64B  = 3'b110;
    localparam logic [2:0] SIZE_128B = 3'b111;

    // ------------------------------------------------------------------
    // ARCACHE/AWCACHE bit layout
    //
    //   [3] Other Allocate   (write-allocate / read-allocate hint to far end)
    //   [2] Allocate         (allocate hint at this point)
    //   [1] Modifiable       (transaction attributes may be modified)
    //   [0] Bufferable       (response can come from intermediate buffer)
    //
    // Common combinations used by mobile SoCs:
    //   0010 device non-bufferable
    //   0011 device bufferable
    //   1110 write-back, read-allocate
    //   1111 write-back, read+write allocate
    // ------------------------------------------------------------------
    localparam logic [3:0] CACHE_DEVICE_NON_BUFFERABLE = 4'b0000;
    localparam logic [3:0] CACHE_DEVICE_BUFFERABLE     = 4'b0001;
    localparam logic [3:0] CACHE_NORMAL_NON_CACHEABLE  = 4'b0010;
    localparam logic [3:0] CACHE_WRITE_THROUGH_RW      = 4'b1010;
    localparam logic [3:0] CACHE_WRITE_BACK_RW         = 4'b1111;

    // ------------------------------------------------------------------
    // AxPROT bit layout
    //   [0] Privileged  (1: privileged)
    //   [1] Non-secure  (1: non-secure / 0: secure)
    //   [2] Instruction (1: I-fetch / 0: data)
    // ------------------------------------------------------------------
    localparam logic [2:0] PROT_DATA_NS_UNPRIV = 3'b010;
    localparam logic [2:0] PROT_DATA_NS_PRIV   = 3'b011;
    localparam logic [2:0] PROT_DATA_S_PRIV    = 3'b001;
    localparam logic [2:0] PROT_INSN_NS_PRIV   = 3'b111;

    // ------------------------------------------------------------------
    // AXI4 QoS class assignments for the 2028 phone AP NoC.
    // Higher numeric value wins arbitration at the system memory controller.
    // ------------------------------------------------------------------
    localparam logic [3:0] QOS_DISPLAY_RT      = 4'd15;  // hard real-time scanout
    localparam logic [3:0] QOS_CAMERA_ISP_RT   = 4'd13;
    localparam logic [3:0] QOS_CPU_LATENCY     = 4'd11;
    localparam logic [3:0] QOS_NPU_INFERENCE   = 4'd8;
    localparam logic [3:0] QOS_GPU_RENDER      = 4'd6;
    localparam logic [3:0] QOS_DMA_BULK        = 4'd2;
    localparam logic [3:0] QOS_DEBUG_TRACE     = 4'd0;

    // ------------------------------------------------------------------
    // Maximum legal AXI4 burst length is 256 beats for INCR and 16 beats
    // for FIXED/WRAP.  The interconnect treats AWLEN/ARLEN as the
    // AXI3-compatible 4-bit subset by default and exposes the upper four
    // bits as a parameter, which keeps verification deterministic.
    // ------------------------------------------------------------------
    localparam int unsigned MAX_BURST_LEN_INCR     = 256;
    localparam int unsigned MAX_BURST_LEN_FIXED    = 16;
    localparam int unsigned MAX_BURST_LEN_WRAP     = 16;

endpackage
