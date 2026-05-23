`timescale 1ns/1ps

module e1_npu (
    input  logic        clk,
    input  logic        rst_n,
    input  logic        valid,
    input  logic        write,
    input  logic [5:0]  addr,
    input  logic [31:0] wdata,
    output logic [31:0] rdata,
    output logic        irq,

    output logic        m_axil_awvalid,
    input  logic        m_axil_awready,
    output logic [31:0] m_axil_awaddr,
    output logic        m_axil_wvalid,
    input  logic        m_axil_wready,
    output logic [31:0] m_axil_wdata,
    output logic [3:0]  m_axil_wstrb,
    input  logic        m_axil_bvalid,
    output logic        m_axil_bready,
    input  logic [1:0]  m_axil_bresp,
    output logic        m_axil_arvalid,
    input  logic        m_axil_arready,
    output logic [31:0] m_axil_araddr,
    input  logic        m_axil_rvalid,
    output logic        m_axil_rready,
    input  logic [31:0] m_axil_rdata,
    input  logic [1:0]  m_axil_rresp
`ifdef E1_NPU_SECURE_SIDEBAND
    ,
    // The port group is `ifdef`-guarded (mirroring USE_POWER_PINS in
    // e1_npu_weight_buffer_array.sv) so the secure-I/O integration RTL, the
    // confidential-I/O cocotb test, and the npu-accelerator gate opt in by
    // defining E1_NPU_SECURE_SIDEBAND, while the current e1_soc_top
    // instantiation — not yet re-homed onto an IOMMU upstream port (the open
    // RTL item in S6.x) — keeps a valid pin list with these ports absent.
    // Confidential-I/O sideband (docs/security/tee-plan/03-secure-io-iommu-npu.md
    // S4.2.3). Every NPU DRAM access carries a stable per-master source ID and
    // the owning confidential-domain ID out-of-band so the RISC-V IOMMU
    // (rtl/iommu/e1_riscv_iommu.sv ar_devid/aw_devid) and the IOPMP
    // (rtl/iommu/e1_iopmp.sv source-ID-gated R/W/X table) can police it. The
    // source ID is a fixed hardware constant; the domain ID is the monitor-
    // programmed current owner. These are the SAME constant on AR and AW
    // because a single master issues both.
    output logic [23:0] m_axil_arsource,   // -> IOMMU ar_devid
    output logic [23:0] m_axil_awsource,   // -> IOMMU aw_devid
    output logic [19:0] m_axil_ardomain,   // -> IOMMU ar_pasid (owning domain)
    output logic [19:0] m_axil_awdomain,   // -> IOMMU aw_pasid
    output logic        m_axil_secure,     // -> IOPMP secure-transaction qualifier
    // Current ownership state for the confidential-domain monitor / IOMMU DC
    // installer to observe (S4.3 ownership state machine).
    output logic [19:0] npu_owner_domain,
    output logic        npu_owned
`endif
);
    localparam logic [3:0] OP_ADD      = 4'h0;
    localparam logic [3:0] OP_SUB      = 4'h1;
    localparam logic [3:0] OP_MUL_LO   = 4'h2;
    localparam logic [3:0] OP_MAC_S16  = 4'h3;
    localparam logic [3:0] OP_DOT4_S8  = 4'h4;
    localparam logic [3:0] OP_MAX_U32  = 4'h5;
    localparam logic [3:0] OP_MIN_U32  = 4'h6;
    localparam logic [3:0] OP_DOT8_S4  = 4'h7;
    localparam logic [3:0] OP_GEMM_S8  = 4'h8;
    localparam logic [3:0] OP_GEMM_S4  = 4'h9;
    localparam logic [3:0] OP_RELU4_S8 = 4'ha;
    localparam logic [3:0] OP_VRELU_S8 = 4'hb;
    localparam logic [3:0] OP_SDOT4_S4_2_4 = 4'hc;
    localparam logic [3:0] OP_DOT16_S2 = 4'hd;
    localparam logic [3:0] OP_DOT4_FP8_E4M3 = 4'he;
    localparam logic [3:0] OP_EXP2_NEG_Q0_8 = 4'hf;

    // Fixed hardware source ID for the NPU master. The confidential-domain
    // monitor binds this ID to a device context (DC) in the IOMMU DDT and to a
    // locked IOPMP region set (docs/security/tee-plan/03-secure-io-iommu-npu.md
    // S1.2, S4.2.3). It is a build-time constant so the IOMMU/IOPMP policy can
    // reference it independent of the descriptor contents the host programs.
    localparam logic [23:0] NPU_SOURCE_ID = 24'h00_0004;

    localparam int unsigned SCRATCH_WORDS = 16;
    localparam int unsigned DESC_WORDS = 4;
    /* verilator lint_off UNUSEDPARAM */
    localparam logic [31:0] DESC_TIMEOUT_LIMIT = 32'd128;

    localparam logic [3:0] DESC_IDLE        = 4'd0;
    localparam logic [3:0] DESC_FETCH_ADDR  = 4'd1;
    localparam logic [3:0] DESC_FETCH_DATA  = 4'd2;
    localparam logic [3:0] DESC_STREAM_ADDR = 4'd3;
    localparam logic [3:0] DESC_STREAM_DATA = 4'd4;
    localparam logic [3:0] DESC_LAUNCH      = 4'd5;
    localparam logic [3:0] DESC_WAIT        = 4'd6;
    localparam logic [3:0] DESC_WRITE_ADDR  = 4'd7;
    localparam logic [3:0] DESC_WRITE_RESP  = 4'd8;
    localparam logic [3:0] DESC_ADVANCE     = 4'd9;
    /* verilator lint_on UNUSEDPARAM */

    logic [31:0] op_a;
    logic [31:0] op_b;
    logic [31:0] acc;
    logic [3:0]  opcode;
    logic [31:0] result;
    logic [31:0] result_hi;
    logic [31:0] status;
    logic [2:0]  busy_count;
    logic [31:0] op_a_q;
    logic [31:0] op_b_q;
    logic [31:0] acc_q;
    logic [3:0]  opcode_q;
    logic        dot16_ternary_mode_q;
    logic [63:0] datapath_wide;
    logic signed [31:0] mac_s16_sum;
    logic signed [31:0] dot4_s8_sum;
    logic signed [31:0] dot8_s4_sum;
    logic signed [31:0] sdot4_s4_2_4_sum;
    logic signed [31:0] dot16_s2_sum;
    logic signed [31:0] dot16_ternary_sum;
    logic        dot16_ternary_invalid;
    logic signed [31:0] dot4_fp8_e4m3_sum;

    logic [31:0] scratch [0:SCRATCH_WORDS-1];
    logic [1:0]  gemm_m;
    logic [1:0]  gemm_n;
    logic [2:0]  gemm_k;
    logic [5:0]  gemm_a_base;
    logic [5:0]  gemm_b_base;
    logic [5:0]  gemm_c_base;
    logic [3:0]  gemm_a_stride;
    logic [3:0]  gemm_b_stride;
    logic [3:0]  gemm_c_stride;
    logic [1:0]  gemm_i;
    logic [1:0]  gemm_j;
    logic [2:0]  gemm_l;
    logic signed [31:0] gemm_acc;
    logic        gemm_s4_mode;
    logic [5:0]  vec_len;
    logic [5:0]  vec_src_base;
    logic [5:0]  vec_dst_base;
    logic [5:0]  vec_i;
    logic [31:0] perf_cycles;
    logic [31:0] perf_macs;
    logic [31:0] perf_errors;
    logic [31:0] perf_ops;
    logic [31:0] perf_unsupported_ops;
    logic [31:0] cmd_param;
    logic [31:0] desc_base;
    logic [2:0]  desc_head;
    logic [2:0]  desc_tail;
    logic [2:0]  desc_err_index;
    logic [31:0] desc_status;
    logic [2:0]  desc_pending;
    logic        desc_busy;
    logic [3:0]  desc_state;
    logic [1:0]  desc_fetch_word;
    logic [31:0] desc_words [0:DESC_WORDS-1];
    logic [31:0] desc_timeout_count;
    logic [31:0] desc_bytes_read;
    logic [31:0] desc_bytes_written;
    logic [31:0] desc_read_beats;
    logic [31:0] desc_write_beats;
    logic [31:0] perf_stall_cycles;
    logic [31:0] perf_scratch_bytes;
    logic [31:0] perf_thermal_throttle;
    logic [31:0] desc_current_addr;
    logic [5:0]  desc_stream_done;
    logic [5:0]  desc_write_done;
    logic [2:0]  desc_tail_next;
    logic        gemm_busy;
    logic        vec_busy;

    // Confidential-I/O ownership + perf-counter lockdown state
    // (docs/security/tee-plan/03-secure-io-iommu-npu.md S4.2.2/4.2.5/4.3).
    //   sec_owned       : NPU assigned to a confidential domain (owned-private).
    //   sec_owner       : 20-bit owning domain ID (monitor-programmed).
    //   sec_lock        : sticky monitor-programming lock; once set, the owner/
    //                     domain and perf-lock policy cannot be changed by the
    //                     host until reset (revoke happens only on reset/scrub).
    //   sec_perf_lock   : when owned-private, PERF_* register reads return 0 to
    //                     the host register port so inference timing/MAC counts
    //                     are not a side channel; the monitor reads counters via
    //                     a privileged path that is out of scope for this MMIO.
    logic        sec_owned;
    logic [19:0] sec_owner;
    logic        sec_lock;
    logic        sec_perf_lock;
    logic        perf_hidden;

    logic [7:0] gemm_a_addr;
    logic [7:0] gemm_b_addr;
    logic [7:0] gemm_c_addr;
    logic gemm_cfg_ok;
    logic gemm_active_s4;
    logic signed [7:0] gemm_a_value;
    logic signed [7:0] gemm_b_value;
    logic [3:0] desc_opcode;
    logic       desc_valid;
    logic       desc_writeback_enable;
    logic       desc_stream_enable;
    logic [5:0] desc_stream_dst;
    logic [5:0] desc_stream_len;
    logic [3:0] desc_stream_word_addr;
    logic       desc_stream_cfg_ok;
    logic       desc_scalar_done;
    logic       desc_gemm_done;
    logic       desc_vector_done;
    logic       desc_engine_done;
    logic [5:0] desc_write_src;
    logic [5:0] desc_write_len;
    logic [3:0] desc_write_word_addr;
    logic       desc_writeback_cfg_ok;
    logic [5:0] vec_src_addr;
    logic [5:0] vec_dst_addr;
    logic       vec_cfg_ok;

    function automatic logic signed [31:0] sx8(input logic [7:0] value);
        sx8 = {{24{value[7]}}, value};
    endfunction

    function automatic logic signed [31:0] sx4(input logic [3:0] value);
        sx4 = {{28{value[3]}}, value};
    endfunction

    function automatic logic signed [31:0] sx2(input logic [1:0] value);
        sx2 = {{30{value[1]}}, value};
    endfunction

    function automatic logic signed [31:0] sx16(input logic [15:0] value);
        sx16 = {{16{value[15]}}, value};
    endfunction

    function automatic logic [7:0] relu_s8(input logic [7:0] value);
        relu_s8 = value[7] ? 8'h00 : value;
    endfunction

    function automatic logic [7:0] scratch_read_byte(input logic [5:0] byte_addr);
        unique case (byte_addr[1:0])
            2'd0: scratch_read_byte = scratch[byte_addr[5:2]][7:0];
            2'd1: scratch_read_byte = scratch[byte_addr[5:2]][15:8];
            2'd2: scratch_read_byte = scratch[byte_addr[5:2]][23:16];
            default: scratch_read_byte = scratch[byte_addr[5:2]][31:24];
        endcase
    endfunction

    function automatic logic signed [7:0] scratch_read_s4(input logic [6:0] nibble_addr);
        logic [7:0] byte_value;
        byte_value = scratch_read_byte(nibble_addr[6:1]);
        if (nibble_addr[0]) begin
            scratch_read_s4 = {{4{byte_value[7]}}, byte_value[7:4]};
        end else begin
            scratch_read_s4 = {{4{byte_value[3]}}, byte_value[3:0]};
        end
    endfunction

    function automatic logic signed [31:0] s4_lane(input logic [31:0] word, input logic [2:0] lane);
        unique case (lane)
            3'd0: s4_lane = sx4(word[3:0]);
            3'd1: s4_lane = sx4(word[7:4]);
            3'd2: s4_lane = sx4(word[11:8]);
            3'd3: s4_lane = sx4(word[15:12]);
            3'd4: s4_lane = sx4(word[19:16]);
            3'd5: s4_lane = sx4(word[23:20]);
            3'd6: s4_lane = sx4(word[27:24]);
            default: s4_lane = sx4(word[31:28]);
        endcase
    endfunction

    function automatic logic signed [31:0] s2_lane(input logic [31:0] word, input logic [3:0] lane);
        unique case (lane)
            4'd0: s2_lane = sx2(word[1:0]);
            4'd1: s2_lane = sx2(word[3:2]);
            4'd2: s2_lane = sx2(word[5:4]);
            4'd3: s2_lane = sx2(word[7:6]);
            4'd4: s2_lane = sx2(word[9:8]);
            4'd5: s2_lane = sx2(word[11:10]);
            4'd6: s2_lane = sx2(word[13:12]);
            4'd7: s2_lane = sx2(word[15:14]);
            4'd8: s2_lane = sx2(word[17:16]);
            4'd9: s2_lane = sx2(word[19:18]);
            4'd10: s2_lane = sx2(word[21:20]);
            4'd11: s2_lane = sx2(word[23:22]);
            4'd12: s2_lane = sx2(word[25:24]);
            4'd13: s2_lane = sx2(word[27:26]);
            4'd14: s2_lane = sx2(word[29:28]);
            default: s2_lane = sx2(word[31:30]);
        endcase
    endfunction

    // Decode a ternary 2-bit lane as 00=0, 01=+1, 10=-1. Reserved encoding
    // 11 is rejected by dot16_ternary_invalid and never reaches this path.
    function automatic logic signed [31:0] t2_lane(input logic [31:0] word, input logic [3:0] lane);
        logic [1:0] raw;
        unique case (lane)
            4'd0:  raw = word[1:0];
            4'd1:  raw = word[3:2];
            4'd2:  raw = word[5:4];
            4'd3:  raw = word[7:6];
            4'd4:  raw = word[9:8];
            4'd5:  raw = word[11:10];
            4'd6:  raw = word[13:12];
            4'd7:  raw = word[15:14];
            4'd8:  raw = word[17:16];
            4'd9:  raw = word[19:18];
            4'd10: raw = word[21:20];
            4'd11: raw = word[23:22];
            4'd12: raw = word[25:24];
            4'd13: raw = word[27:26];
            4'd14: raw = word[29:28];
            default: raw = word[31:30];
        endcase
        unique case (raw)
            2'b00:  t2_lane = 32'sd0;
            2'b01:  t2_lane = 32'sd1;
            2'b10:  t2_lane = -32'sd1;
            default: t2_lane = 32'sd0;
        endcase
    endfunction

    // 16-lane reduce-OR over (a[i+1:i] == 2'b11) | (b[i+1:i] == 2'b11).
    function automatic logic ternary_reserved_present(
        input logic [31:0] word_a,
        input logic [31:0] word_b
    );
        logic flag;
        flag = 1'b0;
        for (int unsigned lane = 0; lane < 16; lane++) begin
            if (word_a[(lane*2) +: 2] == 2'b11) flag = 1'b1;
            if (word_b[(lane*2) +: 2] == 2'b11) flag = 1'b1;
        end
        ternary_reserved_present = flag;
    endfunction

    function automatic logic signed [31:0] fp8_e4m3_to_q8_8(input logic [7:0] value);
        logic [3:0] exp;
        logic [2:0] mant;
        logic [31:0] abs_q;
        exp = value[6:3];
        mant = value[2:0];
        if (exp == 4'h0) begin
            abs_q = {29'h0, mant} >> 1;
        end else if (exp >= 4'd2) begin
            abs_q = {28'h0, 1'b1, mant} << (exp - 4'd2);
        end else begin
            abs_q = {28'h0, 1'b1, mant} >> 1;
        end
        fp8_e4m3_to_q8_8 = value[7] ? -$signed(abs_q) : $signed(abs_q);
    endfunction

    function automatic logic [31:0] exp2_neg_q0_8(input logic [7:0] value);
        logic signed [7:0] delta;
        logic [7:0] magnitude;
        logic [3:0] shift;
        delta = value;
        if (delta > 0) begin
            magnitude = 8'd0;
        end else begin
            magnitude = $unsigned(-delta);
        end
        shift = (magnitude > 8'd8) ? 4'd8 : magnitude[3:0];
        exp2_neg_q0_8 = 32'd256 >> shift;
    endfunction

    task automatic scratch_write_word(input logic [3:0] word_addr, input logic [31:0] value);
        scratch[word_addr] <= value;
    endtask

    task automatic scratch_write_i32(input logic [3:0] word_addr, input logic [31:0] value);
        scratch[word_addr] <= value;
    endtask

    task automatic scratch_stream_write_word(input logic [3:0] word_addr, input logic [31:0] value);
        scratch[word_addr] <= value;
    endtask

    task automatic scratch_write_byte(input logic [5:0] byte_addr, input logic [7:0] value);
        unique case (byte_addr[1:0])
            2'd0: scratch[byte_addr[5:2]][7:0] <= value;
            2'd1: scratch[byte_addr[5:2]][15:8] <= value;
            2'd2: scratch[byte_addr[5:2]][23:16] <= value;
            default: scratch[byte_addr[5:2]][31:24] <= value;
        endcase
    endtask

    function automatic logic [2:0] opcode_latency(input logic [3:0] op);
        unique case (op)
            OP_MUL_LO:  opcode_latency = 3'd2;
            OP_MAC_S16: opcode_latency = 3'd2;
            OP_DOT4_S8: opcode_latency = 3'd3;
            OP_DOT8_S4: opcode_latency = 3'd3;
            OP_SDOT4_S4_2_4: opcode_latency = 3'd3;
            OP_DOT16_S2: opcode_latency = 3'd3;
            OP_DOT4_FP8_E4M3: opcode_latency = 3'd3;
            OP_EXP2_NEG_Q0_8: opcode_latency = 3'd2;
            default:    opcode_latency = 3'd1;
        endcase
    endfunction

    function automatic logic opcode_valid(input logic [3:0] op);
        unique case (op)
            OP_ADD, OP_SUB, OP_MUL_LO, OP_MAC_S16, OP_DOT4_S8, OP_MAX_U32, OP_MIN_U32, OP_DOT8_S4, OP_GEMM_S8, OP_GEMM_S4, OP_RELU4_S8, OP_VRELU_S8, OP_SDOT4_S4_2_4, OP_DOT16_S2, OP_DOT4_FP8_E4M3, OP_EXP2_NEG_Q0_8: opcode_valid = 1'b1;
            default: opcode_valid = 1'b0;
        endcase
    endfunction

    function automatic logic opcode_is_gemm(input logic [3:0] op);
        unique case (op)
            OP_GEMM_S8, OP_GEMM_S4: opcode_is_gemm = 1'b1;
            default: opcode_is_gemm = 1'b0;
        endcase
    endfunction

    function automatic logic opcode_is_vector(input logic [3:0] op);
        unique case (op)
            OP_VRELU_S8: opcode_is_vector = 1'b1;
            default: opcode_is_vector = 1'b0;
        endcase
    endfunction

    assign irq = status[1];

    // Confidential-I/O sideband: every outbound NPU AXI access is tagged with
    // the fixed source ID and the active owning-domain ID, and marked secure
    // when the NPU is owned-private. The IOMMU/IOPMP consume these to confine
    // descriptor/tensor traffic to the owner's device-assigned private pages.
`ifdef E1_NPU_SECURE_SIDEBAND
    // Active owning-domain tag carried on every outbound access; 0 when unowned.
    logic [19:0] active_domain;
    assign active_domain   = sec_owned ? sec_owner : 20'h0;
    assign m_axil_arsource = NPU_SOURCE_ID;
    assign m_axil_awsource = NPU_SOURCE_ID;
    assign m_axil_ardomain = active_domain;
    assign m_axil_awdomain = active_domain;
    assign m_axil_secure   = sec_owned;
    assign npu_owner_domain = sec_owner;
    assign npu_owned        = sec_owned;
`endif

    // Perf-counter lockdown: hide PERF_* from the host register port when the
    // NPU is owned-private and the monitor has armed the perf lock.
    assign perf_hidden = sec_owned && sec_perf_lock;

    assign desc_pending = desc_head - desc_tail;
    assign desc_opcode = desc_words[0][3:0];
    assign desc_valid = desc_words[0][31];
    assign desc_writeback_enable = desc_words[0][30];
    assign desc_stream_enable = desc_words[0][8];
    assign desc_stream_dst = desc_words[0][21:16];
    assign desc_stream_len = desc_words[0][29:24];
    assign desc_stream_word_addr = desc_stream_dst[5:2] + desc_stream_done[5:2];
    assign desc_tail_next = desc_tail + 3'd1;
    assign desc_stream_cfg_ok = (!desc_stream_enable) ||
                                ((desc_words[1][1:0] == 2'b00) &&
                                 (desc_stream_dst[1:0] == 2'b00) &&
                                 (desc_stream_len != 6'h0) &&
                                 (desc_stream_len[1:0] == 2'b00) &&
                                 (({2'b00, desc_stream_dst} + {2'b00, desc_stream_len}) <= 8'd64));
    assign desc_scalar_done = (!opcode_is_gemm(desc_opcode)) && (!opcode_is_vector(desc_opcode)) && (busy_count == 3'h1);
    assign desc_gemm_done = opcode_is_gemm(desc_opcode) && gemm_busy && gemm_cfg_ok &&
                            (gemm_l == gemm_k - 3'd1) &&
                            (gemm_j == gemm_n - 2'd1) &&
                            (gemm_i == gemm_m - 2'd1);
    assign desc_vector_done = opcode_is_vector(desc_opcode) && vec_busy && vec_cfg_ok &&
                              (vec_i == vec_len - 6'd1);
    assign desc_engine_done = desc_scalar_done || desc_gemm_done || desc_vector_done;
    assign desc_current_addr = desc_base + {25'h0, desc_tail, 4'h0} + {28'h0, desc_fetch_word, 2'b00};
    assign m_axil_arvalid = status[0] && desc_busy &&
                            ((desc_state == DESC_FETCH_ADDR) || (desc_state == DESC_STREAM_ADDR));
    assign m_axil_araddr = (desc_state == DESC_STREAM_ADDR) ?
                           (desc_words[1] + {26'h0, desc_stream_done}) :
                           desc_current_addr;
    assign m_axil_rready = status[0] && desc_busy &&
                           ((desc_state == DESC_FETCH_DATA) || (desc_state == DESC_STREAM_DATA));
    assign desc_write_src = opcode_is_gemm(desc_opcode) ? gemm_c_base : vec_dst_base;
    assign desc_write_len = opcode_is_gemm(desc_opcode) ?
                            ({2'b00, gemm_m} * {2'b00, gemm_n} * 6'd4) :
                            vec_len;
    assign desc_write_word_addr = desc_write_src[5:2] + desc_write_done[5:2];
    assign desc_writeback_cfg_ok = (!desc_writeback_enable) ||
                                   ((desc_words[2][1:0] == 2'b00) &&
                                    opcode_is_gemm(desc_opcode) &&
                                    (({2'b00, desc_write_src} + {2'b00, desc_write_len}) <= 8'd64) &&
                                    (desc_write_len != 6'h0) &&
                                    (desc_write_len[1:0] == 2'b00));
    assign m_axil_awvalid = status[0] && desc_busy && (desc_state == DESC_WRITE_ADDR);
    assign m_axil_awaddr = desc_words[2] + {26'h0, desc_write_done};
    assign m_axil_wvalid = status[0] && desc_busy && (desc_state == DESC_WRITE_ADDR);
    assign m_axil_wdata = scratch[desc_write_word_addr];
    assign m_axil_wstrb = 4'hf;
    assign m_axil_bready = status[0] && desc_busy && (desc_state == DESC_WRITE_RESP);
    assign gemm_a_addr = {2'h0, gemm_a_base} + ({6'h0, gemm_i} * {4'h0, gemm_a_stride}) + {5'h0, gemm_l};
    assign gemm_b_addr = {2'h0, gemm_b_base} + ({5'h0, gemm_l} * {4'h0, gemm_b_stride}) + {6'h0, gemm_j};
    assign gemm_c_addr = {2'h0, gemm_c_base} + ({6'h0, gemm_i} * {4'h0, gemm_c_stride}) + {4'h0, gemm_j, 2'b00};
    assign gemm_active_s4 = gemm_busy ? gemm_s4_mode :
                            (desc_busy ? (desc_opcode == OP_GEMM_S4) : (opcode == OP_GEMM_S4));
    assign gemm_cfg_ok = (gemm_m != 2'h0) && (gemm_n != 2'h0) && (gemm_k != 3'h0) &&
                         (gemm_active_s4 ? ((gemm_a_addr < 8'd128) && (gemm_b_addr < 8'd128)) :
                                           ((gemm_a_addr < 8'd64) && (gemm_b_addr < 8'd64))) &&
                         ((gemm_c_addr + 8'd3) < 8'd64) && (gemm_c_addr[1:0] == 2'b00);
    assign gemm_a_value = gemm_active_s4 ? scratch_read_s4(gemm_a_addr[6:0]) : scratch_read_byte(gemm_a_addr[5:0]);
    assign gemm_b_value = gemm_active_s4 ? scratch_read_s4(gemm_b_addr[6:0]) : scratch_read_byte(gemm_b_addr[5:0]);
    assign vec_src_addr = vec_src_base + vec_i;
    assign vec_dst_addr = vec_dst_base + vec_i;
    assign vec_cfg_ok = (vec_len != 6'h0) &&
                        (({2'b00, vec_src_base} + {2'b00, vec_len}) <= 8'd64) &&
                        (({2'b00, vec_dst_base} + {2'b00, vec_len}) <= 8'd64);

    always_comb begin
        mac_s16_sum = sx16(op_a_q[15:0]) * sx16(op_b_q[15:0]) + $signed(acc_q);
        dot4_s8_sum =
            (sx8(op_a_q[7:0])   * sx8(op_b_q[7:0]))   +
            (sx8(op_a_q[15:8])  * sx8(op_b_q[15:8]))  +
            (sx8(op_a_q[23:16]) * sx8(op_b_q[23:16])) +
            (sx8(op_a_q[31:24]) * sx8(op_b_q[31:24])) +
            $signed(acc_q);
        dot8_s4_sum =
            (sx4(op_a_q[3:0])   * sx4(op_b_q[3:0]))   +
            (sx4(op_a_q[7:4])   * sx4(op_b_q[7:4]))   +
            (sx4(op_a_q[11:8])  * sx4(op_b_q[11:8]))  +
            (sx4(op_a_q[15:12]) * sx4(op_b_q[15:12])) +
            (sx4(op_a_q[19:16]) * sx4(op_b_q[19:16])) +
            (sx4(op_a_q[23:20]) * sx4(op_b_q[23:20])) +
            (sx4(op_a_q[27:24]) * sx4(op_b_q[27:24])) +
            (sx4(op_a_q[31:28]) * sx4(op_b_q[31:28])) +
            $signed(acc_q);
        sdot4_s4_2_4_sum =
            (s4_lane(op_a_q, 3'd0) * s4_lane(op_b_q, {1'b0, acc_q[1:0]})) +
            (s4_lane(op_a_q, 3'd1) * s4_lane(op_b_q, {1'b0, acc_q[3:2]})) +
            (s4_lane(op_a_q, 3'd2) * s4_lane(op_b_q, {1'b1, acc_q[5:4]})) +
            (s4_lane(op_a_q, 3'd3) * s4_lane(op_b_q, {1'b1, acc_q[7:6]}));
        dot16_s2_sum =
            (s2_lane(op_a_q, 4'd0) * s2_lane(op_b_q, 4'd0)) +
            (s2_lane(op_a_q, 4'd1) * s2_lane(op_b_q, 4'd1)) +
            (s2_lane(op_a_q, 4'd2) * s2_lane(op_b_q, 4'd2)) +
            (s2_lane(op_a_q, 4'd3) * s2_lane(op_b_q, 4'd3)) +
            (s2_lane(op_a_q, 4'd4) * s2_lane(op_b_q, 4'd4)) +
            (s2_lane(op_a_q, 4'd5) * s2_lane(op_b_q, 4'd5)) +
            (s2_lane(op_a_q, 4'd6) * s2_lane(op_b_q, 4'd6)) +
            (s2_lane(op_a_q, 4'd7) * s2_lane(op_b_q, 4'd7)) +
            (s2_lane(op_a_q, 4'd8) * s2_lane(op_b_q, 4'd8)) +
            (s2_lane(op_a_q, 4'd9) * s2_lane(op_b_q, 4'd9)) +
            (s2_lane(op_a_q, 4'd10) * s2_lane(op_b_q, 4'd10)) +
            (s2_lane(op_a_q, 4'd11) * s2_lane(op_b_q, 4'd11)) +
            (s2_lane(op_a_q, 4'd12) * s2_lane(op_b_q, 4'd12)) +
            (s2_lane(op_a_q, 4'd13) * s2_lane(op_b_q, 4'd13)) +
            (s2_lane(op_a_q, 4'd14) * s2_lane(op_b_q, 4'd14)) +
            (s2_lane(op_a_q, 4'd15) * s2_lane(op_b_q, 4'd15)) +
            $signed(acc_q);
        dot16_ternary_sum =
            (t2_lane(op_a_q, 4'd0) * t2_lane(op_b_q, 4'd0)) +
            (t2_lane(op_a_q, 4'd1) * t2_lane(op_b_q, 4'd1)) +
            (t2_lane(op_a_q, 4'd2) * t2_lane(op_b_q, 4'd2)) +
            (t2_lane(op_a_q, 4'd3) * t2_lane(op_b_q, 4'd3)) +
            (t2_lane(op_a_q, 4'd4) * t2_lane(op_b_q, 4'd4)) +
            (t2_lane(op_a_q, 4'd5) * t2_lane(op_b_q, 4'd5)) +
            (t2_lane(op_a_q, 4'd6) * t2_lane(op_b_q, 4'd6)) +
            (t2_lane(op_a_q, 4'd7) * t2_lane(op_b_q, 4'd7)) +
            (t2_lane(op_a_q, 4'd8) * t2_lane(op_b_q, 4'd8)) +
            (t2_lane(op_a_q, 4'd9) * t2_lane(op_b_q, 4'd9)) +
            (t2_lane(op_a_q, 4'd10) * t2_lane(op_b_q, 4'd10)) +
            (t2_lane(op_a_q, 4'd11) * t2_lane(op_b_q, 4'd11)) +
            (t2_lane(op_a_q, 4'd12) * t2_lane(op_b_q, 4'd12)) +
            (t2_lane(op_a_q, 4'd13) * t2_lane(op_b_q, 4'd13)) +
            (t2_lane(op_a_q, 4'd14) * t2_lane(op_b_q, 4'd14)) +
            (t2_lane(op_a_q, 4'd15) * t2_lane(op_b_q, 4'd15)) +
            $signed(acc_q);
        dot16_ternary_invalid = ternary_reserved_present(op_a_q, op_b_q);
        dot4_fp8_e4m3_sum =
            ((fp8_e4m3_to_q8_8(op_a_q[7:0]) * fp8_e4m3_to_q8_8(op_b_q[7:0])) >>> 8) +
            ((fp8_e4m3_to_q8_8(op_a_q[15:8]) * fp8_e4m3_to_q8_8(op_b_q[15:8])) >>> 8) +
            ((fp8_e4m3_to_q8_8(op_a_q[23:16]) * fp8_e4m3_to_q8_8(op_b_q[23:16])) >>> 8) +
            ((fp8_e4m3_to_q8_8(op_a_q[31:24]) * fp8_e4m3_to_q8_8(op_b_q[31:24])) >>> 8) +
            $signed(acc_q);

        unique case (opcode_q)
            OP_ADD:     datapath_wide = {32'h0, op_a_q + op_b_q};
            OP_SUB:     datapath_wide = {32'h0, op_a_q - op_b_q};
            OP_MUL_LO:  datapath_wide = {32'h0, op_a_q} * {32'h0, op_b_q};
            OP_MAC_S16: datapath_wide = {{32{mac_s16_sum[31]}}, mac_s16_sum};
            OP_DOT4_S8: datapath_wide = {{32{dot4_s8_sum[31]}}, dot4_s8_sum};
            OP_MAX_U32: datapath_wide = {32'h0, (op_a_q > op_b_q) ? op_a_q : op_b_q};
            OP_MIN_U32: datapath_wide = {32'h0, (op_a_q < op_b_q) ? op_a_q : op_b_q};
            OP_DOT8_S4: datapath_wide = {{32{dot8_s4_sum[31]}}, dot8_s4_sum};
            OP_SDOT4_S4_2_4: datapath_wide = {{32{sdot4_s4_2_4_sum[31]}}, sdot4_s4_2_4_sum};
            OP_DOT16_S2: datapath_wide = dot16_ternary_mode_q
                ? {{32{dot16_ternary_sum[31]}}, dot16_ternary_sum}
                : {{32{dot16_s2_sum[31]}}, dot16_s2_sum};
            OP_DOT4_FP8_E4M3: datapath_wide = {{32{dot4_fp8_e4m3_sum[31]}}, dot4_fp8_e4m3_sum};
            OP_EXP2_NEG_Q0_8: datapath_wide = {32'h0, exp2_neg_q0_8(op_a_q[7:0])};
            OP_RELU4_S8: datapath_wide = {
                32'h0,
                relu_s8(op_a_q[31:24]),
                relu_s8(op_a_q[23:16]),
                relu_s8(op_a_q[15:8]),
                relu_s8(op_a_q[7:0])
            };
            default:    datapath_wide = 64'h0;
        endcase
    end

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            op_a <= 32'h0;
            op_b <= 32'h0;
            acc <= 32'h0;
            opcode <= OP_ADD;
            result <= 32'h0;
            result_hi <= 32'h0;
            status <= 32'h0;
            busy_count <= 3'h0;
            op_a_q <= 32'h0;
            op_b_q <= 32'h0;
            acc_q <= 32'h0;
            opcode_q <= OP_ADD;
            dot16_ternary_mode_q <= 1'b0;
            gemm_m <= 2'h0;
            gemm_n <= 2'h0;
            gemm_k <= 3'h0;
            gemm_a_base <= 6'h0;
            gemm_b_base <= 6'h0;
            gemm_c_base <= 6'h0;
            gemm_a_stride <= 4'h0;
            gemm_b_stride <= 4'h0;
            gemm_c_stride <= 4'h0;
            gemm_i <= 2'h0;
            gemm_j <= 2'h0;
            gemm_l <= 3'h0;
            gemm_acc <= 32'sh0;
            gemm_s4_mode <= 1'b0;
            vec_len <= 6'h0;
            vec_src_base <= 6'h0;
            vec_dst_base <= 6'h0;
            vec_i <= 6'h0;
            perf_cycles <= 32'h0;
            perf_macs <= 32'h0;
            perf_errors <= 32'h0;
            perf_ops <= 32'h0;
            perf_unsupported_ops <= 32'h0;
            cmd_param <= 32'h0;
            desc_base <= 32'h0;
            desc_head <= 3'h0;
            desc_tail <= 3'h0;
            desc_err_index <= 3'h0;
            desc_status <= 32'h0000_0001;
            desc_busy <= 1'b0;
            desc_state <= DESC_IDLE;
            desc_fetch_word <= 2'h0;
            desc_timeout_count <= 32'h0;
            desc_bytes_read <= 32'h0;
            desc_bytes_written <= 32'h0;
            desc_read_beats <= 32'h0;
            desc_write_beats <= 32'h0;
            perf_stall_cycles <= 32'h0;
            perf_scratch_bytes <= 32'h0;
            perf_thermal_throttle <= 32'h0;
            desc_stream_done <= 6'h0;
            desc_write_done <= 6'h0;
            gemm_busy <= 1'b0;
            vec_busy <= 1'b0;
            // Reset is the revoke/scrub point (S4.3): NPU returns to unowned,
            // owner/domain cleared, and the monitor-programming lock drops so a
            // fresh measured launch can reprogram ownership.
            sec_owned <= 1'b0;
            sec_owner <= 20'h0;
            sec_lock <= 1'b0;
            sec_perf_lock <= 1'b0;
            for (int desc_idx = 0; desc_idx < DESC_WORDS; desc_idx++) begin
                desc_words[desc_idx] <= 32'h0;
            end
            for (int idx = 0; idx < SCRATCH_WORDS; idx++) begin
                scratch[idx] <= 32'h0;
            end
        end else begin
            if (busy_count != 3'h0) begin
                busy_count <= busy_count - 3'h1;
                if (busy_count == 3'h1) begin
                    if ((opcode_q == OP_DOT16_S2) && dot16_ternary_mode_q && dot16_ternary_invalid) begin
                        status <= 32'h0000_0006;
                        perf_errors <= perf_errors + 32'd1;
                    end else begin
                        {result_hi, result} <= datapath_wide;
                        if (!desc_busy) begin
                            status <= 32'h0000_0002;
                        end
                    end
                end
            end

            if (gemm_busy) begin
                perf_cycles <= perf_cycles + 32'd1;
                if (!gemm_cfg_ok) begin
                    gemm_busy <= 1'b0;
                    status <= 32'h0000_0006;
                    perf_errors <= perf_errors + 32'd1;
                end else begin
                    perf_macs <= perf_macs + 32'd1;
                    if (gemm_l == gemm_k - 3'd1) begin
                        scratch_write_i32(gemm_c_addr[5:2], gemm_acc + (gemm_a_value * gemm_b_value));
                        // Final MAC step of an output cell: one A byte (or
                        // nibble) read, one B byte (or nibble) read, four
                        // bytes written for the int32 accumulator.
                        perf_scratch_bytes <= perf_scratch_bytes + 32'd6;
                        gemm_acc <= 32'sh0;
                        gemm_l <= 3'h0;
                        if (gemm_j == gemm_n - 2'd1) begin
                            gemm_j <= 2'h0;
                            if (gemm_i == gemm_m - 2'd1) begin
                                gemm_i <= 2'h0;
                                gemm_busy <= 1'b0;
                                if (!desc_busy) begin
                                    status <= 32'h0000_0002;
                                end
                            end else begin
                                gemm_i <= gemm_i + 2'd1;
                            end
                        end else begin
                            gemm_j <= gemm_j + 2'd1;
                        end
                    end else begin
                        gemm_acc <= gemm_acc + (gemm_a_value * gemm_b_value);
                        gemm_l <= gemm_l + 3'd1;
                        // Non-final MAC step: one A byte (or nibble) read
                        // and one B byte (or nibble) read.
                        perf_scratch_bytes <= perf_scratch_bytes + 32'd2;
                    end
                end
            end

            if (vec_busy) begin
                perf_cycles <= perf_cycles + 32'd1;
                if (!vec_cfg_ok) begin
                    vec_busy <= 1'b0;
                    status <= 32'h0000_0006;
                    perf_errors <= perf_errors + 32'd1;
                end else begin
                    scratch_write_byte(vec_dst_addr, relu_s8(scratch_read_byte(vec_src_addr)));
                    // One byte read from source, one byte written to destination.
                    perf_scratch_bytes <= perf_scratch_bytes + 32'd2;
                    if (vec_i == vec_len - 6'd1) begin
                        vec_i <= 6'h0;
                        vec_busy <= 1'b0;
                        if (!desc_busy) begin
                            status <= 32'h0000_0002;
                        end
                    end else begin
                        vec_i <= vec_i + 6'd1;
                    end
                end
            end

            if (desc_busy) begin
                desc_timeout_count <= desc_timeout_count + 32'd1;
                // Count cycles the descriptor engine spends in an AXI memory
                // wait state (descriptor fetch, tensor stream, or writeback)
                // regardless of handshake completion; this gives a power-per-
                // counter proxy for memory-bound stalls.
                if (desc_state == DESC_FETCH_ADDR ||
                    desc_state == DESC_FETCH_DATA ||
                    desc_state == DESC_STREAM_ADDR ||
                    desc_state == DESC_STREAM_DATA ||
                    desc_state == DESC_WRITE_ADDR ||
                    desc_state == DESC_WRITE_RESP) begin
                    perf_stall_cycles <= perf_stall_cycles + 32'd1;
                end
                if (desc_timeout_count >= DESC_TIMEOUT_LIMIT) begin
                    desc_busy <= 1'b0;
                    desc_state <= DESC_IDLE;
                    busy_count <= 3'h0;
                    gemm_busy <= 1'b0;
                    vec_busy <= 1'b0;
                    status <= 32'h0000_0006;
                    desc_status <= 32'h0000_000c;
                    perf_errors <= perf_errors + 32'd1;
                    perf_unsupported_ops <= perf_unsupported_ops + 32'd1;
                end else begin
                    unique case (desc_state)
                        DESC_FETCH_ADDR: begin
                            if (m_axil_arready) begin
                                desc_state <= DESC_FETCH_DATA;
                            end
                        end
                        DESC_FETCH_DATA: begin
                            if (m_axil_rvalid) begin
                                if (m_axil_rresp != 2'b00) begin
                                    desc_busy <= 1'b0;
                                    desc_state <= DESC_IDLE;
                                    status <= 32'h0000_0006;
                                    desc_status <= 32'h0000_0014;
                                    perf_errors <= perf_errors + 32'd1;
                                    perf_unsupported_ops <= perf_unsupported_ops + 32'd1;
                                end else begin
                                    desc_words[desc_fetch_word] <= m_axil_rdata;
                                    desc_bytes_read <= desc_bytes_read + 32'd4;
                                    desc_read_beats <= desc_read_beats + 32'd1;
                                    if (desc_fetch_word == 2'd3) begin
                                        desc_fetch_word <= 2'h0;
                                        desc_state <= DESC_LAUNCH;
                                    end else begin
                                        desc_fetch_word <= desc_fetch_word + 2'd1;
                                        desc_state <= DESC_FETCH_ADDR;
                                    end
                                end
                            end
                        end
                        DESC_STREAM_ADDR: begin
                            if (m_axil_arready) begin
                                desc_state <= DESC_STREAM_DATA;
                            end
                        end
                        DESC_STREAM_DATA: begin
                            if (m_axil_rvalid) begin
                                if (m_axil_rresp != 2'b00) begin
                                    desc_busy <= 1'b0;
                                    desc_state <= DESC_IDLE;
                                    status <= 32'h0000_0006;
                                    desc_status <= 32'h0000_0034;
                                    perf_errors <= perf_errors + 32'd1;
                                    perf_unsupported_ops <= perf_unsupported_ops + 32'd1;
                                end else begin
                                    scratch_stream_write_word(desc_stream_word_addr, m_axil_rdata);
                                    desc_bytes_read <= desc_bytes_read + 32'd4;
                                    desc_read_beats <= desc_read_beats + 32'd1;
                                    perf_scratch_bytes <= perf_scratch_bytes + 32'd4;
                                    if ((desc_stream_done + 6'd4) >= desc_stream_len) begin
                                        desc_stream_done <= desc_stream_done + 6'd4;
                                        desc_state <= DESC_LAUNCH;
                                    end else begin
                                        desc_stream_done <= desc_stream_done + 6'd4;
                                        desc_state <= DESC_STREAM_ADDR;
                                    end
                                end
                            end
                        end
                        DESC_LAUNCH: begin
                            if (!desc_valid) begin
                                desc_busy <= 1'b0;
                                desc_state <= DESC_IDLE;
                                status <= 32'h0000_0006;
                                desc_status <= 32'h0000_0044;
                                perf_errors <= perf_errors + 32'd1;
                                perf_unsupported_ops <= perf_unsupported_ops + 32'd1;
                            end else if (!opcode_valid(desc_opcode)) begin
                                desc_busy <= 1'b0;
                                desc_state <= DESC_IDLE;
                                status <= 32'h0000_0006;
                                desc_status <= 32'h0000_0006;
                                perf_errors <= perf_errors + 32'd1;
                                perf_unsupported_ops <= perf_unsupported_ops + 32'd1;
                            end else if (!desc_stream_cfg_ok) begin
                                desc_busy <= 1'b0;
                                desc_state <= DESC_IDLE;
                                status <= 32'h0000_0006;
                                desc_status <= 32'h0000_0024;
                                perf_errors <= perf_errors + 32'd1;
                                perf_unsupported_ops <= perf_unsupported_ops + 32'd1;
                            end else if (!desc_writeback_cfg_ok) begin
                                desc_busy <= 1'b0;
                                desc_state <= DESC_IDLE;
                                status <= 32'h0000_0006;
                                desc_status <= 32'h0000_0084;
                                perf_errors <= perf_errors + 32'd1;
                                perf_unsupported_ops <= perf_unsupported_ops + 32'd1;
                            end else if (desc_stream_enable && desc_stream_done == 6'h0) begin
                                desc_state <= DESC_STREAM_ADDR;
                            end else if (opcode_is_gemm(desc_opcode)) begin
                                if (gemm_cfg_ok) begin
                                    gemm_busy <= 1'b1;
                                    gemm_s4_mode <= (desc_opcode == OP_GEMM_S4);
                                    gemm_i <= 2'h0;
                                    gemm_j <= 2'h0;
                                    gemm_l <= 3'h0;
                                    gemm_acc <= 32'sh0;
                                    perf_ops <= perf_ops + 32'd1;
                                    desc_state <= DESC_WAIT;
                                end else begin
                                    desc_busy <= 1'b0;
                                    desc_state <= DESC_IDLE;
                                    status <= 32'h0000_0006;
                                    desc_status <= 32'h0000_0006;
                                    perf_errors <= perf_errors + 32'd1;
                                    perf_unsupported_ops <= perf_unsupported_ops + 32'd1;
                                end
                            end else if (opcode_is_vector(desc_opcode)) begin
                                if (vec_cfg_ok) begin
                                    vec_busy <= 1'b1;
                                    vec_i <= 6'h0;
                                    perf_ops <= perf_ops + 32'd1;
                                    desc_state <= DESC_WAIT;
                                end else begin
                                    desc_busy <= 1'b0;
                                    desc_state <= DESC_IDLE;
                                    status <= 32'h0000_0006;
                                    desc_status <= 32'h0000_0006;
                                    perf_errors <= perf_errors + 32'd1;
                                    perf_unsupported_ops <= perf_unsupported_ops + 32'd1;
                                end
                            end else begin
                                busy_count <= opcode_latency(desc_opcode);
                                op_a_q <= desc_words[1];
                                op_b_q <= desc_words[2];
                                acc_q <= desc_words[3];
                                opcode_q <= desc_opcode;
                                dot16_ternary_mode_q <= (desc_opcode == OP_DOT16_S2) && cmd_param[1];
                                perf_ops <= perf_ops + 32'd1;
                                desc_state <= DESC_WAIT;
                            end
                        end
                        DESC_WAIT: begin
                            if (desc_engine_done) begin
                                if (desc_writeback_enable) begin
                                    desc_state <= DESC_WRITE_ADDR;
                                end else begin
                                    desc_state <= DESC_ADVANCE;
                                end
                            end
                        end
                        DESC_WRITE_ADDR: begin
                            if (m_axil_awready && m_axil_wready) begin
                                desc_state <= DESC_WRITE_RESP;
                            end
                        end
                        DESC_WRITE_RESP: begin
                            if (m_axil_bvalid) begin
                                if (m_axil_bresp != 2'b00) begin
                                    desc_busy <= 1'b0;
                                    desc_state <= DESC_IDLE;
                                    status <= 32'h0000_0006;
                                    desc_status <= 32'h0000_0094;
                                    perf_errors <= perf_errors + 32'd1;
                                    perf_unsupported_ops <= perf_unsupported_ops + 32'd1;
                                end else begin
                                    desc_bytes_written <= desc_bytes_written + 32'd4;
                                    desc_write_beats <= desc_write_beats + 32'd1;
                                    perf_scratch_bytes <= perf_scratch_bytes + 32'd4;
                                    if ((desc_write_done + 6'd4) >= desc_write_len) begin
                                        desc_write_done <= desc_write_done + 6'd4;
                                        desc_state <= DESC_ADVANCE;
                                    end else begin
                                        desc_write_done <= desc_write_done + 6'd4;
                                        desc_state <= DESC_WRITE_ADDR;
                                    end
                                end
                            end
                        end
                        DESC_ADVANCE: begin
                            desc_tail <= desc_tail_next;
                            desc_err_index <= desc_tail;
                            desc_status <= 32'h0000_0002;
                            desc_timeout_count <= 32'h0;
                            desc_stream_done <= 6'h0;
                            desc_write_done <= 6'h0;
                            if (desc_tail_next == desc_head) begin
                                desc_busy <= 1'b0;
                                desc_state <= DESC_IDLE;
                                status <= 32'h0000_0002;
                            end else begin
                                desc_fetch_word <= 2'h0;
                                desc_state <= DESC_FETCH_ADDR;
                            end
                        end
                        default: begin
                            desc_state <= DESC_FETCH_ADDR;
                        end
                    endcase
                end
            end

            if (valid && write) begin
                unique case (addr)
                    6'h00: op_a <= wdata;
                    6'h01: op_b <= wdata;
                    6'h04: opcode <= wdata[3:0];
                    6'h05: acc <= wdata;
                    6'h08: begin
                        vec_len <= wdata[5:0];
                        gemm_m <= wdata[1:0];
                        gemm_n <= wdata[9:8];
                        gemm_k <= wdata[18:16];
                    end
                    6'h09: begin
                        vec_src_base <= wdata[5:0];
                        vec_dst_base <= wdata[13:8];
                        gemm_a_base <= wdata[5:0];
                        gemm_b_base <= wdata[13:8];
                        gemm_c_base <= wdata[21:16];
                    end
                    6'h0a: begin
                        gemm_a_stride <= wdata[3:0];
                        gemm_b_stride <= wdata[11:8];
                        gemm_c_stride <= wdata[19:16];
                    end
                    6'h0c: cmd_param <= wdata;
                    // SEC_OWNER_CFG (monitor-only): assign/clear the owning
                    // confidential domain and the perf-lock policy. Writable
                    // ONLY while sec_lock is clear (the monitor-programming
                    // window before the platform is released to a domain); once
                    // locked the host cannot self-authorize ownership.
                    6'h0d: begin
                        if (!sec_lock) begin
                            sec_owner <= wdata[19:0];
                            sec_owned <= wdata[31];
                            sec_perf_lock <= wdata[30];
                        end
                    end
                    // SEC_LOCK (monitor-only): W1S sticky lock that freezes the
                    // ownership/perf-lock policy until reset (the only revoke
                    // path, per S4.3).
                    6'h0e: begin
                        if (wdata[0]) begin
                            sec_lock <= 1'b1;
                        end
                    end
                    6'h10: desc_base <= wdata;
                    6'h11: desc_head <= wdata[2:0];
                    6'h12: desc_tail <= wdata[2:0];
                    6'h17: begin
                        if (wdata[0]) begin
                            perf_cycles <= 32'h0;
                            perf_macs <= 32'h0;
                            perf_errors <= 32'h0;
                            perf_ops <= 32'h0;
                            perf_unsupported_ops <= 32'h0;
                            desc_bytes_read <= 32'h0;
                            desc_bytes_written <= 32'h0;
                            desc_read_beats <= 32'h0;
                            desc_write_beats <= 32'h0;
                            perf_stall_cycles <= 32'h0;
                            perf_scratch_bytes <= 32'h0;
                            perf_thermal_throttle <= 32'h0;
                        end
                    end
                    // PERF_THERMAL_THROTTLE is a simulation-only host-writable
                    // shadow latch until a real thermal HAL drives it; each
                    // write increments the counter.
                    6'h1f: perf_thermal_throttle <= perf_thermal_throttle + 32'd1;
                    6'h03: begin
                        if (wdata[0] && busy_count == 3'h0 && !gemm_busy && !vec_busy && !desc_busy) begin
                            if (cmd_param[0]) begin
                                desc_err_index <= desc_tail;
                                // Private-queue ownership gate (S4.2.2): when the
                                // NPU is owned-private and the policy is locked,
                                // a doorbell must present the owning domain token
                                // in CMD_PARAM[31:12]; a mismatched/host doorbell
                                // is denied with OWNER_ERROR and never starts a
                                // descriptor fetch.
                                if (sec_owned && sec_lock &&
                                    (cmd_param[31:12] != sec_owner)) begin
                                    desc_status <= 32'h0000_0040;
                                    status <= 32'h0000_0006;
                                    perf_errors <= perf_errors + 32'd1;
                                    perf_unsupported_ops <= perf_unsupported_ops + 32'd1;
                                end else if (desc_base[1:0] != 2'b00) begin
                                    desc_status <= 32'h0000_0004;
                                    status <= 32'h0000_0006;
                                    perf_errors <= perf_errors + 32'd1;
                                    perf_unsupported_ops <= perf_unsupported_ops + 32'd1;
                                end else if (desc_head == desc_tail) begin
                                    desc_status <= 32'h0000_0001;
                                    status <= 32'h0000_0006;
                                    perf_errors <= perf_errors + 32'd1;
                                    perf_unsupported_ops <= perf_unsupported_ops + 32'd1;
                                end else begin
                                    status <= 32'h0000_0001;
                                    desc_status <= 32'h0;
                                    desc_busy <= 1'b1;
                                    desc_state <= DESC_FETCH_ADDR;
                                    desc_fetch_word <= 2'h0;
                                    desc_timeout_count <= 32'h0;
                                    desc_bytes_read <= 32'h0;
                                    desc_bytes_written <= 32'h0;
                                    desc_read_beats <= 32'h0;
                                    desc_write_beats <= 32'h0;
                                    desc_stream_done <= 6'h0;
                                    desc_write_done <= 6'h0;
                                end
                            end else if (opcode_is_gemm(opcode)) begin
                                if (gemm_cfg_ok) begin
                                    status <= 32'h0000_0001;
                                    gemm_busy <= 1'b1;
                                    gemm_s4_mode <= (opcode == OP_GEMM_S4);
                                    gemm_i <= 2'h0;
                                    gemm_j <= 2'h0;
                                    gemm_l <= 3'h0;
                                    gemm_acc <= 32'sh0;
                                    perf_ops <= perf_ops + 32'd1;
                                end else begin
                                    status <= 32'h0000_0006;
                                    perf_errors <= perf_errors + 32'd1;
                                    perf_unsupported_ops <= perf_unsupported_ops + 32'd1;
                                end
                            end else if (opcode_is_vector(opcode)) begin
                                if (vec_cfg_ok) begin
                                    status <= 32'h0000_0001;
                                    vec_busy <= 1'b1;
                                    vec_i <= 6'h0;
                                    perf_ops <= perf_ops + 32'd1;
                                end else begin
                                    status <= 32'h0000_0006;
                                    perf_errors <= perf_errors + 32'd1;
                                    perf_unsupported_ops <= perf_unsupported_ops + 32'd1;
                                end
                            end else if (opcode_valid(opcode)) begin
                                status <= 32'h0000_0001;
                                busy_count <= opcode_latency(opcode);
                                op_a_q <= op_a;
                                op_b_q <= op_b;
                                acc_q <= acc;
                                opcode_q <= opcode;
                                dot16_ternary_mode_q <= (opcode == OP_DOT16_S2) && cmd_param[1];
                                perf_ops <= perf_ops + 32'd1;
                            end else begin
                                status <= 32'h0000_0006;
                                perf_errors <= perf_errors + 32'd1;
                                perf_unsupported_ops <= perf_unsupported_ops + 32'd1;
                            end
                        end
                        if (wdata[1]) begin
                            status[1] <= 1'b0;
                            status[2] <= 1'b0;
                            desc_status <= 32'h0;
                            desc_err_index <= 3'h0;
                            desc_timeout_count <= 32'h0;
                            desc_bytes_read <= 32'h0;
                            desc_bytes_written <= 32'h0;
                            desc_read_beats <= 32'h0;
                            desc_write_beats <= 32'h0;
                            desc_write_done <= 6'h0;
                        end
                    end
                    default: begin
                        if (addr[5:4] == 2'b10) begin
                            scratch_write_word(addr[3:0], wdata);
                        end
                    end
                endcase
            end
        end
    end

    always_comb begin
        unique case (addr)
            6'h00: rdata = op_a;
            6'h01: rdata = op_b;
            6'h02: rdata = result;
            6'h03: rdata = status;
            6'h04: rdata = {28'h0, opcode};
            6'h05: rdata = acc;
            6'h06: rdata = result_hi;
            6'h07: rdata = {23'h0, vec_busy, gemm_busy, opcode_q, busy_count};
            6'h08: rdata = {13'h0, gemm_k, 6'h0, gemm_n, 2'h0, vec_len};
            6'h09: rdata = {10'h0, gemm_c_base, 2'h0, vec_dst_base, 2'h0, vec_src_base};
            6'h0a: rdata = {12'h0, gemm_c_stride, 4'h0, gemm_b_stride, 4'h0, gemm_a_stride};
            6'h0b: rdata = perf_hidden ? 32'h0 : perf_unsupported_ops;
            6'h0c: rdata = cmd_param;
            // SEC_STATUS (read-only): ownership + lockdown observability for the
            // monitor / IOMMU DC installer. Source ID is exposed read-only so
            // platform bring-up can confirm the constant the IOMMU/IOPMP policy
            // binds. Not gated by perf_hidden (it is policy state, not a timing
            // side channel).
            6'h0f: rdata = {NPU_SOURCE_ID,
                            4'h0,
                            sec_lock, sec_perf_lock, perf_hidden, sec_owned};
            6'h0d: rdata = {sec_owned, sec_perf_lock, 10'h0, sec_owner};
            6'h10: rdata = desc_base;
            6'h11: rdata = {29'h0, desc_head};
            6'h12: rdata = {29'h0, desc_tail};
            6'h13: rdata = desc_status | {10'h0, desc_pending, 7'h0, desc_err_index, desc_busy, 8'h0};
            // PERF_* counters are the inference timing/MAC-count side channel
            // (S4.2.5). When the NPU is owned-private with the perf lock armed,
            // host reads return 0; the monitor reads them out of band.
            6'h14: rdata = perf_hidden ? 32'h0 : perf_cycles;
            6'h15: rdata = perf_hidden ? 32'h0 : perf_macs;
            6'h16: rdata = perf_hidden ? 32'h0 : perf_ops;
            6'h17: rdata = perf_hidden ? 32'h0 : perf_errors;
            6'h18: rdata = perf_hidden ? 32'h0 : desc_timeout_count;
            6'h19: rdata = perf_hidden ? 32'h0 : desc_bytes_read;
            6'h1a: rdata = perf_hidden ? 32'h0 : desc_bytes_written;
            6'h1b: rdata = perf_hidden ? 32'h0 : desc_read_beats;
            6'h1c: rdata = perf_hidden ? 32'h0 : desc_write_beats;
            6'h1d: rdata = perf_hidden ? 32'h0 : perf_stall_cycles;
            6'h1e: rdata = perf_hidden ? 32'h0 : perf_scratch_bytes;
            6'h1f: rdata = perf_hidden ? 32'h0 : perf_thermal_throttle;
            6'h20: rdata = scratch[0];
            6'h21: rdata = scratch[1];
            6'h22: rdata = scratch[2];
            6'h23: rdata = scratch[3];
            6'h24: rdata = scratch[4];
            6'h25: rdata = scratch[5];
            6'h26: rdata = scratch[6];
            6'h27: rdata = scratch[7];
            6'h28: rdata = scratch[8];
            6'h29: rdata = scratch[9];
            6'h2a: rdata = scratch[10];
            6'h2b: rdata = scratch[11];
            6'h2c: rdata = scratch[12];
            6'h2d: rdata = scratch[13];
            6'h2e: rdata = scratch[14];
            6'h2f: rdata = scratch[15];
            default: begin
                if (addr[5:4] == 2'b10) begin
                    rdata = scratch[addr[3:0]];
                end else begin
                    rdata = 32'h0;
                end
            end
        endcase
    end
endmodule
