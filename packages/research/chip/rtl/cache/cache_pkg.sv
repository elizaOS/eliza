`timescale 1ns/1ps

// e1_cache_pkg
//
// Shared parameters and enumerations for the e1 cache hierarchy.
//
// 2028 phone-class minimums (see docs/arch/cache-hierarchy.md):
//   L1I : 32 KB minimum, 64 KB target,  8-way, 64 B line
//   L1D : 32 KB minimum, 64 KB target,  8-way, 64 B line, SECDED ECC
//   L2  : 256 KB minimum, 1 MB target,  8-way, 64 B line, PTW interface
//   L3  : 4 MB minimum,  8 MB target,   16-way, 64 B line, 4 banks
//   SLC : 8 MB minimum,  16 MB target,  16-way, 64 B line, 4-8 banks
//
// Synthesizable, Verilator-runnable. No vendor SRAM macros are instantiated
// here; generic logic [DW-1:0] mem [DEPTH] is used so OpenROAD / Yosys can
// pick a synthesizer-provided RAM macro at the next physical-design step.

package e1_cache_pkg;

    // -----------------------------------------------------------------------
    // Geometry defaults (parameterizable at module level)
    // -----------------------------------------------------------------------
    localparam int unsigned LINE_BYTES_DEFAULT   = 64;
    localparam int unsigned LINE_BITS_DEFAULT    = 8 * LINE_BYTES_DEFAULT; // 512
    localparam int unsigned PADDR_W_DEFAULT      = 40;
    localparam int unsigned WORD_BITS_DEFAULT    = 64;

    // L1I geometry
    localparam int unsigned L1I_SIZE_BYTES       = 64 * 1024;
    localparam int unsigned L1I_WAYS             = 8;
    localparam int unsigned L1I_LINE_BYTES       = LINE_BYTES_DEFAULT;
    localparam int unsigned L1I_SETS             = L1I_SIZE_BYTES /
                                                   (L1I_WAYS * L1I_LINE_BYTES);
    localparam int unsigned L1I_INDEX_W          = $clog2(L1I_SETS);
    localparam int unsigned L1I_OFFSET_W         = $clog2(L1I_LINE_BYTES);
    localparam int unsigned L1I_TAG_W            = PADDR_W_DEFAULT -
                                                   L1I_INDEX_W - L1I_OFFSET_W;

    // L1D geometry
    localparam int unsigned L1D_SIZE_BYTES       = 64 * 1024;
    localparam int unsigned L1D_WAYS             = 8;
    localparam int unsigned L1D_LINE_BYTES       = LINE_BYTES_DEFAULT;
    localparam int unsigned L1D_SETS             = L1D_SIZE_BYTES /
                                                   (L1D_WAYS * L1D_LINE_BYTES);
    localparam int unsigned L1D_INDEX_W          = $clog2(L1D_SETS);
    localparam int unsigned L1D_OFFSET_W         = $clog2(L1D_LINE_BYTES);
    localparam int unsigned L1D_TAG_W            = PADDR_W_DEFAULT -
                                                   L1D_INDEX_W - L1D_OFFSET_W;

    // L2 geometry (private per-core, big core target)
    localparam int unsigned L2_SIZE_BYTES        = 1 * 1024 * 1024;
    localparam int unsigned L2_WAYS              = 8;
    localparam int unsigned L2_LINE_BYTES        = LINE_BYTES_DEFAULT;
    localparam int unsigned L2_SETS              = L2_SIZE_BYTES /
                                                   (L2_WAYS * L2_LINE_BYTES);
    localparam int unsigned L2_INDEX_W           = $clog2(L2_SETS);
    localparam int unsigned L2_OFFSET_W          = $clog2(L2_LINE_BYTES);
    localparam int unsigned L2_TAG_W             = PADDR_W_DEFAULT -
                                                   L2_INDEX_W - L2_OFFSET_W;

    // L3 geometry (shared, 4 banks)
    localparam int unsigned L3_SIZE_BYTES        = 8 * 1024 * 1024;
    localparam int unsigned L3_BANKS             = 4;
    localparam int unsigned L3_BANK_BYTES        = L3_SIZE_BYTES / L3_BANKS;
    localparam int unsigned L3_WAYS              = 16;
    localparam int unsigned L3_LINE_BYTES        = LINE_BYTES_DEFAULT;
    localparam int unsigned L3_SETS_PER_BANK     = L3_BANK_BYTES /
                                                   (L3_WAYS * L3_LINE_BYTES);
    localparam int unsigned L3_INDEX_W           = $clog2(L3_SETS_PER_BANK);
    localparam int unsigned L3_OFFSET_W          = $clog2(L3_LINE_BYTES);
    localparam int unsigned L3_BANK_W            = $clog2(L3_BANKS);
    localparam int unsigned L3_TAG_W             = PADDR_W_DEFAULT -
                                                   L3_INDEX_W -
                                                   L3_BANK_W - L3_OFFSET_W;

    // SLC geometry (4 banks, BDI compression hooks)
    localparam int unsigned SLC_SIZE_BYTES       = 16 * 1024 * 1024;
    localparam int unsigned SLC_BANKS            = 4;
    localparam int unsigned SLC_BANK_BYTES       = SLC_SIZE_BYTES / SLC_BANKS;
    localparam int unsigned SLC_WAYS             = 16;
    localparam int unsigned SLC_LINE_BYTES       = LINE_BYTES_DEFAULT;
    localparam int unsigned SLC_SETS_PER_BANK    = SLC_BANK_BYTES /
                                                   (SLC_WAYS * SLC_LINE_BYTES);
    localparam int unsigned SLC_INDEX_W          = $clog2(SLC_SETS_PER_BANK);
    localparam int unsigned SLC_OFFSET_W         = $clog2(SLC_LINE_BYTES);
    localparam int unsigned SLC_BANK_W           = $clog2(SLC_BANKS);
    localparam int unsigned SLC_TAG_W            = PADDR_W_DEFAULT -
                                                   SLC_INDEX_W -
                                                   SLC_BANK_W - SLC_OFFSET_W;

    // -----------------------------------------------------------------------
    // MOESI states (TileLink TL-C compatible naming)
    //
    // The cluster used to run MESI; round-8 widens the encoding to add the
    // Owned state. Owned holds the canonical dirty copy while one or more
    // peers hold the line in Shared. The Owner serves sharers without
    // involving memory and writes back on eviction.
    //
    // Encoding is chosen so the lower two bits match the legacy MESI
    // values: any code that still drives a 2-bit value will read as the
    // same logical state under the widened type. The 5th state (Owned)
    // sits at 3'b100 which has bit[2] set; legacy 2-bit decoders that
    // only sample bits [1:0] will see Owned as Invalid, which is the
    // safe degradation: an Owned line behaves as a writable-on-evict
    // dirty line, but never as an exclusive writer.
    //
    //   MESI_I = 3'b000   Invalid
    //   MESI_S = 3'b001   Shared (clean, may be present in multiple caches)
    //   MESI_E = 3'b010   Exclusive (clean, single owner)
    //   MESI_M = 3'b011   Modified (dirty, single owner, no sharers)
    //   MESI_O = 3'b100   Owned (dirty, single owner, sharers also have line)
    //
    // The type name `mesi_e` is preserved so cache modules and tests do
    // not have to be renamed in lockstep; the underlying type carries
    // five states. The `MESI_O` name is the canonical Owned value.
    // -----------------------------------------------------------------------
    typedef enum logic [2:0] {
        MESI_I = 3'b000,
        MESI_S = 3'b001,
        MESI_E = 3'b010,
        MESI_M = 3'b011,
        MESI_O = 3'b100
    } mesi_e;

    // Returns 1 if the state holds a dirty line that must be written back
    // on eviction or invalidation.
    function automatic logic moesi_is_dirty(input mesi_e s);
        moesi_is_dirty = (s == MESI_M) || (s == MESI_O);
    endfunction

    // Returns 1 if the state implies the line may be present in any
    // other cache (Shared or Owned-with-sharers).
    function automatic logic moesi_has_sharers(input mesi_e s);
        moesi_has_sharers = (s == MESI_S) || (s == MESI_O);
    endfunction

    // -----------------------------------------------------------------------
    // QoS classes for SLC arbitration
    //
    // Lower numeric value = higher priority. Display realtime cannot starve
    // because the SLC arbiter enforces a hard reservation window per class.
    // -----------------------------------------------------------------------
    typedef enum logic [2:0] {
        QOS_DISPLAY_RT  = 3'd0, // hard-real-time display fetches
        QOS_CAMERA_ISP  = 3'd1, // camera/ISP streaming
        QOS_CPU_FG      = 3'd2, // foreground CPU traffic
        QOS_CPU_BG      = 3'd3, // background CPU traffic
        QOS_NPU         = 3'd4, // NPU tensor traffic
        QOS_GPU         = 3'd5, // GPU/2D traffic
        QOS_DMA_BULK    = 3'd6, // bulk DMA (peripheral, USB, NVMe)
        QOS_LOW         = 3'd7  // background / non-time-sensitive
    } qos_class_e;

    // -----------------------------------------------------------------------
    // SECDED (72,64) Hsiao codeword helpers for L1D / L2 ECC
    //
    // Encodes 64 data bits + 8 check bits = 72-bit codeword. A single-bit
    // error (in any of the 72 codeword bits) is corrected; a double-bit error
    // is detected and surfaced as uncorrectable.
    //
    // Code construction (Hsiao 1970, "A Class of Optimal Minimum Odd-weight-
    // column SEC-DED Codes", IBM J. Res. Dev. 14(4)). The 8x72 parity-check
    // matrix H has one column per codeword bit. Every column is a DISTINCT,
    // nonzero, ODD-weight 8-bit vector:
    //   - the 64 data columns are the 56 weight-3 vectors plus 8 weight-5
    //     vectors (`secded_data_col` below),
    //   - the 8 check columns are the weight-1 identity vectors (one per
    //     check bit), implicit in the encoder.
    // Consequences that make this a true SEC-DED code:
    //   - a single-bit flip XORs exactly one column into the syndrome, so the
    //     syndrome equals that (odd-weight, hence nonzero) column and uniquely
    //     names the flipped bit -> single-error correctable (SEC),
    //   - a double-bit flip XORs two distinct odd-weight columns, giving a
    //     nonzero EVEN-weight syndrome that can never equal any single-bit
    //     (odd-weight) column -> double-error detectable, never miscorrected
    //     as a single (DED).
    //
    // `secded_data_col` is the single source of truth for the H-matrix data
    // columns; encode, syndrome decode, and correction are all derived from
    // it so the three paths cannot drift. The constructive verification of
    // the SEC-DED properties is the cocotb injection test in
    // verify/cocotb/l1d_ecc/.
    // -----------------------------------------------------------------------
    // Implicit-return form (function-name = value) is used so the yosys
    // SystemVerilog frontend can parse these helpers alongside verilator.

    // H-matrix column (8-bit syndrome contribution) for data bit `d` in
    // [0,63]. The 56 weight-3 vectors are enumerated first, then 8 weight-5
    // vectors, matching the generator in verify/cocotb/l1d_ecc/.
    function automatic logic [7:0] secded_data_col(input int unsigned d);
        unique case (d)
            32'd0:  secded_data_col = 8'h07; 32'd1:  secded_data_col = 8'h0B;
            32'd2:  secded_data_col = 8'h13; 32'd3:  secded_data_col = 8'h23;
            32'd4:  secded_data_col = 8'h43; 32'd5:  secded_data_col = 8'h83;
            32'd6:  secded_data_col = 8'h0D; 32'd7:  secded_data_col = 8'h15;
            32'd8:  secded_data_col = 8'h25; 32'd9:  secded_data_col = 8'h45;
            32'd10: secded_data_col = 8'h85; 32'd11: secded_data_col = 8'h19;
            32'd12: secded_data_col = 8'h29; 32'd13: secded_data_col = 8'h49;
            32'd14: secded_data_col = 8'h89; 32'd15: secded_data_col = 8'h31;
            32'd16: secded_data_col = 8'h51; 32'd17: secded_data_col = 8'h91;
            32'd18: secded_data_col = 8'h61; 32'd19: secded_data_col = 8'hA1;
            32'd20: secded_data_col = 8'hC1; 32'd21: secded_data_col = 8'h0E;
            32'd22: secded_data_col = 8'h16; 32'd23: secded_data_col = 8'h26;
            32'd24: secded_data_col = 8'h46; 32'd25: secded_data_col = 8'h86;
            32'd26: secded_data_col = 8'h1A; 32'd27: secded_data_col = 8'h2A;
            32'd28: secded_data_col = 8'h4A; 32'd29: secded_data_col = 8'h8A;
            32'd30: secded_data_col = 8'h32; 32'd31: secded_data_col = 8'h52;
            32'd32: secded_data_col = 8'h92; 32'd33: secded_data_col = 8'h62;
            32'd34: secded_data_col = 8'hA2; 32'd35: secded_data_col = 8'hC2;
            32'd36: secded_data_col = 8'h1C; 32'd37: secded_data_col = 8'h2C;
            32'd38: secded_data_col = 8'h4C; 32'd39: secded_data_col = 8'h8C;
            32'd40: secded_data_col = 8'h34; 32'd41: secded_data_col = 8'h54;
            32'd42: secded_data_col = 8'h94; 32'd43: secded_data_col = 8'h64;
            32'd44: secded_data_col = 8'hA4; 32'd45: secded_data_col = 8'hC4;
            32'd46: secded_data_col = 8'h38; 32'd47: secded_data_col = 8'h58;
            32'd48: secded_data_col = 8'h98; 32'd49: secded_data_col = 8'h68;
            32'd50: secded_data_col = 8'hA8; 32'd51: secded_data_col = 8'hC8;
            32'd52: secded_data_col = 8'h70; 32'd53: secded_data_col = 8'hB0;
            32'd54: secded_data_col = 8'hD0; 32'd55: secded_data_col = 8'hE0;
            32'd56: secded_data_col = 8'h1F; 32'd57: secded_data_col = 8'h2F;
            32'd58: secded_data_col = 8'h4F; 32'd59: secded_data_col = 8'h8F;
            32'd60: secded_data_col = 8'h37; 32'd61: secded_data_col = 8'h57;
            32'd62: secded_data_col = 8'h97; 32'd63: secded_data_col = 8'h67;
            default: secded_data_col = 8'h00;
        endcase
    endfunction

    // Encode: 8 check bits = XOR of the H-matrix columns of all set data bits.
    function automatic logic [7:0] secded_encode(input logic [63:0] d);
        logic [7:0] c;
        c = 8'h00;
        for (int unsigned i = 0; i < 64; i++) begin
            if (d[i]) c = c ^ secded_data_col(i);
        end
        secded_encode = c;
    endfunction

    // Returns 8-bit syndrome. Zero => no error.
    function automatic logic [7:0] secded_syndrome(input logic [63:0] d,
                                                   input logic [7:0]  c);
        secded_syndrome = secded_encode(d) ^ c;
    endfunction

    // Single-bit error iff syndrome non-zero AND syndrome has odd parity.
    // Every codeword column is odd-weight, so the syndrome of any single flip
    // is odd; a double flip yields an even-weight syndrome.
    function automatic logic secded_is_single(input logic [7:0] s);
        secded_is_single = (s != 8'h00) && ^s;
    endfunction

    // Double-bit error iff syndrome non-zero AND syndrome has even parity.
    function automatic logic secded_is_double(input logic [7:0] s);
        secded_is_double = (s != 8'h00) && !(^s);
    endfunction

    // Single-error correction. When the syndrome names a data column, flip
    // that data bit. A syndrome that names a check column (weight-1) means the
    // flip was in a check bit and the data is already intact, so `d` is
    // returned unchanged. A double-bit (even, nonzero) syndrome is not
    // correctable; callers gate on secded_is_double and must not consume the
    // result as corrected data.
    function automatic logic [63:0] secded_correct(input logic [63:0] d,
                                                    input logic [7:0]  s);
        logic [63:0] r;
        r = d;
        if (secded_is_single(s)) begin
            for (int unsigned i = 0; i < 64; i++) begin
                if (secded_data_col(i) == s) r[i] = ~d[i];
            end
        end
        secded_correct = r;
    endfunction

    // -----------------------------------------------------------------------
    // BDI (Base-Delta-Immediate) compression encoding for SLC
    //
    // Compressed forms supported (Pekhimenko et al., PACT'12):
    //   ZERO   : all-zero line  (header only, no payload)
    //   REPEAT : every 8 B word equals base    (header + 8 B base)
    //   B8D1   : base 8 B, deltas 1 B each     (header + 8 B + 8 * 1 B = 24 B)
    //   B8D2   : base 8 B, deltas 2 B each     (header + 8 B + 8 * 2 B = 40 B)
    //   B8D4   : base 8 B, deltas 4 B each     (header + 8 B + 8 * 4 B = 72 B -> skip)
    //   NONE   : uncompressed                  (header + 64 B)
    //
    // Header layout (3 bits encoding plus 1 valid bit):
    //   bit[3]   : compressed_valid
    //   bit[2:0] : encoding_form
    //
    // Decompression is < 1 cycle (single subtract per 8-byte word).
    // Compression failures fall back to NONE; the SLC bank tracks both forms.
    // -----------------------------------------------------------------------
    typedef enum logic [2:0] {
        BDI_ZERO   = 3'd0,
        BDI_REPEAT = 3'd1,
        BDI_B8D1   = 3'd2,
        BDI_B8D2   = 3'd3,
        BDI_NONE   = 3'd7
    } bdi_form_e;

    // -----------------------------------------------------------------------
    // HPM event codes for Zihpm cache counters
    //
    // The CPU's HPM aggregator owns the actual counter registers. These codes
    // are emitted on a 1-bit pulse by the cache modules and counted by the
    // CPU subsystem. Codes 0..31 are reserved for the cache hierarchy.
    // -----------------------------------------------------------------------
    localparam int unsigned HPM_L1I_ACCESS       = 0;
    localparam int unsigned HPM_L1I_MISS         = 1;
    localparam int unsigned HPM_L1I_PREFETCH     = 2;
    localparam int unsigned HPM_L1D_ACCESS       = 3;
    localparam int unsigned HPM_L1D_MISS         = 4;
    localparam int unsigned HPM_L1D_PREFETCH     = 5;
    localparam int unsigned HPM_L1D_ECC_CORR     = 6;
    localparam int unsigned HPM_L1D_ECC_UNCORR   = 7;
    localparam int unsigned HPM_L2_ACCESS        = 8;
    localparam int unsigned HPM_L2_MISS          = 9;
    localparam int unsigned HPM_L2_PREFETCH      = 10;
    localparam int unsigned HPM_L3_ACCESS        = 11;
    localparam int unsigned HPM_L3_MISS          = 12;
    localparam int unsigned HPM_L3_SNOOP_HIT     = 13;
    localparam int unsigned HPM_L3_WRITEBACK     = 14;
    localparam int unsigned HPM_SLC_ACCESS       = 15;
    localparam int unsigned HPM_SLC_MISS         = 16;
    localparam int unsigned HPM_SLC_WAY_SHUTOFF  = 17;
    localparam int unsigned HPM_SLC_BDI_COMPRESS = 18;
    localparam int unsigned HPM_SLC_DISPLAY_HOLD = 19;

endpackage : e1_cache_pkg
