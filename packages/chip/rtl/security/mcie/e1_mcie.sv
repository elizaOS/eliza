`timescale 1ns/1ps

// e1_mcie
//
// Memory Crypto + Integrity Engine (MCIE) -- the lane-01 S3 primitive that
// encrypts and integrity-protects confidential DRAM lines at the memory-
// controller boundary (docs/security/tee-plan/01-tee-core-architecture.md S3,
// 00-overview.md S2, 04-side-channel-physical-hardening.md S3). It sits
// downstream of the system cache and the MTT check (rtl/security/mtt/
// e1_mtt_checker.sv supplies the per-page confidentiality class) and upstream
// of the LPDDR5X PHY / DRAM controller (rtl/memory/dram_ctrl/e1_dram_ctrl.sv).
//
// CONTRACT (and why NOT XTS). Confidentiality uses counter-mode AES, never
// deterministic address-tweaked XTS: keystream = AES_K({line_addr, counter}),
// ciphertext = plaintext XOR keystream, with a MONOTONIC per-line write counter
// that increments on every write. Two writes of identical plaintext to the same
// line therefore produce DIFFERENT ciphertext -- defeating the TEE.fail /
// CipherLeaks ciphertext-equality side channel that breaks XTS. Integrity +
// anti-replay use a per-line CBC-MAC over {line_addr, counter} || ciphertext
// plus a counter-integrity tree: a read VERIFIES that (a) the presented counter
// equals the authoritative on-die counter for that line (anti-rollback) and
// (b) the recomputed MAC equals the stored MAC (anti-forge). On either failure
// the read is FAIL-CLOSED: no plaintext is returned, an integrity fault is
// raised and latched, and integ_fault_o pulses to the RoT/alert network.
//
// PORTS.
//   Request port (from the bus side, after the MTT check): a one-line request
//   {op, page state, line address, write data}. The engine returns done with
//   {read data, ok}. ok=0 on a read means an integrity failure (plaintext is
//   suppressed and held at zero). This is line-granular, not full AXI; the
//   AXI4 splice into e1_dram_ctrl is a SoC-integration follow-on (claim
//   boundary).
//
//   Backing-store master port: the engine reads/writes the attacker-visible
//   DRAM record for a line -- {ciphertext[127:0], counter[63:0], mac[127:0]} --
//   through a simple valid/ready request + valid response handshake. The
//   testbench (and, in silicon, the DRAM controller) provides this store. The
//   counter ALSO lives authoritatively in the on-die counter cache; the copy in
//   DRAM is attacker-visible and is the value a replay attacker would roll back,
//   which is exactly why verification compares against the on-die copy.
//
// FRESHNESS-MODEL AGREEMENT. The keystream/MAC/verify semantics mirror
// scripts/tee/mee_freshness_model.py: per-line 64-bit monotonic counter,
// keystream a function of (key/seed, addr, counter), MAC a function of (addr,
// counter, ciphertext), verify requires counter == on-die counter then MAC
// match, and a per-boot root seed (boot_seed_i) so a cross-boot triple fails.
//
// Synthesizable: single clock, synchronous-release async-assert reset, no
// initial blocks, no delays, no X-injection. The on-die counter cache is a
// small direct-mapped register array (COUNTER_CACHE_ENTRIES). The DRAM-side
// bandwidth of fetching/writing the {ct,counter,mac} record and walking the
// counter tree is a PHYSICAL cost on real LPDDR5X (see 04 S3 [PERF]); this
// block proves the engine against a backing-memory model, not silicon
// bandwidth.

module e1_mcie
  import e1_mcie_pkg::*;
(
    input  logic clk,
    input  logic rst_n,

    // Per-boot root seed for the keystream/MAC (reseeded each cold boot so a
    // captured cross-boot triple cannot verify). In silicon this is derived
    // from the RoT (lane 02); here it is an input the platform programs once.
    input  logic [KEY_BITS-1:0]  boot_seed_i,   // folded into the AES keys
    input  logic                 seed_valid_i,  // keys are valid / engine armed

    // -- Request port (post-MTT bus side) ------------------------------------
    input  logic                 req_valid,
    output logic                 req_ready,
    input  logic                 req_op,        // OP_READ / OP_WRITE
    input  logic [2:0]           req_state,     // MTT page class (PS_*)
    input  logic [ADDR_BITS-1:0] req_addr,      // line address (line-aligned)
    input  logic [LINE_BITS-1:0] req_wdata,     // plaintext to encrypt (writes)

    output logic                 rsp_valid,
    output logic [LINE_BITS-1:0] rsp_rdata,     // plaintext (reads); 0 on fault
    output logic                 rsp_ok,        // 1 = verified; 0 = integrity fault
    output logic [1:0]           rsp_fault,     // FAULT_* cause when !rsp_ok

    // Sticky integrity-fault state for the RoT / alert network.
    output logic                 integ_fault_o, // 1-cycle pulse on each fault
    output logic                 integ_fault_sticky_o,
    output logic [1:0]           integ_fault_cause_o,
    output logic [ADDR_BITS-1:0] integ_fault_addr_o,

    // -- Backing-store master port (attacker-visible DRAM record) ------------
    // The engine asks the store to read or write a line's {ct,counter,mac}
    // record. One outstanding request; the store answers with mem_rsp_valid.
    output logic                 mem_req_valid,
    input  logic                 mem_req_ready,
    output logic                 mem_req_we,    // 1 = write the record, 0 = read
    output logic [ADDR_BITS-1:0] mem_req_addr,
    output logic [LINE_BITS-1:0] mem_req_ct,
    output logic [COUNTER_BITS-1:0] mem_req_counter,
    output logic [MAC_BITS-1:0]  mem_req_mac,

    input  logic                 mem_rsp_valid,
    input  logic [LINE_BITS-1:0] mem_rsp_ct,
    input  logic [COUNTER_BITS-1:0] mem_rsp_counter,
    input  logic [MAC_BITS-1:0]  mem_rsp_mac
);

  // ------------------------------------------------------------------
  // Keys. The confidentiality key and the MAC key are derived from the
  // per-boot seed by domain separation (a fixed constant XOR) so a single
  // seed yields two independent keys. In silicon these come from the RoT key
  // ladder (lane 02); the domain-separation shape is what matters here.
  // ------------------------------------------------------------------
  localparam logic [KEY_BITS-1:0] ENC_DOMAIN = 128'h0;
  localparam logic [KEY_BITS-1:0] MAC_DOMAIN = 128'h4d41_4300_4d41_4300_4d41_4300_4d41_4300;
  logic [KEY_BITS-1:0] enc_key, mac_key;
  assign enc_key = boot_seed_i ^ ENC_DOMAIN;
  assign mac_key = boot_seed_i ^ MAC_DOMAIN;

  // ------------------------------------------------------------------
  // On-die direct-mapped counter cache: the AUTHORITATIVE per-line counter.
  // valid/tag/counter per entry. A read of a confidential line whose counter
  // is not present (never written this boot) is a fault (FAULT_NO_COUNTER):
  // there is nothing to verify against, and returning the DRAM counter blindly
  // would defeat anti-replay.
  //
  // This models the leaf of the counter-integrity tree held on-die; a cache
  // miss in silicon walks the tree to DRAM and verifies node MACs to the
  // on-die root. The model keeps the authoritative counter resident so the
  // freshness invariant (presented==authoritative) is checkable now.
  // ------------------------------------------------------------------
  logic                    cc_valid   [0:COUNTER_CACHE_ENTRIES-1];
  logic [ADDR_BITS-1:0]    cc_tag     [0:COUNTER_CACHE_ENTRIES-1];
  logic [COUNTER_BITS-1:0] cc_counter [0:COUNTER_CACHE_ENTRIES-1];

  // Maximum leaf count one fully-resident counter subtree binds: TREE_ARITY^
  // TREE_LEVELS. The on-die counter cache (COUNTER_CACHE_ENTRIES) is the
  // hot working set of those leaves; the rest are walked from DRAM on a miss
  // and verified up to the on-die root. Pinning it here ties the cache to the
  // tree geometry declared in the package contract.
  localparam int unsigned TREE_LEAF_CAP = TREE_ARITY ** TREE_LEVELS;
  // Elaboration sanity: the cache must be a strict subset of the subtree it
  // caches (it is a cache, not the whole tree).
  if (COUNTER_CACHE_ENTRIES > TREE_LEAF_CAP) begin : gen_tree_cap_check
    $error("counter cache larger than the tree subtree it caches");
  end

  /* verilator lint_off UNUSEDSIGNAL */
  function automatic logic [CC_IDX_BITS-1:0] cc_index(input logic [ADDR_BITS-1:0] a);
    cc_index = a[CC_IDX_BITS-1:0];  // only the low index bits select the set
  endfunction
  /* verilator lint_on UNUSEDSIGNAL */

  // ------------------------------------------------------------------
  // FSM. A request is processed to completion before the next is accepted
  // (one in flight). The engine drives the shared AES core for the CTR
  // keystream and the two-block CBC-MAC.
  //
  // WRITE path: bump on-die counter -> AES keystream over {addr,counter} ->
  //   ct = pt ^ ks -> CBC-MAC over {addr,counter} then ct -> store the record.
  // READ path: fetch the record -> verify presented counter == on-die counter
  //   (else FAULT_ROLLBACK / FAULT_NO_COUNTER) -> recompute MAC and compare
  //   (else FAULT_MAC) -> only then AES keystream and decrypt.
  // PASSTHROUGH (non-confidential): writes store plaintext as ct with counter
  //   0 and a zero MAC; reads return the stored bytes verbatim, no crypto.
  // ------------------------------------------------------------------
  typedef enum logic [3:0] {
    S_IDLE,
    // write
    S_W_KS,         // run AES keystream
    S_W_MAC0,       // CBC-MAC block 0 = {addr,counter}
    S_W_MAC1,       // CBC-MAC block 1 = ct ^ E(block0)
    S_W_STORE,      // issue store request
    S_W_STORE_WAIT, // wait store accept
    // read
    S_R_FETCH,      // issue record read
    S_R_FETCH_WAIT, // wait record response
    S_R_VERIFY,     // counter check + start MAC recompute
    S_R_MAC1,       // CBC-MAC block 1
    S_R_MACCHK,     // compare MAC; start keystream if ok
    S_R_KS,         // keystream for decrypt
    // passthrough
    S_P_STORE,
    S_P_STORE_WAIT,
    S_P_FETCH_WAIT
  } state_e;

  state_e state_q;

  // Latched request.
  logic [ADDR_BITS-1:0]    addr_q;
  logic [LINE_BITS-1:0]    wdata_q;

  // Working registers.
  logic [COUNTER_BITS-1:0] counter_q;     // counter for this op
  logic [LINE_BITS-1:0]    ct_q;          // ciphertext
  logic [LINE_BITS-1:0]    mac_chain_q;   // CBC-MAC running chain
  logic [LINE_BITS-1:0]    fetched_ct_q;
  logic [COUNTER_BITS-1:0] fetched_ctr_q;
  logic [MAC_BITS-1:0]     fetched_mac_q;
  logic [CC_IDX_BITS-1:0]  idx_q;

  // AES core instance (shared between keystream and MAC).
  logic         aes_start;
  logic [127:0] aes_key;
  logic [127:0] aes_block;
  logic         aes_done;
  logic [127:0] aes_ct;
  // The FSM sequences exactly one AES op per state by construction (it always
  // waits for aes_done before issuing the next start), so busy_o is observed
  // only via done_o and is intentionally left unconnected.
  /* verilator lint_off UNUSEDSIGNAL */
  logic         aes_busy_unused;
  /* verilator lint_on UNUSEDSIGNAL */

  e1_mcie_aes u_aes (
      .clk    (clk),
      .rst_n  (rst_n),
      .start_i(aes_start),
      .key_i  (aes_key),
      .block_i(aes_block),
      .busy_o (aes_busy_unused),
      .done_o (aes_done),
      .ct_o   (aes_ct)
  );

  // The {addr, counter} block packed into 128 bits: addr in the high half,
  // counter in the low half (matches the freshness model's payload ordering of
  // addr then counter; the exact byte order is internal and self-consistent).
  function automatic logic [127:0] ac_block(
      input logic [ADDR_BITS-1:0]    a,
      input logic [COUNTER_BITS-1:0] c
  );
    ac_block = {a, c};
  endfunction

  // Backing-store request port is driven combinationally from the FSM state;
  // the AES core is driven by the registered aes_* signals in the sequencer.
  always_comb begin
    mem_req_valid   = 1'b0;
    mem_req_we      = 1'b0;
    mem_req_addr    = addr_q;
    mem_req_ct      = ct_q;
    mem_req_counter = counter_q;
    mem_req_mac     = mac_chain_q;
    req_ready       = (state_q == S_IDLE) && seed_valid_i;

    unique case (state_q)
      S_W_STORE, S_P_STORE: begin
        mem_req_valid = 1'b1;
        mem_req_we    = 1'b1;
      end
      S_R_FETCH: begin
        mem_req_valid = 1'b1;
        mem_req_we    = 1'b0;
      end
      S_P_FETCH_WAIT: begin
        // Passthrough read: issue the record read and wait for the response in
        // the same state (the store returns the plaintext bytes verbatim).
        mem_req_valid = 1'b1;
        mem_req_we    = 1'b0;
      end
      default: ;
    endcase
  end

  // ------------------------------------------------------------------
  // Sequencer.
  // ------------------------------------------------------------------
  integer i;
  always_ff @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin
      state_q       <= S_IDLE;
      addr_q        <= '0;
      wdata_q       <= '0;
      counter_q     <= '0;
      ct_q          <= '0;
      mac_chain_q   <= '0;
      fetched_ct_q  <= '0;
      fetched_ctr_q <= '0;
      fetched_mac_q <= '0;
      idx_q         <= '0;
      aes_start     <= 1'b0;
      aes_key       <= '0;
      aes_block     <= '0;
      rsp_valid     <= 1'b0;
      rsp_rdata     <= '0;
      rsp_ok        <= 1'b0;
      rsp_fault     <= FAULT_NONE;
      integ_fault_o <= 1'b0;
      integ_fault_sticky_o <= 1'b0;
      integ_fault_cause_o  <= FAULT_NONE;
      integ_fault_addr_o   <= '0;
      for (i = 0; i < COUNTER_CACHE_ENTRIES; i++) begin
        cc_valid[i]   <= 1'b0;
        cc_tag[i]     <= '0;
        cc_counter[i] <= '0;
      end
    end else begin
      // Single-cycle pulses default low.
      rsp_valid     <= 1'b0;
      integ_fault_o <= 1'b0;
      aes_start     <= 1'b0;

      unique case (state_q)
        // ----------------------------------------------------------------
        S_IDLE: begin
          if (req_valid && req_ready) begin
            addr_q   <= req_addr;
            wdata_q  <= req_wdata;
            idx_q    <= cc_index(req_addr);
            if (is_confidential(req_state)) begin
              if (req_op == OP_WRITE) begin
                // Bump the authoritative on-die counter for this line.
                logic [COUNTER_BITS-1:0] nextc;
                logic [CC_IDX_BITS-1:0]  ix;
                ix = cc_index(req_addr);
                if (cc_valid[ix] && (cc_tag[ix] == req_addr))
                  nextc = cc_counter[ix] + 64'd1;
                else
                  nextc = 64'd1;
                cc_valid[ix]   <= 1'b1;
                cc_tag[ix]     <= req_addr;
                cc_counter[ix] <= nextc;
                counter_q      <= nextc;
                // Start the CTR keystream over {addr, nextc}.
                aes_key   <= enc_key;
                aes_block <= ac_block(req_addr, nextc);
                aes_start <= 1'b1;
                state_q   <= S_W_KS;
              end else if (req_op == OP_READ) begin
                // Read of a confidential line: fetch the DRAM record.
                state_q <= S_R_FETCH;
              end
            end else if (is_passthrough(req_state)) begin
              // free/shared/scrub-pending: not MCIE-encrypted (the host needs
              // free/shared in the clear; scrub-pending is denied upstream by
              // the MTT and never carries real data here).
              if (req_op == OP_WRITE) begin
                ct_q        <= req_wdata; // store plaintext verbatim
                counter_q   <= '0;
                mac_chain_q <= '0;
                state_q     <= S_P_STORE;
              end else begin
                state_q <= S_P_FETCH_WAIT; // issue + wait handled below
              end
            end
          end
        end

        // ============ WRITE (confidential) ============================
        S_W_KS: begin
          if (aes_done) begin
            // ct = pt ^ keystream.
            ct_q <= wdata_q ^ aes_ct;
            // Start CBC-MAC: E_macK({addr,counter}).
            aes_key   <= mac_key;
            aes_block <= ac_block(addr_q, counter_q);
            aes_start <= 1'b1;
            state_q   <= S_W_MAC0;
          end
        end
        S_W_MAC0: begin
          if (aes_done) begin
            mac_chain_q <= aes_ct;
            // Block 1 = ct ^ E(block0).
            aes_key   <= mac_key;
            aes_block <= ct_q ^ aes_ct;
            aes_start <= 1'b1;
            state_q   <= S_W_MAC1;
          end
        end
        S_W_MAC1: begin
          if (aes_done) begin
            mac_chain_q <= aes_ct;   // final CBC-MAC tag
            state_q     <= S_W_STORE;
          end
        end
        S_W_STORE: begin
          if (mem_req_ready) state_q <= S_W_STORE_WAIT;
        end
        S_W_STORE_WAIT: begin
          // Store has no read response; complete on the cycle after accept.
          rsp_valid <= 1'b1;
          rsp_ok    <= 1'b1;
          rsp_rdata <= '0;
          rsp_fault <= FAULT_NONE;
          state_q   <= S_IDLE;
        end

        // ============ READ (confidential) =============================
        S_R_FETCH: begin
          if (mem_req_ready) state_q <= S_R_FETCH_WAIT;
        end
        S_R_FETCH_WAIT: begin
          if (mem_rsp_valid) begin
            fetched_ct_q  <= mem_rsp_ct;
            fetched_ctr_q <= mem_rsp_counter;
            fetched_mac_q <= mem_rsp_mac;
            state_q       <= S_R_VERIFY;
          end
        end
        S_R_VERIFY: begin
          // Anti-replay: the presented counter MUST equal the on-die one.
          if (!(cc_valid[idx_q] && (cc_tag[idx_q] == addr_q))) begin
            // No authoritative counter for this confidential line -> fault.
            rsp_valid     <= 1'b1;
            rsp_ok        <= 1'b0;
            rsp_rdata     <= '0;
            rsp_fault     <= FAULT_NO_COUNTER;
            integ_fault_o <= 1'b1;
            integ_fault_sticky_o <= 1'b1;
            integ_fault_cause_o  <= FAULT_NO_COUNTER;
            integ_fault_addr_o   <= addr_q;
            state_q       <= S_IDLE;
          end else if (fetched_ctr_q != cc_counter[idx_q]) begin
            // Rolled-back / replayed counter -> fail closed, no plaintext.
            rsp_valid     <= 1'b1;
            rsp_ok        <= 1'b0;
            rsp_rdata     <= '0;
            rsp_fault     <= FAULT_ROLLBACK;
            integ_fault_o <= 1'b1;
            integ_fault_sticky_o <= 1'b1;
            integ_fault_cause_o  <= FAULT_ROLLBACK;
            integ_fault_addr_o   <= addr_q;
            state_q       <= S_IDLE;
          end else begin
            // Counter fresh: recompute the CBC-MAC over {addr,counter}||ct.
            counter_q <= cc_counter[idx_q];
            aes_key   <= mac_key;
            aes_block <= ac_block(addr_q, cc_counter[idx_q]);
            aes_start <= 1'b1;
            state_q   <= S_R_MAC1;
          end
        end
        S_R_MAC1: begin
          if (aes_done) begin
            aes_key   <= mac_key;
            aes_block <= fetched_ct_q ^ aes_ct;
            aes_start <= 1'b1;
            state_q   <= S_R_MACCHK;
          end
        end
        S_R_MACCHK: begin
          if (aes_done) begin
            if (aes_ct != fetched_mac_q) begin
              // Tampered ciphertext or forged MAC -> fail closed.
              rsp_valid     <= 1'b1;
              rsp_ok        <= 1'b0;
              rsp_rdata     <= '0;
              rsp_fault     <= FAULT_MAC;
              integ_fault_o <= 1'b1;
              integ_fault_sticky_o <= 1'b1;
              integ_fault_cause_o  <= FAULT_MAC;
              integ_fault_addr_o   <= addr_q;
              state_q       <= S_IDLE;
            end else begin
              // Verified: only NOW generate the keystream and decrypt.
              aes_key   <= enc_key;
              aes_block <= ac_block(addr_q, counter_q);
              aes_start <= 1'b1;
              state_q   <= S_R_KS;
            end
          end
        end
        S_R_KS: begin
          if (aes_done) begin
            rsp_valid <= 1'b1;
            rsp_ok    <= 1'b1;
            rsp_rdata <= fetched_ct_q ^ aes_ct;
            rsp_fault <= FAULT_NONE;
            state_q   <= S_IDLE;
          end
        end

        // ============ PASSTHROUGH (non-confidential) ==================
        S_P_STORE: begin
          if (mem_req_ready) state_q <= S_P_STORE_WAIT;
        end
        S_P_STORE_WAIT: begin
          rsp_valid <= 1'b1;
          rsp_ok    <= 1'b1;
          rsp_rdata <= '0;
          rsp_fault <= FAULT_NONE;
          state_q   <= S_IDLE;
        end
        S_P_FETCH_WAIT: begin
          // Issue the read on entry handled by combinational mem_req in S_R_FETCH
          // is for confidential reads; passthrough reads use this state to both
          // issue and collect. Drive mem_req here.
          if (mem_rsp_valid) begin
            rsp_valid <= 1'b1;
            rsp_ok    <= 1'b1;
            rsp_rdata <= mem_rsp_ct; // plaintext stored verbatim
            rsp_fault <= FAULT_NONE;
            state_q   <= S_IDLE;
          end
        end

        default: state_q <= S_IDLE;
      endcase
    end
  end

endmodule
