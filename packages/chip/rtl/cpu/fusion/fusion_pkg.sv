// fusion_pkg.sv  —  RISC-V macro-op fusion pairs for the e1 big core.
//
// Source: Celio et al., "A RISC-V Instruction Set Extension for ISO-Cost
// Macro-Op Fusion" (arXiv:1607.02318), and uarch surveys of Apple A-series
// and Arm Cortex-X conditional/branch fusion. RVA23 macro-op fusion is
// uarch-defined (not architectural); the back-end may detect any sequence
// it wishes.
//
// Decode-time detection: every pair below is a (lead, follow) pattern. The
// lead may carry a write-after-write dependency only into the rd that the
// follow reads as rs1 (single-bit linear chain). The follow must consume
// the lead's destination without other readers in between.
//
// Effective inst-count reduction in typical RISC-V code is ~5-6 % per
// Celio et al. and matches Veyron V2's published fusion numbers; for
// long-immediate generation in compiler-generated code the rate is
// dominated by `lui+addi` and `auipc+ld/jalr`.
//
// The detection RTL lives in `fusion_detect.sv` (to be written when the
// rename/dispatch stage lands). This package is the canonical contract
// for both detection and for the test bench.

`timescale 1ns/1ps

`ifndef FUSION_PKG_SV
`define FUSION_PKG_SV
package fusion_pkg;

    typedef enum logic [4:0] {
        FUSE_NONE          = 5'd0,
        // 64-bit immediate generation
        FUSE_LUI_ADDI      = 5'd1,   // lui + addi   -> li imm32
        FUSE_AUIPC_ADDI    = 5'd2,   // auipc + addi -> pc-relative addr
        FUSE_AUIPC_LD      = 5'd3,   // auipc + ld   -> pc-relative load
        FUSE_AUIPC_JALR    = 5'd4,   // auipc + jalr -> tail/long call
        FUSE_LUI_LD        = 5'd5,   // lui + ld     -> absolute load
        FUSE_LUI_SD        = 5'd6,   // lui + sd     -> absolute store
        // Shift-add and zero-extension idioms
        FUSE_SLLI_ADD      = 5'd7,   // slli + add   -> indexed addr
        FUSE_SLLI_SRLI     = 5'd8,   // slli + srli  -> zero-extend (preB)
        FUSE_ADD_LD        = 5'd9,   // add + ld     -> indexed load
        FUSE_ADD_SD        = 5'd10,  // add + sd     -> indexed store
        // Compare-and-branch
        FUSE_ADDI_BNE      = 5'd11,  // addi + bne   -> loop dec/branch
        FUSE_ADDI_BEQ      = 5'd12,  // addi + beq
        FUSE_SUB_BNE       = 5'd13,  // sub + bne
        FUSE_SLT_BNE       = 5'd14,  // slt + bne    -> if/else
        // Conditional select (Zicond, mid-2024 ratified)
        FUSE_CZERO_NEZ_ADD = 5'd15,  // czero.nez + add  -> conditional add
        FUSE_CZERO_EQZ_ADD = 5'd16,
        // Function entry / return idioms
        FUSE_ADDI_JALR     = 5'd17,  // addi sp,sp,N + jalr ra  (return)
        FUSE_AUIPC_LD_JALR = 5'd18,  // PLT-style call (3-tuple, modeled as
                                     // fusion across 3 slots; back-end may
                                     // pipeline as two paired fuses)
        // RVV vsetvli helpers
        FUSE_VSETVLI_VLE   = 5'd19   // vsetvli + vle  -> set+load
    } fusion_kind_e;

    // A fusion candidate is a (lead, follow) pair. For the 3-tuple PLT
    // call we represent it as the lead pair plus a flag; the back-end is
    // free to schedule it as one or two fused uops.
    typedef struct packed {
        logic         valid;
        fusion_kind_e kind;
        // Whether the pair forms a (taken) branch.
        logic         is_branch;
        // Whether the follow writes the rd of the lead.
        logic         redefines_rd;
    } fusion_candidate_t;

    // Detection helpers exposed to fusion_detect.sv. These look at the
    // already-decoded operand fields; the table only encodes opcode-level
    // patterns, the helpers add the dependency check.

    // Major opcode groups (low 7 bits).
    localparam logic [6:0] OP_LUI    = 7'b0110111;
    localparam logic [6:0] OP_AUIPC  = 7'b0010111;
    localparam logic [6:0] OP_OP_IMM = 7'b0010011;  // addi/slli/srli/ori...
    localparam logic [6:0] OP_OP     = 7'b0110011;  // add/sub/sll/...
    localparam logic [6:0] OP_LOAD   = 7'b0000011;
    localparam logic [6:0] OP_STORE  = 7'b0100011;
    localparam logic [6:0] OP_BRANCH = 7'b1100011;
    localparam logic [6:0] OP_JAL    = 7'b1101111;
    localparam logic [6:0] OP_JALR   = 7'b1100111;
    localparam logic [6:0] OP_OP_V   = 7'b1010111;  // V opcode
    localparam logic [6:0] OP_LOAD_FP= 7'b0000111;  // vle.*/fld

    // funct3 for SLLI / SRLI under OP_OP_IMM.
    localparam logic [2:0] F3_SLLI   = 3'b001;
    localparam logic [2:0] F3_SRLI   = 3'b101;
    // funct3 for ADD/SUB/SLL/SLT (low 3 bits, funct7 distinguishes ADD vs SUB).
    localparam logic [2:0] F3_ADD    = 3'b000;
    localparam logic [2:0] F3_SLL    = 3'b001;
    localparam logic [2:0] F3_SLT    = 3'b010;
    localparam logic [2:0] F3_BEQ    = 3'b000;
    localparam logic [2:0] F3_BNE    = 3'b001;

    // funct7 for SUB under OP_OP.
    localparam logic [6:0] F7_SUB    = 7'b0100000;

    // Static legality: given (opcode_lead, opcode_follow, funct3_follow),
    // can this pair be fused? Dependency / dataflow legality is checked
    // separately in fusion_detect.sv with the renamed register IDs.
    function automatic fusion_kind_e static_lookup(
        input logic [6:0] op1,
        input logic [6:0] op2,
        input logic [2:0] f3_2,
        input logic [6:0] f7_2
    );
        if (op1 == OP_LUI    && op2 == OP_OP_IMM && f3_2 == F3_ADD ) return FUSE_LUI_ADDI;
        if (op1 == OP_AUIPC  && op2 == OP_OP_IMM && f3_2 == F3_ADD ) return FUSE_AUIPC_ADDI;
        if (op1 == OP_AUIPC  && op2 == OP_LOAD                       ) return FUSE_AUIPC_LD;
        if (op1 == OP_AUIPC  && op2 == OP_JALR                       ) return FUSE_AUIPC_JALR;
        if (op1 == OP_LUI    && op2 == OP_LOAD                       ) return FUSE_LUI_LD;
        if (op1 == OP_LUI    && op2 == OP_STORE                      ) return FUSE_LUI_SD;
        if (op1 == OP_OP_IMM && op2 == OP_OP     && f3_2 == F3_ADD ) return FUSE_SLLI_ADD;
        if (op1 == OP_OP_IMM && op2 == OP_OP_IMM && f3_2 == F3_SRLI) return FUSE_SLLI_SRLI;
        if (op1 == OP_OP     && op2 == OP_LOAD                       ) return FUSE_ADD_LD;
        if (op1 == OP_OP     && op2 == OP_STORE                      ) return FUSE_ADD_SD;
        if (op1 == OP_OP_IMM && op2 == OP_BRANCH && f3_2 == F3_BNE ) return FUSE_ADDI_BNE;
        if (op1 == OP_OP_IMM && op2 == OP_BRANCH && f3_2 == F3_BEQ ) return FUSE_ADDI_BEQ;
        if (op1 == OP_OP     && f7_2 == F7_SUB   && op2 == OP_BRANCH && f3_2 == F3_BNE)
                                                                       return FUSE_SUB_BNE;
        if (op1 == OP_OP     && op2 == OP_BRANCH && f3_2 == F3_BNE ) return FUSE_SLT_BNE;
        if (op1 == OP_OP_IMM && op2 == OP_JALR                       ) return FUSE_ADDI_JALR;
        if (op1 == OP_OP_V   && op2 == OP_LOAD_FP                    ) return FUSE_VSETVLI_VLE;
        return FUSE_NONE;
    endfunction

    // The set of fusable pairs the integration tests must cover.
    // Cocotb consumes this list to drive fusion_detect verification.
    localparam int unsigned FUSE_TABLE_LEN = 19;

endpackage : fusion_pkg
`endif
