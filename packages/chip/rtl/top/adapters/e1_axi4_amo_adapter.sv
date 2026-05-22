`timescale 1ns/1ps

// e1_axi4_amo_adapter
//
// Resolves AXI4 atomic write transactions (AXI5 `AWATOP`, as emitted by CVA6's
// cache adapter for RISC-V `amo*` instructions) into ordinary read-modify-write
// sequences on the downstream port, so the downstream fabric / DRAM controller
// needs no atomic support.  This is the standard "atomics filter" role of
// pulp-platform's axi_riscv_atomics, specialised to the boot top's single
// 64-bit CVA6 master (single outstanding, ≤XLEN single-beat atomics — the only
// shape CVA6 issues).
//
// Behaviour:
//   * atop == 0 (normal AR/AW/W/R/B): fully transparent pass-through.
//   * atop != 0 (ATOMICSWAP / ATOMICLOAD-{ADD,CLR,SET,EOR,SMAX,SMIN,UMAX,UMIN}):
//     the upstream issues one AW (with atop), its W beat, and expects BOTH a B
//     response AND an R beat carrying the *old* memory value (CVA6 sets
//     amo_gen_r for these).  This adapter, on the downstream side:
//        1. reads the current 64-bit word at the address,
//        2. computes new = f(old, operand) per the atop opcode,
//        3. writes new back,
//     then returns the captured *old* value to the upstream R channel (with the
//     atomic's write ID) and the write B to the upstream B channel.
//
// AXI atomics ordering: an atomic occupies the bus exclusively here (the
// adapter is single-outstanding for atomics and blocks other AW while one is in
// flight), which is the simplest correct serialization for a single in-order
// hart.  CVA6's `AxiDataWidth` for cv64a6 is 64, so a RISC-V atomic touches one
// aligned word inside the single 64-bit beat; the byte lane is taken from the
// access address and the operand width from the active write strobes.
//
// LR/SC are NOT atomics here — CVA6 issues those as AxLOCK exclusive accesses,
// not AWATOP — and pass through transparently (the exclusive monitor is the
// downstream's concern; the OpenSBI boot path uses amo* for its locks).

module e1_axi4_amo_adapter
    import e1_axi4_pkg::*;
#(
    parameter int unsigned ID_W   = 4,
    parameter int unsigned ADDR_W = 64,
    parameter int unsigned DATA_W = 64,
    parameter int unsigned USER_W = 1
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
    // AMO engine state.  When an atomic AW arrives it is captured and resolved
    // through a private read-modify-write on the downstream port; meanwhile the
    // normal (atop==0) channels are muxed so non-atomic traffic flows straight
    // through whenever the engine is idle.
    typedef enum logic [2:0] {
        A_IDLE,   // pass-through; watch for an atomic AW
        A_WCAP,   // atomic AW latched; capture the operand W beat
        A_RD,     // issue downstream AR for the old value
        A_RDATA,  // wait for downstream R (old value)
        A_WR,     // issue downstream AW + W with the computed new value
        A_WB,     // wait for downstream B
        A_URESP_R,// present R (old value) to the upstream master
        A_URESP_B // then present B (CVA6 pops its write FIFO on the atomic R,
                  // and discards the following B; presenting R strictly before
                  // B keeps that ordering and avoids the wr-FIFO underflow
                  // assertion in CVA6's wt_axi_adapter)
    } amo_st_e;
    amo_st_e st;

    logic [ID_W-1:0]    amo_id_q;
    logic [ADDR_W-1:0]  amo_addr_q;
    logic [2:0]         amo_size_q;
    logic [5:0]         amo_atop_q;
    logic [DATA_W-1:0]  amo_wdata_q;   // operand from the upstream W beat
    logic [DATA_W/8-1:0]amo_wstrb_q;
    logic [DATA_W-1:0]  amo_old_q;     // old memory value (returned on R)
    logic [DATA_W-1:0]  amo_new_q;     // computed value (written back)
    logic               amo_aw_done_q, amo_w_done_q;

    wire is_atomic_aw = u_aw_valid && (u_aw_atop != 6'b0);
    wire engine_busy  = (st != A_IDLE);

    // ---- LR/SC exclusive-access monitor ----
    // CVA6 issues RISC-V lr/sc as AXI exclusive accesses (AxLOCK=1), not as
    // ATOP atomics, and decodes the *response*: an exclusive read (lr) and an
    // exclusive write (sc) must return EXOKAY for the reservation/store to be
    // taken (sc returns success only on EXOKAY).  The downstream DRAM has no
    // exclusive monitor and always answers OKAY, so sc.d would perpetually fail
    // and OpenSBI's atomic_cmpxchg (lr.d/sc.d) would spin forever.
    //
    // This is the master-side exclusive monitor for the single in-order CVA6
    // hart: an lr arms the reservation; the following sc always succeeds
    // (nothing else in this single-master system can invalidate the line), so
    // we rewrite the exclusive R/B responses to EXOKAY.  Single-outstanding on
    // the read/write channels (CVA6 issues one lr/sc pair at a time), so a
    // captured lock flag per channel suffices.
    logic excl_ar_q;   // in-flight read is exclusive (lr)
    logic excl_aw_q;   // in-flight write is exclusive (sc)

    // ---- Compute new = f(old, operand) for the captured atomic. ----
    // Operand width is the atomic's access size (amo_size_q): 2 -> 32-bit word,
    // 3 -> 64-bit dword.  The active word sits at the byte offset implied by the
    // write strobes; CVA6 replicates the operand across the beat, so we operate
    // on the strobed lane and write only the strobed bytes back.
    function automatic logic [63:0] amo_compute(
            input logic [63:0] old_w, input logic [63:0] opnd,
            input logic [5:0] atop, input logic is32);
        logic [63:0] res;
        logic [31:0] o32, p32, r32;
        o32 = old_w[31:0];
        p32 = opnd[31:0];
        unique casez (atop)
            6'b110000: res = opnd;                              // ATOMICSWAP
            default: begin
                // ATOMICLOAD: atop[2:0] selects the op. AMO_AND is sent as CLR
                // with inverted operand by CVA6, so CLR == old & operand here.
                unique case (atop[2:0])
                    3'b000: res = is32 ? {{32{1'b0}}, o32 + p32}
                                       : old_w + opnd;          // ADD
                    3'b001: res = is32 ? {{32{1'b0}}, (o32 & p32)}
                                       : (old_w & opnd);        // CLR (AND)
                    3'b010: res = is32 ? {{32{1'b0}}, (o32 ^ p32)}
                                       : (old_w ^ opnd);        // EOR (XOR)
                    3'b011: res = is32 ? {{32{1'b0}}, (o32 | p32)}
                                       : (old_w | opnd);        // SET (OR)
                    3'b100: begin                               // SMAX
                        if (is32) begin
                            r32 = ($signed(o32) > $signed(p32)) ? o32 : p32;
                            res = {{32{1'b0}}, r32};
                        end else res = ($signed(old_w) > $signed(opnd)) ? old_w : opnd;
                    end
                    3'b101: begin                               // SMIN
                        if (is32) begin
                            r32 = ($signed(o32) < $signed(p32)) ? o32 : p32;
                            res = {{32{1'b0}}, r32};
                        end else res = ($signed(old_w) < $signed(opnd)) ? old_w : opnd;
                    end
                    3'b110: begin                               // UMAX
                        if (is32) begin
                            r32 = (o32 > p32) ? o32 : p32;
                            res = {{32{1'b0}}, r32};
                        end else res = (old_w > opnd) ? old_w : opnd;
                    end
                    3'b111: begin                               // UMIN
                        if (is32) begin
                            r32 = (o32 < p32) ? o32 : p32;
                            res = {{32{1'b0}}, r32};
                        end else res = (old_w < opnd) ? old_w : opnd;
                    end
                    default: res = opnd;
                endcase
            end
        endcase
        amo_compute = res;
    endfunction

    // ---- Channel muxing ----
    // AR / R: when idle, pass the upstream read through; while resolving an
    // atomic, the AR/R belong to the engine's private read.
    always_comb begin
        // Defaults: pass-through wiring.
        d_ar_id     = u_ar_id;
        d_ar_addr   = u_ar_addr;
        d_ar_len    = u_ar_len;
        d_ar_size   = u_ar_size;
        d_ar_burst  = u_ar_burst;
        d_ar_lock   = 1'b0;   // strip exclusivity; monitored in this adapter
        d_ar_cache  = u_ar_cache;
        d_ar_prot   = u_ar_prot;
        d_ar_qos    = u_ar_qos;
        d_ar_region = u_ar_region;
        d_ar_user   = u_ar_user;
        d_ar_valid  = u_ar_valid && !engine_busy;
        u_ar_ready  = d_ar_ready && !engine_busy;

        d_r_ready   = u_r_ready;
        u_r_id      = d_r_id;
        u_r_data    = d_r_data;
        // Exclusive read (lr): arm the reservation by answering EXOKAY.
        u_r_resp    = (excl_ar_q && (d_r_resp == RESP_OKAY)) ? RESP_EXOKAY : d_r_resp;
        u_r_last    = d_r_last;
        u_r_user    = d_r_user;
        u_r_valid   = d_r_valid;

        // AW / W / B pass-through (non-atomic).
        d_aw_id     = u_aw_id;
        d_aw_addr   = u_aw_addr;
        d_aw_len    = u_aw_len;
        d_aw_size   = u_aw_size;
        d_aw_burst  = u_aw_burst;
        d_aw_lock   = 1'b0;   // strip exclusivity; monitored in this adapter
        d_aw_cache  = u_aw_cache;
        d_aw_prot   = u_aw_prot;
        d_aw_qos    = u_aw_qos;
        d_aw_region = u_aw_region;
        d_aw_atop   = 6'b0;                 // never forward atop downstream
        d_aw_user   = u_aw_user;
        d_aw_valid  = u_aw_valid && !is_atomic_aw && !engine_busy;
        u_aw_ready  = d_aw_ready && !is_atomic_aw && !engine_busy;

        d_w_data    = u_w_data;
        d_w_strb    = u_w_strb;
        d_w_last    = u_w_last;
        d_w_user    = u_w_user;
        d_w_valid   = u_w_valid && !engine_busy && !is_atomic_aw;
        u_w_ready   = d_w_ready && !engine_busy && !is_atomic_aw;

        d_b_ready   = u_b_ready;
        u_b_id      = d_b_id;
        // Exclusive write (sc): the reservation is still held (single master),
        // so the store succeeds — answer EXOKAY so CVA6 records sc success.
        u_b_resp    = (excl_aw_q && (d_b_resp == RESP_OKAY)) ? RESP_EXOKAY : d_b_resp;
        u_b_user    = d_b_user;
        u_b_valid   = d_b_valid;

        // Accept the atomic's AW in A_IDLE (latched in the FF block); the
        // operand W beat is captured in A_WCAP.
        if (st == A_IDLE && is_atomic_aw) begin
            u_aw_ready = 1'b1;
            u_w_ready  = 1'b0;
            d_aw_valid = 1'b0;
            d_w_valid  = 1'b0;
        end

        // ---- Engine overrides while resolving an atomic ----
        if (engine_busy) begin
            u_w_ready = (st == A_WCAP);   // capture the operand beat

            unique case (st)
                A_WCAP: begin
                    // Hold downstream AR/AW idle; just wait for the operand W.
                    u_ar_ready = 1'b0;
                end
                A_RD: begin
                    d_ar_id     = amo_id_q;
                    d_ar_addr   = amo_addr_q;
                    d_ar_len    = 8'h0;
                    d_ar_size   = amo_size_q;
                    d_ar_burst  = 2'b01;
                    d_ar_lock   = 1'b0;
                    d_ar_cache  = 4'h0;
                    d_ar_prot   = 3'h0;
                    d_ar_qos    = 4'h0;
                    d_ar_region = 4'h0;
                    d_ar_user   = '0;
                    d_ar_valid  = 1'b1;
                    u_ar_ready  = 1'b0;
                end
                A_RDATA: begin
                    d_r_ready  = 1'b1;   // consume the engine's read data
                    u_r_valid  = 1'b0;   // not yet presented upstream
                    u_ar_ready = 1'b0;
                end
                A_WR: begin
                    d_aw_id     = amo_id_q;
                    d_aw_addr   = amo_addr_q;
                    d_aw_len    = 8'h0;
                    d_aw_size   = amo_size_q;
                    d_aw_burst  = 2'b01;
                    d_aw_lock   = 1'b0;
                    d_aw_cache  = 4'h0;
                    d_aw_prot   = 3'h0;
                    d_aw_qos    = 4'h0;
                    d_aw_region = 4'h0;
                    d_aw_atop   = 6'b0;
                    d_aw_user   = '0;
                    d_aw_valid  = !amo_aw_done_q;
                    d_w_data    = amo_new_q;
                    d_w_strb    = amo_wstrb_q;
                    d_w_last    = 1'b1;
                    d_w_user    = '0;
                    d_w_valid   = !amo_w_done_q;
                    u_aw_ready  = 1'b0;
                    u_w_ready   = 1'b0;
                end
                A_WB: begin
                    d_b_ready = 1'b1;    // consume the engine's write response
                    u_b_valid = 1'b0;
                end
                A_URESP_R: begin
                    // Present the captured OLD value on R first.
                    u_r_id    = amo_id_q;
                    u_r_data  = amo_old_q;
                    u_r_resp  = RESP_OKAY;
                    u_r_last  = 1'b1;
                    u_r_user  = '0;
                    u_r_valid = 1'b1;
                    d_r_ready = 1'b0;
                    u_b_valid = 1'b0;
                end
                A_URESP_B: begin
                    // Then the B response.
                    u_b_id    = amo_id_q;
                    u_b_resp  = RESP_OKAY;
                    u_b_user  = '0;
                    u_b_valid = 1'b1;
                    d_b_ready = 1'b0;
                    u_r_valid = 1'b0;
                end
                default: begin end
            endcase
        end
    end

    // Exclusive-access tracking.  An exclusive AR/AW that passes through (only
    // possible when the AMO engine is idle — atomics never carry AxLOCK) sets
    // the flag, which is consumed when the matching R(last)/B is forwarded.
    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            excl_ar_q <= 1'b0;
            excl_aw_q <= 1'b0;
        end else begin
            if (u_ar_valid && u_ar_ready) excl_ar_q <= u_ar_lock;
            else if (u_r_valid && u_r_ready && u_r_last) excl_ar_q <= 1'b0;
            if (u_aw_valid && u_aw_ready) excl_aw_q <= u_aw_lock && (u_aw_atop == 6'b0);
            else if (u_b_valid && u_b_ready) excl_aw_q <= 1'b0;
        end
    end

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            st            <= A_IDLE;
            amo_id_q      <= '0;
            amo_addr_q    <= '0;
            amo_size_q    <= '0;
            amo_atop_q    <= '0;
            amo_wdata_q   <= '0;
            amo_wstrb_q   <= '0;
            amo_old_q     <= '0;
            amo_new_q     <= '0;
            amo_aw_done_q <= 1'b0;
            amo_w_done_q  <= 1'b0;
        end else begin
            unique case (st)
                A_IDLE: begin
                    if (is_atomic_aw) begin
                        amo_id_q   <= u_aw_id;
                        amo_addr_q <= u_aw_addr;
                        amo_size_q <= u_aw_size;
                        amo_atop_q <= u_aw_atop;
                        st         <= A_WCAP;
                    end
                end
                A_WCAP: begin
                    if (u_w_valid && u_w_ready) begin
                        amo_wdata_q <= u_w_data;
                        amo_wstrb_q <= u_w_strb;
                        st          <= A_RD;
                    end
                end
                A_RD: begin
                    if (d_ar_valid && d_ar_ready) st <= A_RDATA;
                end
                A_RDATA: begin
                    if (d_r_valid && d_r_ready) begin
                        logic is32;
                        logic upper;          // 32-bit atomic targets the upper word
                        logic [63:0] opnd, old_aligned, res;
                        is32  = (amo_size_q == 3'd2);
                        // For a 32-bit atomic the active lane is bytes [7:4] when
                        // the access address bit 2 is set; align both old and
                        // operand to bits [31:0] for the compute, then place the
                        // result back in the active lane.  64-bit atomics use the
                        // whole beat.
                        upper = is32 && amo_addr_q[2];
                        opnd        = upper ? {32'h0, amo_wdata_q[63:32]} : amo_wdata_q;
                        old_aligned = upper ? {32'h0, d_r_data[63:32]}    : d_r_data;
                        // Return the raw memory beat on R; CVA6 extracts the
                        // loaded word by address on its side.
                        amo_old_q   <= d_r_data;
                        res = amo_compute(old_aligned, opnd, amo_atop_q, is32);
                        // Writeback: preserve untouched bytes, overwrite the lane.
                        if (upper) amo_new_q <= {res[31:0], d_r_data[31:0]};
                        else if (is32) amo_new_q <= {d_r_data[63:32], res[31:0]};
                        else amo_new_q <= res;
                        amo_aw_done_q <= 1'b0;
                        amo_w_done_q  <= 1'b0;
                        st <= A_WR;
                    end
                end
                A_WR: begin
                    if (d_aw_valid && d_aw_ready) amo_aw_done_q <= 1'b1;
                    if (d_w_valid  && d_w_ready)  amo_w_done_q  <= 1'b1;
                    if ((amo_aw_done_q || (d_aw_valid && d_aw_ready)) &&
                        (amo_w_done_q  || (d_w_valid  && d_w_ready))) begin
                        st <= A_WB;
                    end
                end
                A_WB: begin
                    if (d_b_valid && d_b_ready) st <= A_URESP_R;
                end
                A_URESP_R: begin
                    // R strictly before B (CVA6 pops its write-tracking FIFO on
                    // the atomic R and discards the following B).
                    if (u_r_valid && u_r_ready) st <= A_URESP_B;
                end
                A_URESP_B: begin
                    if (u_b_valid && u_b_ready) st <= A_IDLE;
                end
                default: st <= A_IDLE;
            endcase
        end
    end

    /* verilator lint_off UNUSEDSIGNAL */
    logic unused;
    assign unused = ^{u_w_last};
    /* verilator lint_on UNUSEDSIGNAL */

endmodule
