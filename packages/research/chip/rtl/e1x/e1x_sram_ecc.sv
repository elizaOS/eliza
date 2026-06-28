`include "rtl/e1x/e1x_pkg.sv"

// SECDED (single-error-correct, double-error-detect) ECC wrapper for one
// E1X local-SRAM data word.
//
// Code: extended Hamming code over 32 data bits.
//   - 6 Hamming parity bits cover the 32 data + 6 parity positions
//     (positions 1,2,4,8,16,32 in standard 1-based Hamming numbering,
//     covering a 38-position codeword: 32 data + 6 parity).
//   - 1 overall parity bit over the full 38-bit Hamming codeword turns the
//     SEC code into a SECDED code, giving 7 check bits total (CHECK_BITS).
//
// Decode classification (single decode of the read codeword):
//   syndrome == 0, overall parity ok  -> no error
//   syndrome != 0, overall parity bad  -> single-bit error, corrected
//   syndrome != 0, overall parity ok   -> double-bit error, detected (uncorrectable)
//   syndrome == 0, overall parity bad  -> single error in the overall parity
//                                          bit itself, corrected (data intact)
//
// The encode/decode functions are pure combinational logic and are reused by
// the registered status counters and by verification (MBIST does not use ECC,
// but the loader/read path can wrap a word through encode->store->decode).
//
// Synthesizable, Verilator-clean. No SRAM array is instantiated here: this is
// the code/codec, intended to wrap an external storage word so the policy
// (which memories, correction scope) is decided at integration time per the
// DFT strategy doc (docs/arch/e1x-dft.md).

module e1x_sram_ecc #(
  parameter int DATA_BITS  = 32,
  parameter int PARITY_BITS = 6,                       // Hamming parity bits for 32-bit data
  parameter int CHECK_BITS = PARITY_BITS + 1,          // + overall parity = SECDED
  parameter int CODE_BITS  = DATA_BITS + CHECK_BITS    // stored codeword width
) (
  input  logic clk_i,
  input  logic rst_ni,
  input  logic clear_i,

  // Encode path: present data on a write, capture codeword to store in SRAM.
  input  logic                  enc_valid_i,
  input  logic [DATA_BITS-1:0]  enc_data_i,
  output logic [CODE_BITS-1:0]  enc_code_o,

  // Decode path: present a (possibly corrupted) codeword read from SRAM.
  input  logic                  dec_valid_i,
  input  logic [CODE_BITS-1:0]  dec_code_i,
  output logic [DATA_BITS-1:0]  dec_data_o,        // corrected data
  output logic                  dec_single_error_o, // a single-bit error was corrected this cycle
  output logic                  dec_double_error_o, // an uncorrectable double-bit error was detected

  // Saturating status counters (cleared by reset or clear_i).
  output logic [31:0]           corrected_count_o,
  output logic [31:0]           detected_double_count_o
);
  // The Hamming parity layout uses a 1-based codeword position p in [1..38]:
  //   - positions that are powers of two (1,2,4,8,16,32) hold parity bits
  //   - all other positions hold data bits, in order
  // Parity bit i (0-based, value 2**i) covers every position whose index has
  // bit i set. We build the data->position mapping at elaboration time.
  localparam int HAMMING_BITS = DATA_BITS + PARITY_BITS; // 38

  function automatic logic is_pow2_pos(int unsigned p);
    return (p != 0) && ((p & (p - 1)) == 0);
  endfunction

  // Compute the 6 Hamming parity bits over the 32 data bits.
  function automatic logic [PARITY_BITS-1:0] hamming_parity(logic [DATA_BITS-1:0] data);
    logic [PARITY_BITS-1:0] par;
    int unsigned data_idx;
    par = '0;
    data_idx = 0;
    for (int unsigned pos = 1; pos <= HAMMING_BITS; pos++) begin
      if (!is_pow2_pos(pos)) begin
        // data bit data_idx lives at codeword position `pos`
        for (int unsigned i = 0; i < PARITY_BITS; i++) begin
          if (pos[i]) begin
            par[i] = par[i] ^ data[data_idx];
          end
        end
        data_idx++;
      end
    end
    return par;
  endfunction

  // Recompute syndrome from received data + received parity.
  function automatic logic [PARITY_BITS-1:0] hamming_syndrome(
      logic [DATA_BITS-1:0] data, logic [PARITY_BITS-1:0] rx_par);
    return hamming_parity(data) ^ rx_par;
  endfunction

  // Overall parity of the full 38-bit Hamming codeword (32 data + 6 parity).
  function automatic logic overall_parity(logic [DATA_BITS-1:0] data, logic [PARITY_BITS-1:0] par);
    return ^{data, par};
  endfunction

  // ---- Encode ----------------------------------------------------------
  // Codeword layout (stored): { overall_parity, hamming_parity[5:0], data[31:0] }.
  logic [PARITY_BITS-1:0] enc_par;
  logic                   enc_overall;
  always_comb begin
    enc_par     = hamming_parity(enc_data_i);
    enc_overall = overall_parity(enc_data_i, enc_par);
    enc_code_o  = {enc_overall, enc_par, enc_data_i};
  end

  // ---- Decode ----------------------------------------------------------
  logic [DATA_BITS-1:0]   rx_data;
  logic [PARITY_BITS-1:0] rx_par;
  logic                   rx_overall;
  logic [PARITY_BITS-1:0] syndrome;
  logic                   parity_mismatch; // overall parity recomputed vs received
  logic [DATA_BITS-1:0]   corrected_data;
  logic                   single_err;
  logic                   double_err;

  always_comb begin
    rx_data    = dec_code_i[DATA_BITS-1:0];
    rx_par     = dec_code_i[DATA_BITS +: PARITY_BITS];
    rx_overall = dec_code_i[CODE_BITS-1];

    syndrome        = hamming_syndrome(rx_data, rx_par);
    parity_mismatch = overall_parity(rx_data, rx_par) ^ rx_overall;

    single_err     = 1'b0;
    double_err     = 1'b0;
    corrected_data = rx_data;

    if (syndrome == '0) begin
      if (parity_mismatch) begin
        // Error confined to the overall-parity bit; data is intact but a flip
        // was corrected (the overall parity bit), so it counts as a single
        // corrected error.
        single_err = 1'b1;
      end
    end else begin
      if (parity_mismatch) begin
        // Single-bit error somewhere in the codeword: correctable.
        single_err = 1'b1;
        // syndrome is the 1-based codeword position of the flipped bit. If it
        // names a data position, flip that data bit back.
        for (int unsigned pos = 1; pos <= HAMMING_BITS; pos++) begin
          if (!is_pow2_pos(pos)) begin
            // map this codeword position to its data index
            automatic int unsigned data_idx = 0;
            for (int unsigned q = 1; q < pos; q++) begin
              if (!is_pow2_pos(q)) data_idx++;
            end
            if (syndrome == pos[PARITY_BITS-1:0]) begin
              corrected_data[data_idx] = ~rx_data[data_idx];
            end
          end
        end
        // If syndrome names a parity position (power of two), the data is
        // already correct and corrected_data == rx_data.
      end else begin
        // Non-zero syndrome but overall parity matches => double-bit error.
        double_err = 1'b1;
      end
    end
  end

  assign dec_data_o         = corrected_data;
  assign dec_single_error_o = dec_valid_i && single_err;
  assign dec_double_error_o = dec_valid_i && double_err;

  // ---- Status counters -------------------------------------------------
  logic [31:0] corrected_q;
  logic [31:0] double_q;
  assign corrected_count_o        = corrected_q;
  assign detected_double_count_o  = double_q;

  always_ff @(posedge clk_i or negedge rst_ni) begin
    if (!rst_ni) begin
      corrected_q <= '0;
      double_q    <= '0;
    end else if (clear_i) begin
      corrected_q <= '0;
      double_q    <= '0;
    end else begin
      if (dec_valid_i && single_err && corrected_q != 32'hFFFF_FFFF) begin
        corrected_q <= corrected_q + 32'd1;
      end
      if (dec_valid_i && double_err && double_q != 32'hFFFF_FFFF) begin
        double_q <= double_q + 32'd1;
      end
    end
  end

  // enc_valid_i is part of the integration handshake (write strobe); the codec
  // itself is combinational so it is intentionally not gated here.
  logic _unused_enc_valid;
  assign _unused_enc_valid = enc_valid_i;
endmodule
