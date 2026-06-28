`timescale 1ns/1ps

// e1_mcie_aes
//
// Compact, synthesizable AES-128 ENCRYPT-only core for the Memory Crypto +
// Integrity Engine (MCIE, lane 01, docs/security/tee-plan/01-tee-core-
// architecture.md S3). The MCIE uses AES in two roles, both of which need
// only the forward (encrypt) transform:
//
//   * CTR-mode keystream: keystream = AES_K(counter_block); plaintext is XORed
//     with the keystream and the same keystream regenerates on read. No inverse
//     cipher is required for counter-mode confidentiality.
//   * CBC-MAC integrity tag: a chain of AES_Kmac(...) encryptions over the
//     {addr, counter} and ciphertext blocks. CBC-MAC is forward-only too.
//
// So this core implements ONLY the forward AES-128 round (SubBytes,
// ShiftRows, MixColumns, AddRoundKey) and the forward key schedule. It is an
// iterative one-round-per-cycle design (10 rounds + the initial AddRoundKey),
// not unrolled, to keep area modest -- exactly the engineering trade the MCIE
// wants at a memory boundary where throughput is bounded by DRAM, not the
// cipher.
//
// Interface: pulse start_i with a 128-bit block_i and key_i; the core runs the
// key schedule and rounds and asserts done_o for one cycle with ct_o valid.
// busy_o is high while a block is in flight. Single clock, synchronous-release
// async-assert reset, no initial blocks, no delays -> synthesizable and
// lint-clean.
//
// Byte/state convention: AES operates on a 4x4 column-major state. block_i is
// the 128-bit input with byte 0 = block_i[127:120] (the standard big-endian
// "first byte" mapping used by FIPS-197 test vectors), so the FIPS-197 AppB/
// AppC known-answer vectors apply directly and the cocotb KAT can check them.

module e1_mcie_aes (
    input  logic         clk,
    input  logic         rst_n,

    input  logic         start_i,
    input  logic [127:0] key_i,
    input  logic [127:0] block_i,

    output logic         busy_o,
    output logic         done_o,
    output logic [127:0] ct_o
);

  // ------------------------------------------------------------------
  // AES forward S-box (FIPS-197 Figure 7).
  // ------------------------------------------------------------------
  function automatic logic [7:0] sbox(input logic [7:0] b);
    logic [7:0] s;
    unique case (b)
      8'h00: s = 8'h63; 8'h01: s = 8'h7c; 8'h02: s = 8'h77; 8'h03: s = 8'h7b;
      8'h04: s = 8'hf2; 8'h05: s = 8'h6b; 8'h06: s = 8'h6f; 8'h07: s = 8'hc5;
      8'h08: s = 8'h30; 8'h09: s = 8'h01; 8'h0a: s = 8'h67; 8'h0b: s = 8'h2b;
      8'h0c: s = 8'hfe; 8'h0d: s = 8'hd7; 8'h0e: s = 8'hab; 8'h0f: s = 8'h76;
      8'h10: s = 8'hca; 8'h11: s = 8'h82; 8'h12: s = 8'hc9; 8'h13: s = 8'h7d;
      8'h14: s = 8'hfa; 8'h15: s = 8'h59; 8'h16: s = 8'h47; 8'h17: s = 8'hf0;
      8'h18: s = 8'had; 8'h19: s = 8'hd4; 8'h1a: s = 8'ha2; 8'h1b: s = 8'haf;
      8'h1c: s = 8'h9c; 8'h1d: s = 8'ha4; 8'h1e: s = 8'h72; 8'h1f: s = 8'hc0;
      8'h20: s = 8'hb7; 8'h21: s = 8'hfd; 8'h22: s = 8'h93; 8'h23: s = 8'h26;
      8'h24: s = 8'h36; 8'h25: s = 8'h3f; 8'h26: s = 8'hf7; 8'h27: s = 8'hcc;
      8'h28: s = 8'h34; 8'h29: s = 8'ha5; 8'h2a: s = 8'he5; 8'h2b: s = 8'hf1;
      8'h2c: s = 8'h71; 8'h2d: s = 8'hd8; 8'h2e: s = 8'h31; 8'h2f: s = 8'h15;
      8'h30: s = 8'h04; 8'h31: s = 8'hc7; 8'h32: s = 8'h23; 8'h33: s = 8'hc3;
      8'h34: s = 8'h18; 8'h35: s = 8'h96; 8'h36: s = 8'h05; 8'h37: s = 8'h9a;
      8'h38: s = 8'h07; 8'h39: s = 8'h12; 8'h3a: s = 8'h80; 8'h3b: s = 8'he2;
      8'h3c: s = 8'heb; 8'h3d: s = 8'h27; 8'h3e: s = 8'hb2; 8'h3f: s = 8'h75;
      8'h40: s = 8'h09; 8'h41: s = 8'h83; 8'h42: s = 8'h2c; 8'h43: s = 8'h1a;
      8'h44: s = 8'h1b; 8'h45: s = 8'h6e; 8'h46: s = 8'h5a; 8'h47: s = 8'ha0;
      8'h48: s = 8'h52; 8'h49: s = 8'h3b; 8'h4a: s = 8'hd6; 8'h4b: s = 8'hb3;
      8'h4c: s = 8'h29; 8'h4d: s = 8'he3; 8'h4e: s = 8'h2f; 8'h4f: s = 8'h84;
      8'h50: s = 8'h53; 8'h51: s = 8'hd1; 8'h52: s = 8'h00; 8'h53: s = 8'hed;
      8'h54: s = 8'h20; 8'h55: s = 8'hfc; 8'h56: s = 8'hb1; 8'h57: s = 8'h5b;
      8'h58: s = 8'h6a; 8'h59: s = 8'hcb; 8'h5a: s = 8'hbe; 8'h5b: s = 8'h39;
      8'h5c: s = 8'h4a; 8'h5d: s = 8'h4c; 8'h5e: s = 8'h58; 8'h5f: s = 8'hcf;
      8'h60: s = 8'hd0; 8'h61: s = 8'hef; 8'h62: s = 8'haa; 8'h63: s = 8'hfb;
      8'h64: s = 8'h43; 8'h65: s = 8'h4d; 8'h66: s = 8'h33; 8'h67: s = 8'h85;
      8'h68: s = 8'h45; 8'h69: s = 8'hf9; 8'h6a: s = 8'h02; 8'h6b: s = 8'h7f;
      8'h6c: s = 8'h50; 8'h6d: s = 8'h3c; 8'h6e: s = 8'h9f; 8'h6f: s = 8'ha8;
      8'h70: s = 8'h51; 8'h71: s = 8'ha3; 8'h72: s = 8'h40; 8'h73: s = 8'h8f;
      8'h74: s = 8'h92; 8'h75: s = 8'h9d; 8'h76: s = 8'h38; 8'h77: s = 8'hf5;
      8'h78: s = 8'hbc; 8'h79: s = 8'hb6; 8'h7a: s = 8'hda; 8'h7b: s = 8'h21;
      8'h7c: s = 8'h10; 8'h7d: s = 8'hff; 8'h7e: s = 8'hf3; 8'h7f: s = 8'hd2;
      8'h80: s = 8'hcd; 8'h81: s = 8'h0c; 8'h82: s = 8'h13; 8'h83: s = 8'hec;
      8'h84: s = 8'h5f; 8'h85: s = 8'h97; 8'h86: s = 8'h44; 8'h87: s = 8'h17;
      8'h88: s = 8'hc4; 8'h89: s = 8'ha7; 8'h8a: s = 8'h7e; 8'h8b: s = 8'h3d;
      8'h8c: s = 8'h64; 8'h8d: s = 8'h5d; 8'h8e: s = 8'h19; 8'h8f: s = 8'h73;
      8'h90: s = 8'h60; 8'h91: s = 8'h81; 8'h92: s = 8'h4f; 8'h93: s = 8'hdc;
      8'h94: s = 8'h22; 8'h95: s = 8'h2a; 8'h96: s = 8'h90; 8'h97: s = 8'h88;
      8'h98: s = 8'h46; 8'h99: s = 8'hee; 8'h9a: s = 8'hb8; 8'h9b: s = 8'h14;
      8'h9c: s = 8'hde; 8'h9d: s = 8'h5e; 8'h9e: s = 8'h0b; 8'h9f: s = 8'hdb;
      8'ha0: s = 8'he0; 8'ha1: s = 8'h32; 8'ha2: s = 8'h3a; 8'ha3: s = 8'h0a;
      8'ha4: s = 8'h49; 8'ha5: s = 8'h06; 8'ha6: s = 8'h24; 8'ha7: s = 8'h5c;
      8'ha8: s = 8'hc2; 8'ha9: s = 8'hd3; 8'haa: s = 8'hac; 8'hab: s = 8'h62;
      8'hac: s = 8'h91; 8'had: s = 8'h95; 8'hae: s = 8'he4; 8'haf: s = 8'h79;
      8'hb0: s = 8'he7; 8'hb1: s = 8'hc8; 8'hb2: s = 8'h37; 8'hb3: s = 8'h6d;
      8'hb4: s = 8'h8d; 8'hb5: s = 8'hd5; 8'hb6: s = 8'h4e; 8'hb7: s = 8'ha9;
      8'hb8: s = 8'h6c; 8'hb9: s = 8'h56; 8'hba: s = 8'hf4; 8'hbb: s = 8'hea;
      8'hbc: s = 8'h65; 8'hbd: s = 8'h7a; 8'hbe: s = 8'hae; 8'hbf: s = 8'h08;
      8'hc0: s = 8'hba; 8'hc1: s = 8'h78; 8'hc2: s = 8'h25; 8'hc3: s = 8'h2e;
      8'hc4: s = 8'h1c; 8'hc5: s = 8'ha6; 8'hc6: s = 8'hb4; 8'hc7: s = 8'hc6;
      8'hc8: s = 8'he8; 8'hc9: s = 8'hdd; 8'hca: s = 8'h74; 8'hcb: s = 8'h1f;
      8'hcc: s = 8'h4b; 8'hcd: s = 8'hbd; 8'hce: s = 8'h8b; 8'hcf: s = 8'h8a;
      8'hd0: s = 8'h70; 8'hd1: s = 8'h3e; 8'hd2: s = 8'hb5; 8'hd3: s = 8'h66;
      8'hd4: s = 8'h48; 8'hd5: s = 8'h03; 8'hd6: s = 8'hf6; 8'hd7: s = 8'h0e;
      8'hd8: s = 8'h61; 8'hd9: s = 8'h35; 8'hda: s = 8'h57; 8'hdb: s = 8'hb9;
      8'hdc: s = 8'h86; 8'hdd: s = 8'hc1; 8'hde: s = 8'h1d; 8'hdf: s = 8'h9e;
      8'he0: s = 8'he1; 8'he1: s = 8'hf8; 8'he2: s = 8'h98; 8'he3: s = 8'h11;
      8'he4: s = 8'h69; 8'he5: s = 8'hd9; 8'he6: s = 8'h8e; 8'he7: s = 8'h94;
      8'he8: s = 8'h9b; 8'he9: s = 8'h1e; 8'hea: s = 8'h87; 8'heb: s = 8'he9;
      8'hec: s = 8'hce; 8'hed: s = 8'h55; 8'hee: s = 8'h28; 8'hef: s = 8'hdf;
      8'hf0: s = 8'h8c; 8'hf1: s = 8'ha1; 8'hf2: s = 8'h89; 8'hf3: s = 8'h0d;
      8'hf4: s = 8'hbf; 8'hf5: s = 8'he6; 8'hf6: s = 8'h42; 8'hf7: s = 8'h68;
      8'hf8: s = 8'h41; 8'hf9: s = 8'h99; 8'hfa: s = 8'h2d; 8'hfb: s = 8'h0f;
      8'hfc: s = 8'hb0; 8'hfd: s = 8'h54; 8'hfe: s = 8'hbb; 8'hff: s = 8'h16;
      default: s = 8'h00;
    endcase
    sbox = s;
  endfunction

  // GF(2^8) xtime (multiply by 2 modulo the AES polynomial 0x11b).
  function automatic logic [7:0] xtime(input logic [7:0] b);
    xtime = (b[7]) ? ((b << 1) ^ 8'h1b) : (b << 1);
  endfunction

  // GF(2^8) multiply by 3 = xtime(b) ^ b.
  function automatic logic [7:0] mul3(input logic [7:0] b);
    mul3 = xtime(b) ^ b;
  endfunction

  // Round constants for the key schedule (rcon[i] for round i = 1..10).
  function automatic logic [7:0] rcon(input logic [3:0] round);
    logic [7:0] r;
    unique case (round)
      4'd1:  r = 8'h01; 4'd2:  r = 8'h02; 4'd3:  r = 8'h04; 4'd4:  r = 8'h08;
      4'd5:  r = 8'h10; 4'd6:  r = 8'h20; 4'd7:  r = 8'h40; 4'd8:  r = 8'h80;
      4'd9:  r = 8'h1b; 4'd10: r = 8'h36; default: r = 8'h00;
    endcase
    rcon = r;
  endfunction

  // SubWord over a 32-bit word (used in the key schedule).
  function automatic logic [31:0] subword(input logic [31:0] w);
    subword = {sbox(w[31:24]), sbox(w[23:16]), sbox(w[15:8]), sbox(w[7:0])};
  endfunction

  // RotWord: cyclic left rotate of a 32-bit word by one byte.
  function automatic logic [31:0] rotword(input logic [31:0] w);
    rotword = {w[23:0], w[31:24]};
  endfunction

  // ------------------------------------------------------------------
  // One forward AES round on a 128-bit state, parameterised by whether it is
  // the final round (final round omits MixColumns). State is treated as 16
  // bytes s[0..15] with byte 0 = state[127:120].
  // ------------------------------------------------------------------
  function automatic logic [127:0] aes_round(
      input logic [127:0] state,
      input logic [127:0] round_key,
      input logic         is_final
  );
    logic [7:0] b   [0:15];
    logic [7:0] sb  [0:15];   // after SubBytes
    logic [7:0] sr  [0:15];   // after ShiftRows
    logic [7:0] mc  [0:15];   // after MixColumns
    logic [7:0] out [0:15];
    logic [127:0] result;
    int i;

    for (i = 0; i < 16; i++) b[i] = state[127 - i*8 -: 8];

    // SubBytes.
    for (i = 0; i < 16; i++) sb[i] = sbox(b[i]);

    // ShiftRows (column-major indexing: state[r + 4c]).
    //   row 0: no shift; row 1: <<1; row 2: <<2; row 3: <<3.
    sr[0]  = sb[0];  sr[4]  = sb[4];  sr[8]  = sb[8];  sr[12] = sb[12];
    sr[1]  = sb[5];  sr[5]  = sb[9];  sr[9]  = sb[13]; sr[13] = sb[1];
    sr[2]  = sb[10]; sr[6]  = sb[14]; sr[10] = sb[2];  sr[14] = sb[6];
    sr[3]  = sb[15]; sr[7]  = sb[3];  sr[11] = sb[7];  sr[15] = sb[11];

    // MixColumns (per column c: bytes 4c..4c+3).
    for (i = 0; i < 4; i++) begin
      mc[4*i+0] = xtime(sr[4*i+0]) ^ mul3(sr[4*i+1]) ^ sr[4*i+2] ^ sr[4*i+3];
      mc[4*i+1] = sr[4*i+0] ^ xtime(sr[4*i+1]) ^ mul3(sr[4*i+2]) ^ sr[4*i+3];
      mc[4*i+2] = sr[4*i+0] ^ sr[4*i+1] ^ xtime(sr[4*i+2]) ^ mul3(sr[4*i+3]);
      mc[4*i+3] = mul3(sr[4*i+0]) ^ sr[4*i+1] ^ sr[4*i+2] ^ xtime(sr[4*i+3]);
    end

    for (i = 0; i < 16; i++) out[i] = is_final ? sr[i] : mc[i];

    result = '0;
    for (i = 0; i < 16; i++) result[127 - i*8 -: 8] = out[i];
    aes_round = result ^ round_key;
  endfunction

  // Next 128-bit round key from the previous round key and round index.
  function automatic logic [127:0] next_round_key(
      input logic [127:0] prev,
      input logic [3:0]   round
  );
    logic [31:0] w0, w1, w2, w3;
    logic [31:0] n0, n1, n2, n3;
    w0 = prev[127:96];
    w1 = prev[95:64];
    w2 = prev[63:32];
    w3 = prev[31:0];
    n0 = w0 ^ (subword(rotword(w3)) ^ {rcon(round), 24'h0});
    n1 = w1 ^ n0;
    n2 = w2 ^ n1;
    n3 = w3 ^ n2;
    next_round_key = {n0, n1, n2, n3};
  endfunction

  // ------------------------------------------------------------------
  // Iterative datapath: round counter 0..10. Round 0 is the initial
  // AddRoundKey; rounds 1..9 are full rounds; round 10 is the final round.
  // ------------------------------------------------------------------
  logic [127:0] state_q;
  logic [127:0] rkey_q;     // round key currently applied
  logic [3:0]   round_q;    // 0..10
  logic         running_q;

  always_ff @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin
      state_q   <= '0;
      rkey_q    <= '0;
      round_q   <= '0;
      running_q <= 1'b0;
      done_o    <= 1'b0;
      ct_o      <= '0;
    end else begin
      done_o <= 1'b0;
      if (!running_q) begin
        if (start_i) begin
          // Initial AddRoundKey (round 0 key == cipher key).
          state_q   <= block_i ^ key_i;
          rkey_q    <= key_i;
          round_q   <= 4'd1;
          running_q <= 1'b1;
        end
      end else begin
        logic [127:0] nk;
        logic [127:0] rstate;
        nk     = next_round_key(rkey_q, round_q);
        rstate = aes_round(state_q, nk, (round_q == 4'd10));
        rkey_q <= nk;
        if (round_q == 4'd10) begin
          // Round 10 is the final round: its output is the ciphertext.
          running_q <= 1'b0;
          done_o    <= 1'b1;
          ct_o      <= rstate;
        end else begin
          state_q <= rstate;
          round_q <= round_q + 4'd1;
        end
      end
    end
  end

  assign busy_o = running_q;

endmodule
