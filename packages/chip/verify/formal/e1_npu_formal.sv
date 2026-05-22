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
// flow reads cross-module taps of a submodule's internal nets — both
// hierarchical references (dut.<net>) and bind-port connections to internal
// regs/wires — as free, disconnected wires (confirmed: a bind-connected
// perf_thermal_throttle proves "always 0" while the same counter read back
// through the rdata port is provably nonzero). Sound observation is therefore
// possible only through the module ports. Every property below reads the DUT
// state through the rdata register interface (or the master-output ports),
// which is exactly how the software-visible contract is observed. Properties
// that depend on internal-only nets (GEMM tile address bounds / INT4 nibble
// widening / gemm_acc, vector cursor bounds) are not soundly reachable through
// the port boundary in this toolchain and are tracked as an explicit open gap
// in verify/rtl_gap_work_order.yaml (npu-formal-engine-coverage).
//
// Environmental constraint: software does not reprogram the descriptor ring
// pointers (addr 6'h11 / 6'h12) after setup. These pointers are configured once
// during ring setup; scoping the writes out lets the descriptor-empty invariant
// track hardware-managed ring evolution. No hardware transition is hidden. No
// assumption constrains the start bit, opcode, GEMM/vector configuration,
// scratch contents, or AXI response bus.

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
        .m_axil_rresp(m_axil_rresp)
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
            // Thermal-throttle saturation (PERF_THERMAL_THROTTLE, addr 6'h1f).
            // The counter increments on every host write to 6'h1f and may only
            // decrease on PERF_CLEAR. Two consecutive reads of 6'h1f therefore
            // never observe a downward step unless a clear took effect — i.e.
            // the counter must saturate, never wrap, at 2^32. The dossier flags
            // a silent wrap at rtl/npu/e1_npu.sv:934; this assertion fails if
            // the RTL truly wraps, surfacing it as a defect rather than masking.
            // -------------------------------------------------------------
            if (!(valid_q && write_q && (addr_q == 6'h17) && wdata_q[0])) begin
                if (addr == 6'h1f && addr_q == 6'h1f) begin
                    a_thermal_no_wrap: assert(rdata >= rdata_q);
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
