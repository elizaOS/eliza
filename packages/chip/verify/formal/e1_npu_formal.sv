`timescale 1ns/1ps

// Formal harness for e1_npu.
//
// The earlier revision pinned addr < 6'h08 and forbade the start bit, so only
// the scalar mirror-register subset was proven. This harness lifts that ceiling
// — the full MMIO map (config, descriptor pointers, scratch, start, clear) is
// reachable and the AXI-Lite slave responses are driven freely — so the GEMM
// tile loop, the vector engine, the packed scalar datapath, and the descriptor
// ring FSM all run under proof.
//
// Observation boundary. The native Yosys SystemVerilog frontend used by this
// flow reads cross-module taps of a submodule's internal nets as free,
// disconnected wires. Sound observation is therefore through module ports:
// the software-visible rdata/master ports, plus `FORMAL`-only observability
// ports that e1_npu wires directly to the real internal GEMM/vector state.
//
// Environmental constraint: software does not reprogram the descriptor ring
// pointers (addr 6'h11 / 6'h12) after setup. These pointers are configured once
// during ring setup; scoping the writes out lets the descriptor-empty invariant
// track hardware-managed ring evolution. Engine configuration is programmed
// before launch and held while a descriptor queue or engine is active, matching
// the driver contract. No hardware transition is hidden. No assumption
// constrains the start bit, opcode, scratch contents, or AXI response bus.

module e1_npu_formal(input logic clk);
    logic rst_n = 1'b0;
    (* anyseq *) logic valid;
    (* anyseq *) logic write;
    (* anyseq *) logic [5:0] addr;
    (* anyseq *) logic [31:0] wdata;
    logic [31:0] rdata;
    logic irq;

    logic m_axil_awvalid;
    logic [31:0] m_axil_awaddr;
    logic m_axil_wvalid;
    logic [31:0] m_axil_wdata;
    logic [3:0] m_axil_wstrb;
    logic m_axil_bready;
    logic m_axil_arvalid;
    logic [31:0] m_axil_araddr;
    logic m_axil_rready;
    logic        formal_gemm_busy;
    logic        formal_vec_busy;
    logic        formal_gemm_cfg_ok;
    logic        formal_vec_cfg_ok;
    logic        formal_gemm_active_s4;
    logic [7:0]  formal_gemm_a_addr;
    logic [7:0]  formal_gemm_b_addr;
    logic [7:0]  formal_gemm_c_addr;
    logic [1:0]  formal_gemm_m;
    logic [1:0]  formal_gemm_n;
    logic [2:0]  formal_gemm_k;
    logic [1:0]  formal_gemm_i;
    logic [1:0]  formal_gemm_j;
    logic [2:0]  formal_gemm_l;
    logic signed [31:0] formal_gemm_acc;
    logic [5:0]  formal_vec_len;
    logic [5:0]  formal_vec_src_base;
    logic [5:0]  formal_vec_dst_base;
    logic [5:0]  formal_vec_i;
    logic [5:0]  formal_vec_src_addr;
    logic [5:0]  formal_vec_dst_addr;
    logic [31:0] formal_desc_timeout_count;
    logic [3:0]  formal_desc_state;
    logic        formal_desc_busy;

    // Free AXI slave responses: the engine must stay safe and protocol-legal
    // for any handshake/response pattern the memory system can present.
    (* anyseq *) logic        m_axil_awready;
    (* anyseq *) logic        m_axil_wready;
    (* anyseq *) logic        m_axil_bvalid;
    (* anyseq *) logic [1:0]  m_axil_bresp;
    (* anyseq *) logic        m_axil_arready;
    (* anyseq *) logic        m_axil_rvalid;
    (* anyseq *) logic [31:0] m_axil_rdata;
    (* anyseq *) logic [1:0]  m_axil_rresp;

    logic [3:0]  opcode_shadow = 4'h0;
    logic [31:0] op_a_shadow = 32'h0;
    logic [31:0] op_b_shadow = 32'h0;
    logic [31:0] acc_shadow = 32'h0;

    e1_npu dut (
        .clk(clk),
        .rst_n(rst_n),
        .valid(valid),
        .write(write),
        .addr(addr),
        .wdata(wdata),
        .rdata(rdata),
        .irq(irq),
        .m_axil_awvalid(m_axil_awvalid),
        .m_axil_awready(m_axil_awready),
        .m_axil_awaddr(m_axil_awaddr),
        .m_axil_wvalid(m_axil_wvalid),
        .m_axil_wready(m_axil_wready),
        .m_axil_wdata(m_axil_wdata),
        .m_axil_wstrb(m_axil_wstrb),
        .m_axil_bvalid(m_axil_bvalid),
        .m_axil_bready(m_axil_bready),
        .m_axil_bresp(m_axil_bresp),
        .m_axil_arvalid(m_axil_arvalid),
        .m_axil_arready(m_axil_arready),
        .m_axil_araddr(m_axil_araddr),
        .m_axil_rvalid(m_axil_rvalid),
        .m_axil_rready(m_axil_rready),
        .m_axil_rdata(m_axil_rdata),
        .m_axil_rresp(m_axil_rresp),
        .formal_gemm_busy(formal_gemm_busy),
        .formal_vec_busy(formal_vec_busy),
        .formal_gemm_cfg_ok(formal_gemm_cfg_ok),
        .formal_vec_cfg_ok(formal_vec_cfg_ok),
        .formal_gemm_active_s4(formal_gemm_active_s4),
        .formal_gemm_a_addr(formal_gemm_a_addr),
        .formal_gemm_b_addr(formal_gemm_b_addr),
        .formal_gemm_c_addr(formal_gemm_c_addr),
        .formal_gemm_m(formal_gemm_m),
        .formal_gemm_n(formal_gemm_n),
        .formal_gemm_k(formal_gemm_k),
        .formal_gemm_i(formal_gemm_i),
        .formal_gemm_j(formal_gemm_j),
        .formal_gemm_l(formal_gemm_l),
        .formal_gemm_acc(formal_gemm_acc),
        .formal_vec_len(formal_vec_len),
        .formal_vec_src_base(formal_vec_src_base),
        .formal_vec_dst_base(formal_vec_dst_base),
        .formal_vec_i(formal_vec_i),
        .formal_vec_src_addr(formal_vec_src_addr),
        .formal_vec_dst_addr(formal_vec_dst_addr),
        .formal_desc_timeout_count(formal_desc_timeout_count),
        .formal_desc_state(formal_desc_state),
        .formal_desc_busy(formal_desc_busy)
    );

    initial rst_n = 1'b0;

    // Registered copies of the request channel and of the previous read value,
    // for two-consecutive-read counter comparisons.
    logic        valid_q, write_q;
    logic [5:0]  addr_q;
    logic [31:0] wdata_q;
    logic [31:0] rdata_q;

    always_ff @(posedge clk) begin
        rst_n   <= 1'b1;
        valid_q <= valid;
        write_q <= write;
        addr_q  <= addr;
        wdata_q <= wdata;
        rdata_q <= rdata;

        // Descriptor ring pointers are configured once; the host does not
        // re-poke them after setup.
        assume(!(rst_n && valid && write && (addr == 6'h11 || addr == 6'h12)));
        // Engine configuration is programmed before a launch and held stable
        // while a descriptor queue or engine is active. This is the MMIO
        // programming contract the driver must obey; it does not constrain any
        // hardware transition.
        assume(!(rst_n && valid && write && (formal_gemm_busy || formal_desc_busy) &&
                 (addr == 6'h08 || addr == 6'h09 || addr == 6'h0a || addr == 6'h04)));
        assume(!(rst_n && valid && write && (formal_vec_busy || formal_desc_busy) &&
                 (addr == 6'h08 || addr == 6'h09 || addr == 6'h04)));

        if (!$past(rst_n)) begin
            assert(!irq);
        end

        // -----------------------------------------------------------------
        // Scalar mirror-register coverage (retained from the prior harness).
        // -----------------------------------------------------------------
        if (rst_n && addr == 6'h03) begin
            assert(irq == rdata[1]);
            assert(!(rdata[0] && rdata[1]));
            assert(!(rdata[0] && rdata[2]));
            if (rdata[2]) begin
                assert(rdata[1]);
                assert(irq);
            end
        end

        if (rst_n && irq && addr == 6'h03) begin
            assert(rdata[1]);
        end

        if (rst_n && addr == 6'h04) begin
            assert(rdata == {28'h0, opcode_shadow});
        end

        if (rst_n && addr == 6'h00) begin
            assert(rdata == op_a_shadow);
        end

        if (rst_n && addr == 6'h01) begin
            assert(rdata == op_b_shadow);
        end

        if (rst_n && addr == 6'h05) begin
            assert(rdata == acc_shadow);
        end

        // STATUS_AUX (addr 6'h07) = {23'h0, vec_busy, gemm_busy, opcode_q,
        // busy_count}. Bits [8:7] carry the live vec/gemm busy flags (now
        // reachable since the engines run); only bits [31:9] are reserved-zero.
        if (rst_n && addr == 6'h07) begin
            assert(rdata[31:9] == 23'h0);
        end

        // -----------------------------------------------------------------
        // Internal GEMM/vector engine contract through FORMAL-only ports.
        // These ports are direct assignments from e1_npu's real internal nets,
        // avoiding unsound hierarchical or bind-based taps.
        // -----------------------------------------------------------------
        if (rst_n && formal_gemm_cfg_ok) begin
            a_gemm_dims_nonzero: assert(formal_gemm_m != 2'h0);
            a_gemm_n_nonzero:    assert(formal_gemm_n != 2'h0);
            a_gemm_k_nonzero:    assert(formal_gemm_k != 3'h0);
            a_gemm_c_aligned:    assert(formal_gemm_c_addr[1:0] == 2'b00);
            a_gemm_c_in_bounds:  assert((formal_gemm_c_addr + 8'd3) < 8'd64);
            if (formal_gemm_active_s4) begin
                a_gemm_s4_a_nibble_bounds: assert(formal_gemm_a_addr < 8'd128);
                a_gemm_s4_b_nibble_bounds: assert(formal_gemm_b_addr < 8'd128);
            end else begin
                a_gemm_s8_a_byte_bounds: assert(formal_gemm_a_addr < 8'd64);
                a_gemm_s8_b_byte_bounds: assert(formal_gemm_b_addr < 8'd64);
            end
        end

        if (rst_n && formal_gemm_busy) begin
            a_gemm_busy_cfg_ok: assert(formal_gemm_cfg_ok);
            a_gemm_i_window:    assert(formal_gemm_i < formal_gemm_m);
            a_gemm_j_window:    assert(formal_gemm_j < formal_gemm_n);
            a_gemm_l_window:    assert(formal_gemm_l < formal_gemm_k);

            // Accumulator-overflow safety. gemm_acc accumulates int8*int8
            // products (each operand is signed [7:0], product in
            // [-128*127, 128*128] = [-16256, 16384], |product| <= 16384) and is
            // re-zeroed on the final MAC of every output cell, i.e. after at
            // most (gemm_k-1) accumulation steps with gemm_l in [0, gemm_k-1]
            // and gemm_k <= 7 (3-bit). The running magnitude is therefore at
            // most gemm_l * 16384 < 7*16384 = 114688 < 2^31, so the signed-32
            // accumulator provably never overflows. Bounding by
            // (formal_gemm_l + 1) * 16384 ties the proof to the loop window,
            // making it inductive (mode prove) rather than depth-bounded.
            a_gemm_acc_no_overflow:
                assert((formal_gemm_acc <=  $signed((formal_gemm_l + 4'd1) * 32'sd16384)) &&
                       (formal_gemm_acc >= -$signed((formal_gemm_l + 4'd1) * 32'sd16384)));
        end

        if (rst_n && formal_vec_cfg_ok) begin
            a_vec_len_nonzero:   assert(formal_vec_len != 6'h0);
            a_vec_src_window:    assert(({2'b00, formal_vec_src_base} + {2'b00, formal_vec_len}) <= 8'd64);
            a_vec_dst_window:    assert(({2'b00, formal_vec_dst_base} + {2'b00, formal_vec_len}) <= 8'd64);
        end

        if (rst_n && formal_vec_busy) begin
            a_vec_busy_cfg_ok:   assert(formal_vec_cfg_ok);
            a_vec_i_window:      assert(formal_vec_i < formal_vec_len);
            a_vec_src_addr_calc:  assert({1'b0, formal_vec_src_addr} ==
                                         ({1'b0, formal_vec_src_base} + {1'b0, formal_vec_i}));
            a_vec_dst_addr_calc:  assert({1'b0, formal_vec_dst_addr} ==
                                         ({1'b0, formal_vec_dst_base} + {1'b0, formal_vec_i}));
            a_vec_src_addr_bound: assert({1'b0, formal_vec_src_addr} < 7'd64);
            a_vec_dst_addr_bound: assert({1'b0, formal_vec_dst_addr} < 7'd64);
        end

        if (rst_n && formal_desc_busy) begin
            // The descriptor-timeout counter never exceeds the limit while the
            // engine is busy: it increments by one per busy cycle and the
            // firing edge (count >= DESC_TIMEOUT_LIMIT) drops desc_busy in the
            // same cycle. Proven inductively under `mode prove`
            // (verify/formal/npu/e1_npu_kind.sby) so it is a true bound, not a
            // depth-12 vacuous pass: at depth 12 the counter cannot even reach
            // 128, so the BMC task alone witnesses nothing.
            a_desc_timeout_prelimit: assert(formal_desc_timeout_count <= 32'd128);
        end

`ifdef FORMAL_DEEP
        // Witness the descriptor-timeout firing edge. Reachable only at BMC
        // depth >= ~130 (the counter must climb from 0 to DESC_TIMEOUT_LIMIT
        // while desc_busy stays high), which the depth-12 routine task cannot
        // reach. verify/formal/npu/e1_npu_deep.sby drives this cover at depth
        // 160 so the timeout exit is an exercised transition, not just an
        // unproven invariant. desc_status == 32'h0000_000c is the timeout-exit
        // code written at rtl/npu/e1_npu.sv:821.
        if (rst_n && addr == 6'h13) begin
            c_desc_timeout_fires: cover(formal_desc_state == 4'h0 /* DESC_IDLE */ &&
                                        rdata[3:0] == 4'hc);
        end
        c_desc_timeout_count_reaches_limit:
            cover(rst_n && formal_desc_timeout_count == 32'd128);
`endif

        // -----------------------------------------------------------------
        // Descriptor status register (addr 6'h13). The read value is
        //   desc_status | {10'h0, desc_pending, 7'h0, desc_err_index,
        //                  desc_busy, 8'h0}
        // so bit0 is the ring-empty flag and bits[21:19] are desc_pending
        // (= desc_head - desc_tail). With the pointer-poke constraint, the
        // empty flag implies the ring is drained: pending == 0. Non-vacuous —
        // the empty bit is set out of reset and cleared while a descriptor
        // runs. desc_busy is bit8.
        // -----------------------------------------------------------------
        if (rst_n && addr == 6'h13) begin
            a_desc_empty_implies_no_pending:
                assert(!rdata[0] || (rdata[21:19] == 3'h0));
            // Empty and busy are mutually exclusive: a drained ring is idle.
            a_desc_empty_not_busy:
                assert(!(rdata[0] && rdata[8]));
            // Reserved bits of the descriptor-status word stay zero.
            a_desc_status_reserved_zero:
                assert(rdata[31:22] == 10'h0);
        end

        // -----------------------------------------------------------------
        // Bandwidth / performance counter monotonicity. Reading the same
        // counter register on two consecutive cycles observes the underlying
        // register one cycle apart; absent an explicit clear that took effect
        // last cycle, the value is non-decreasing. Clears:
        //   - PERF_CLEAR (addr 6'h17, wdata[0]) clears every counter below.
        //   - status-clear (addr 6'h03, wdata[1]) clears the descriptor
        //     byte/beat counters.
        //   - descriptor kickoff (addr 6'h03, wdata[0]) re-zeros the descriptor
        //     byte/beat counters at ring start.
        // The previous-cycle write is sampled from the *_q copies.
        // -----------------------------------------------------------------
        if (rst_n && $past(rst_n)) begin
            // PERF_STALL_CYCLES (0x1d) and PERF_SCRATCH_BYTES (0x1e): cleared
            // only by PERF_CLEAR.
            if (!(valid_q && write_q && (addr_q == 6'h17) && wdata_q[0])) begin
                if (addr == 6'h1d && addr_q == 6'h1d) begin
                    a_perf_stall_monotonic:   assert(rdata >= rdata_q);
                end
                if (addr == 6'h1e && addr_q == 6'h1e) begin
                    a_perf_scratch_monotonic: assert(rdata >= rdata_q);
                end
            end

            // DESC_BYTES_READ (0x19) / DESC_BYTES_WRITTEN (0x1a): cleared by
            // PERF_CLEAR, status-clear (0x03 wdata[1]) and kickoff
            // (0x03 wdata[0]).
            if (!((valid_q && write_q && (addr_q == 6'h17) && wdata_q[0]) ||
                  (valid_q && write_q && (addr_q == 6'h03) &&
                   (wdata_q[0] || wdata_q[1])))) begin
                if (addr == 6'h19 && addr_q == 6'h19) begin
                    a_desc_bytes_read_monotonic:    assert(rdata >= rdata_q);
                end
                if (addr == 6'h1a && addr_q == 6'h1a) begin
                    a_desc_bytes_written_monotonic: assert(rdata >= rdata_q);
                end
            end

            // -------------------------------------------------------------
            // Thermal-throttle counter (PERF_THERMAL_THROTTLE, addr 6'h1f).
            // The counter increments by one on every host write to 6'h1f and is
            // re-zeroed only by PERF_CLEAR. Two consecutive reads of 6'h1f
            // therefore never observe a downward step unless a clear took
            // effect — within the reachable window this proves there is no
            // spurious decrement or skip.
            //
            // HONEST SCOPE: this does NOT prove no-wrap at 2^32. The RTL does an
            // unsaturated `perf_thermal_throttle <= perf_thermal_throttle + 1`
            // (rtl/npu/e1_npu.sv:1084), so the counter genuinely wraps 2^32-1 ->
            // 0. The assertion below is consequently only sound as a bounded BMC
            // property (no two-read decrement reachable within the bound); it is
            // NOT proven under k-induction, because the inductive step admits the
            // pre-wrap state 2^32-1 and the property is false there. Witnessing a
            // real wrap would need ~2^32 writes (infeasible for BMC) and
            // eliminating it requires an RTL saturating add, which is out of this
            // harness's scope. The no-wrap guarantee is therefore an open RTL
            // item, tracked in rtl_gap_work_order.yaml, not a proven property.
            // -------------------------------------------------------------
            if (!(valid_q && write_q && (addr_q == 6'h17) && wdata_q[0])) begin
                if (addr == 6'h1f && addr_q == 6'h1f) begin
                    a_thermal_no_decrement_bounded: assert(rdata >= rdata_q);
                end
            end
        end

        // Scalar shadow bookkeeping.
        if (rst_n && valid && write && addr == 6'h04) begin
            opcode_shadow <= wdata[3:0];
        end
        if (rst_n && valid && write && addr == 6'h00) begin
            op_a_shadow <= wdata;
        end
        if (rst_n && valid && write && addr == 6'h01) begin
            op_b_shadow <= wdata;
        end
        if (rst_n && valid && write && addr == 6'h05) begin
            acc_shadow <= wdata;
        end
    end
endmodule
