`include "rtl/e1x/e1x_pkg.sv"

// E1X processing-element integer core.
//
// Synthesizable multi-cycle RV64IM_Zicsr_Zifencei implementation for a single
// wafer-mesh processing element. Instructions and data share the per-PE local
// SRAM (e1x_pkg::E1X_LOCAL_SRAM_KIB), which is initialized over the same boot
// instruction-stream interface used by the tiny-core contract so this module
// can replace e1x_tiny_core_contract in e1x_tile without changing the fabric
// ports.
//
// Boot model: while boot_en_i is asserted, each instr_valid_i word is written
// sequentially into the local SRAM starting at byte address 0. Once boot_en_i
// deasserts and enable_i is high, the core fetches from boot_pc_i and runs
// until ECALL/EBREAK halts it.
//
// Wavelet fabric is memory-mapped into the local address space:
//   WAVELET_RX_DATA   : read newest received payload, read-clears the pending flag
//   WAVELET_RX_STATUS  : bit0 = payload pending
//   WAVELET_TX_DATA   : store launches a wavelet on the egress port
// These addresses sit above the SRAM image so normal loads/stores never alias
// them.
//
// Floating point (RV F/D) is intentionally out of scope: the wafer executes
// W4A8/INT8 quantized inference, so the PE needs strong integer + MUL/DIV
// throughput, not an FPU. This is a deliberate ISA boundary, not a gap.
module e1x_pe_core #(
  parameter int XLEN = 64,
  parameter int LOCAL_SRAM_KIB = e1x_pkg::E1X_LOCAL_SRAM_KIB
) (
  input  logic clk_i,
  input  logic rst_ni,
  input  logic enable_i,
  input  logic boot_en_i,
  input  logic [31:0] boot_pc_i,
  input  logic instr_valid_i,
  input  logic [31:0] instr_i,
  input  logic wavelet_valid_i,
  input  logic [e1x_pkg::E1X_FABRIC_PAYLOAD_BITS-1:0] wavelet_payload_i,
  output logic wavelet_ready_o,
  output logic wavelet_valid_o,
  output logic [e1x_pkg::E1X_FABRIC_PAYLOAD_BITS-1:0] wavelet_payload_o,
  output logic [31:0] pc_o,
  output logic [63:0] x1_o,
  output logic [63:0] x2_o,
  output logic [63:0] x3_o,
  output logic halted_o,
  output logic active_o
);
  localparam int SRAM_BYTES = LOCAL_SRAM_KIB * 1024;
  localparam int SRAM_WORDS = SRAM_BYTES / 4;
  localparam int WORD_ADDR_BITS = $clog2(SRAM_WORDS);

  localparam logic [31:0] WAVELET_RX_DATA   = SRAM_BYTES + 32'h00;
  localparam logic [31:0] WAVELET_RX_STATUS = SRAM_BYTES + 32'h08;
  localparam logic [31:0] WAVELET_TX_DATA   = SRAM_BYTES + 32'h10;

  localparam logic [6:0] OP_LUI    = 7'b0110111;
  localparam logic [6:0] OP_AUIPC  = 7'b0010111;
  localparam logic [6:0] OP_JAL    = 7'b1101111;
  localparam logic [6:0] OP_JALR   = 7'b1100111;
  localparam logic [6:0] OP_BRANCH = 7'b1100011;
  localparam logic [6:0] OP_LOAD   = 7'b0000011;
  localparam logic [6:0] OP_STORE  = 7'b0100011;
  localparam logic [6:0] OP_OPIMM  = 7'b0010011;
  localparam logic [6:0] OP_OPIMM32 = 7'b0011011;
  localparam logic [6:0] OP_OP     = 7'b0110011;
  localparam logic [6:0] OP_OP32   = 7'b0111011;
  localparam logic [6:0] OP_FENCE  = 7'b0001111;
  localparam logic [6:0] OP_SYSTEM = 7'b1110011;

  typedef enum logic [2:0] {
    S_BOOT,
    S_FETCH,
    S_EXEC,
    S_LOAD_WAIT,
    S_HALT
  } state_e;

  logic [31:0] local_sram [SRAM_WORDS-1:0];
  logic [63:0] regs [31:0];
  logic [31:0] pc_q;
  state_e state_q;
  logic halted_q;

  logic [63:0] csr_mcycle_q;
  logic [63:0] csr_minstret_q;
  logic [63:0] csr_mscratch_q;

  logic [31:0] boot_word_addr_q;

  logic        rx_pending_q;
  logic [e1x_pkg::E1X_FABRIC_PAYLOAD_BITS-1:0] rx_payload_q;
  logic        tx_valid_q;
  logic [e1x_pkg::E1X_FABRIC_PAYLOAD_BITS-1:0] tx_payload_q;

  logic [31:0] instr_q;
  logic [63:0] load_addr_q;

  assign wavelet_ready_o = enable_i && !halted_q && !rx_pending_q;
  assign wavelet_valid_o = tx_valid_q;
  assign wavelet_payload_o = tx_payload_q;
  assign pc_o = pc_q;
  assign x1_o = regs[1];
  assign x2_o = regs[2];
  assign x3_o = regs[3];
  assign halted_o = halted_q;
  assign active_o = enable_i && !halted_q;

  // --- decode fields (combinational view of the registered instruction) ---
  logic [6:0] opcode;
  logic [4:0] rd;
  logic [4:0] rs1;
  logic [4:0] rs2;
  logic [2:0] funct3;
  logic [6:0] funct7;
  assign opcode = instr_q[6:0];
  assign rd     = instr_q[11:7];
  assign funct3 = instr_q[14:12];
  assign rs1    = instr_q[19:15];
  assign rs2    = instr_q[24:20];
  assign funct7 = instr_q[31:25];

  function automatic logic [63:0] imm_i(input logic [31:0] ins);
    imm_i = {{52{ins[31]}}, ins[31:20]};
  endfunction
  function automatic logic [63:0] imm_s(input logic [31:0] ins);
    imm_s = {{52{ins[31]}}, ins[31:25], ins[11:7]};
  endfunction
  function automatic logic [63:0] imm_b(input logic [31:0] ins);
    imm_b = {{51{ins[31]}}, ins[31], ins[7], ins[30:25], ins[11:8], 1'b0};
  endfunction
  function automatic logic [63:0] imm_u(input logic [31:0] ins);
    imm_u = {{32{ins[31]}}, ins[31:12], 12'b0};
  endfunction
  function automatic logic [63:0] imm_j(input logic [31:0] ins);
    imm_j = {{43{ins[31]}}, ins[31], ins[19:12], ins[20], ins[30:21], 1'b0};
  endfunction
  function automatic logic [63:0] sext32(input logic [31:0] value);
    sext32 = {{32{value[31]}}, value};
  endfunction

  logic [63:0] rv1;
  logic [63:0] rv2;
  assign rv1 = regs[rs1];
  assign rv2 = regs[rs2];

  logic [63:0] pc64;
  assign pc64 = {{32{pc_q[31]}}, pc_q};

  logic [63:0] alu_imm;
  assign alu_imm = imm_i(instr_q);

  // --- ALU (OP / OP-IMM, 64-bit) ---
  function automatic logic [63:0] alu64(
    input logic [2:0] f3,
    input logic       alt,        // funct7[5]: SUB / SRA
    input logic       reg_op,     // 1 = OP (register), 0 = OP-IMM
    input logic [63:0] a,
    input logic [63:0] b
  );
    logic [5:0]         shamt;
    logic signed [63:0] sa;
    logic        [63:0] sra_res;
    shamt = b[5:0];
    sa = a;
    sra_res = sa >>> shamt;
    unique case (f3)
      3'b000: alu64 = (reg_op && alt) ? (a - b) : (a + b);
      3'b001: alu64 = a << shamt;
      3'b010: alu64 = ($signed(a) < $signed(b)) ? 64'd1 : 64'd0;
      3'b011: alu64 = (a < b) ? 64'd1 : 64'd0;
      3'b100: alu64 = a ^ b;
      3'b101: alu64 = alt ? sra_res : (a >> shamt);
      3'b110: alu64 = a | b;
      3'b111: alu64 = a & b;
      default: alu64 = '0;
    endcase
  endfunction

  // --- ALU word ops (OP-32 / OP-IMM-32), sign-extended 32-bit result ---
  function automatic logic [63:0] alu32(
    input logic [2:0] f3,
    input logic       alt,
    input logic       reg_op,
    input logic [63:0] a,
    input logic [63:0] b
  );
    logic [4:0]         shamt;
    logic [31:0]        aw;
    logic [31:0]        bw;
    logic [31:0]        res;
    logic signed [31:0] saw;
    logic [31:0]        sra_res;
    shamt = b[4:0];
    aw = a[31:0];
    bw = b[31:0];
    saw = aw;
    sra_res = saw >>> shamt;
    unique case (f3)
      3'b000: res = (reg_op && alt) ? (aw - bw) : (aw + bw);
      3'b001: res = aw << shamt;
      3'b101: res = alt ? sra_res : (aw >> shamt);
      default: res = '0;
    endcase
    alu32 = sext32(res);
  endfunction

  // --- M-extension 64-bit ---
  function automatic logic [63:0] mul_op(
    input logic [2:0] f3,
    input logic [63:0] a,
    input logic [63:0] b
  );
    logic signed [127:0] ss;
    logic [127:0]        uu;
    logic signed [127:0] su;
    unique case (f3)
      3'b000: begin // MUL
        ss = $signed(a) * $signed(b);
        mul_op = ss[63:0];
      end
      3'b001: begin // MULH (signed x signed)
        ss = $signed(a) * $signed(b);
        mul_op = ss[127:64];
      end
      3'b010: begin // MULHSU (signed x unsigned)
        su = $signed(a) * $signed({1'b0, b});
        mul_op = su[127:64];
      end
      3'b011: begin // MULHU (unsigned x unsigned)
        uu = a * b;
        mul_op = uu[127:64];
      end
      default: mul_op = '0;
    endcase
  endfunction

  function automatic logic [63:0] div_op(
    input logic [2:0] f3,
    input logic [63:0] a,
    input logic [63:0] b
  );
    unique case (f3)
      3'b100: begin // DIV
        if (b == 64'd0) div_op = {64{1'b1}};
        else if (a == {1'b1, 63'b0} && b == {64{1'b1}}) div_op = a;
        else div_op = $signed(a) / $signed(b);
      end
      3'b101: begin // DIVU
        if (b == 64'd0) div_op = {64{1'b1}};
        else div_op = a / b;
      end
      3'b110: begin // REM
        if (b == 64'd0) div_op = a;
        else if (a == {1'b1, 63'b0} && b == {64{1'b1}}) div_op = 64'd0;
        else div_op = $signed(a) % $signed(b);
      end
      3'b111: begin // REMU
        if (b == 64'd0) div_op = a;
        else div_op = a % b;
      end
      default: div_op = '0;
    endcase
  endfunction

  function automatic logic [63:0] mul_op_w(
    input logic [2:0] f3,
    input logic [63:0] a,
    input logic [63:0] b
  );
    logic [31:0] res;
    res = a[31:0] * b[31:0];
    mul_op_w = sext32(res); // MULW
  endfunction

  function automatic logic [63:0] div_op_w(
    input logic [2:0] f3,
    input logic [63:0] a,
    input logic [63:0] b
  );
    logic [31:0] aw;
    logic [31:0] bw;
    logic [31:0] res;
    aw = a[31:0];
    bw = b[31:0];
    unique case (f3)
      3'b100: begin // DIVW
        if (bw == 32'd0) res = {32{1'b1}};
        else if (aw == {1'b1, 31'b0} && bw == {32{1'b1}}) res = aw;
        else res = $signed(aw) / $signed(bw);
      end
      3'b101: begin // DIVUW
        if (bw == 32'd0) res = {32{1'b1}};
        else res = aw / bw;
      end
      3'b110: begin // REMW
        if (bw == 32'd0) res = aw;
        else if (aw == {1'b1, 31'b0} && bw == {32{1'b1}}) res = 32'd0;
        else res = $signed(aw) % $signed(bw);
      end
      3'b111: begin // REMUW
        if (bw == 32'd0) res = aw;
        else res = aw % bw;
      end
      default: res = '0;
    endcase
    div_op_w = sext32(res);
  endfunction

  // --- branch comparison ---
  function automatic logic branch_taken(
    input logic [2:0] f3,
    input logic [63:0] a,
    input logic [63:0] b
  );
    unique case (f3)
      3'b000: branch_taken = (a == b);                       // BEQ
      3'b001: branch_taken = (a != b);                       // BNE
      3'b100: branch_taken = ($signed(a) < $signed(b));      // BLT
      3'b101: branch_taken = ($signed(a) >= $signed(b));     // BGE
      3'b110: branch_taken = (a < b);                        // BLTU
      3'b111: branch_taken = (a >= b);                       // BGEU
      default: branch_taken = 1'b0;
    endcase
  endfunction

  // --- memory address helpers ---
  logic [63:0] mem_addr;
  logic [WORD_ADDR_BITS-1:0] mem_word_idx;
  logic [1:0]  mem_byte_off;
  assign mem_word_idx = mem_addr[WORD_ADDR_BITS+1:2];
  assign mem_byte_off = mem_addr[1:0];

  logic [WORD_ADDR_BITS-1:0] fetch_word_idx;
  assign fetch_word_idx = pc_q[WORD_ADDR_BITS+1:2];

  // CSR read value
  function automatic logic [63:0] csr_read(input logic [11:0] addr);
    unique case (addr)
      12'hB00, 12'hC00: csr_read = csr_mcycle_q;    // mcycle / cycle
      12'hB02, 12'hC02: csr_read = csr_minstret_q;  // minstret / instret
      12'h340:          csr_read = csr_mscratch_q;  // mscratch
      12'hF14:          csr_read = 64'd0;           // mhartid (single PE = 0)
      default:          csr_read = 64'd0;
    endcase
  endfunction

  // combinational compute of the writeback value and next-PC for S_EXEC
  logic [63:0] wb_value;
  logic        wb_we;
  logic [63:0] next_pc;
  logic        do_store;
  logic [63:0] store_value;
  logic [63:0] store_addr;
  logic        store_is_wavelet;
  logic        is_load;
  logic        is_halt;
  logic        csr_we;
  logic [11:0] csr_addr;
  logic [63:0] csr_wdata;

  always_comb begin
    wb_value   = '0;
    wb_we      = 1'b0;
    next_pc    = pc64 + 64'd4;
    do_store   = 1'b0;
    store_value = '0;
    store_addr = '0;
    store_is_wavelet = 1'b0;
    is_load    = 1'b0;
    is_halt    = 1'b0;
    csr_we     = 1'b0;
    csr_addr   = instr_q[31:20];
    csr_wdata  = '0;
    mem_addr   = '0;

    unique case (opcode)
      OP_LUI: begin
        wb_value = imm_u(instr_q);
        wb_we = 1'b1;
      end
      OP_AUIPC: begin
        wb_value = pc64 + imm_u(instr_q);
        wb_we = 1'b1;
      end
      OP_JAL: begin
        wb_value = pc64 + 64'd4;
        wb_we = 1'b1;
        next_pc = pc64 + imm_j(instr_q);
      end
      OP_JALR: begin
        wb_value = pc64 + 64'd4;
        wb_we = 1'b1;
        next_pc = (rv1 + imm_i(instr_q)) & ~64'd1;
      end
      OP_BRANCH: begin
        if (branch_taken(funct3, rv1, rv2)) begin
          next_pc = pc64 + imm_b(instr_q);
        end
      end
      OP_OPIMM: begin
        wb_value = alu64(funct3, instr_q[30], 1'b0, rv1, alu_imm);
        wb_we = 1'b1;
      end
      OP_OPIMM32: begin
        wb_value = alu32(funct3, instr_q[30], 1'b0, rv1, alu_imm);
        wb_we = 1'b1;
      end
      OP_OP: begin
        if (funct7 == 7'b0000001) begin
          wb_value = (funct3[2]) ? div_op(funct3, rv1, rv2) : mul_op(funct3, rv1, rv2);
        end else begin
          wb_value = alu64(funct3, funct7[5], 1'b1, rv1, rv2);
        end
        wb_we = 1'b1;
      end
      OP_OP32: begin
        if (funct7 == 7'b0000001) begin
          wb_value = (funct3[2]) ? div_op_w(funct3, rv1, rv2) : mul_op_w(funct3, rv1, rv2);
        end else begin
          wb_value = alu32(funct3, funct7[5], 1'b1, rv1, rv2);
        end
        wb_we = 1'b1;
      end
      OP_LOAD: begin
        is_load = 1'b1;
        mem_addr = rv1 + imm_i(instr_q);
      end
      OP_STORE: begin
        do_store = 1'b1;
        store_addr = rv1 + imm_s(instr_q);
        store_value = rv2;
        store_is_wavelet = (store_addr[31:0] == WAVELET_TX_DATA);
        mem_addr = store_addr;
      end
      OP_FENCE: begin
        // FENCE / FENCE.I: ordering no-op on a single in-order PE.
      end
      OP_SYSTEM: begin
        if (funct3 == 3'b000) begin
          // ECALL (imm 0) / EBREAK (imm 1): halt the PE.
          is_halt = 1'b1;
        end else begin
          // Zicsr: CSRRW/S/C and immediate forms.
          logic [63:0] cur;
          logic [63:0] src;
          cur = csr_read(csr_addr);
          src = funct3[2] ? {59'd0, rs1} : rv1; // immediate forms use rs1 as uimm
          unique case (funct3[1:0])
            2'b01: csr_wdata = src;          // CSRRW(I)
            2'b10: csr_wdata = cur | src;    // CSRRS(I)
            2'b11: csr_wdata = cur & ~src;   // CSRRC(I)
            default: csr_wdata = cur;
          endcase
          // CSRRS/C with rs1/uimm == 0 must not write.
          csr_we = (funct3[1:0] == 2'b01) || (src != 64'd0);
          wb_value = cur;
          wb_we = 1'b1;
        end
      end
      default: begin
      end
    endcase
  end

  // load data extraction
  logic [31:0] load_word;
  assign load_word = local_sram[load_addr_q[WORD_ADDR_BITS+1:2]];
  logic [63:0] load_result;
  always_comb begin
    logic [1:0] off;
    logic [7:0] b8;
    logic [15:0] h16;
    off = load_addr_q[1:0];
    b8 = load_word[off*8 +: 8];
    h16 = (off[1]) ? load_word[31:16] : load_word[15:0];
    if (load_addr_q[31:0] == WAVELET_RX_DATA[31:0]) begin
      load_result = {32'd0, rx_payload_q};
    end else if (load_addr_q[31:0] == WAVELET_RX_STATUS[31:0]) begin
      load_result = {63'd0, rx_pending_q};
    end else begin
      unique case (instr_q[14:12])
        3'b000: load_result = {{56{b8[7]}}, b8};                  // LB
        3'b001: load_result = {{48{h16[15]}}, h16};               // LH
        3'b010: load_result = sext32(load_word);                  // LW
        3'b100: load_result = {56'd0, b8};                        // LBU
        3'b101: load_result = {48'd0, h16};                       // LHU
        3'b110: load_result = {32'd0, load_word};                 // LWU
        3'b011: load_result =
          {local_sram[load_addr_q[WORD_ADDR_BITS+1:2] + 1], load_word}; // LD
        default: load_result = '0;
      endcase
    end
  end

  // store strobe / merged word for sub-word writes
  function automatic logic [31:0] merge_store(
    input logic [2:0] f3,
    input logic [1:0] off,
    input logic [31:0] old_word,
    input logic [63:0] value
  );
    logic [31:0] w;
    w = old_word;
    unique case (f3)
      3'b000: w[off*8 +: 8] = value[7:0];                            // SB
      3'b001: if (off[1]) w[31:16] = value[15:0]; else w[15:0] = value[15:0]; // SH
      default: w = value[31:0];                                       // SW / SD low word
    endcase
    merge_store = w;
  endfunction

  always_ff @(posedge clk_i or negedge rst_ni) begin
    if (!rst_ni) begin
      pc_q <= '0;
      state_q <= S_BOOT;
      halted_q <= 1'b0;
      csr_mcycle_q <= '0;
      csr_minstret_q <= '0;
      csr_mscratch_q <= '0;
      boot_word_addr_q <= '0;
      rx_pending_q <= 1'b0;
      rx_payload_q <= '0;
      tx_valid_q <= 1'b0;
      tx_payload_q <= '0;
      instr_q <= '0;
      load_addr_q <= '0;
      for (int idx = 0; idx < 32; idx++) regs[idx] <= '0;
    end else begin
      tx_valid_q <= 1'b0;

      // mcycle is a free-running cycle counter while the PE is enabled and not
      // halted; a CSR write below overrides it for this cycle.
      if (enable_i && !halted_q && state_q != S_BOOT) begin
        csr_mcycle_q <= csr_mcycle_q + 64'd1;
      end

      // wavelet ingress capture (independent of the execute pipeline)
      if (wavelet_valid_i && wavelet_ready_o) begin
        rx_payload_q <= wavelet_payload_i;
        rx_pending_q <= 1'b1;
      end

      unique case (state_q)
        S_BOOT: begin
          if (boot_en_i) begin
            if (instr_valid_i) begin
              local_sram[boot_word_addr_q[WORD_ADDR_BITS-1:0]] <= instr_i;
              boot_word_addr_q <= boot_word_addr_q + 1;
            end
          end else if (enable_i) begin
            pc_q <= boot_pc_i;
            state_q <= S_FETCH;
          end
        end

        S_FETCH: begin
          if (enable_i) begin
            instr_q <= local_sram[fetch_word_idx];
            state_q <= S_EXEC;
          end
        end

        S_EXEC: begin
          if (is_halt) begin
            halted_q <= 1'b1;
            state_q <= S_HALT;
          end else begin
            csr_minstret_q <= csr_minstret_q + 64'd1;
            if (is_load) begin
              load_addr_q <= mem_addr;
              if (mem_addr[31:0] == WAVELET_RX_DATA[31:0]) rx_pending_q <= 1'b0;
              state_q <= S_LOAD_WAIT;
            end else begin
              if (do_store) begin
                if (store_is_wavelet) begin
                  tx_valid_q <= 1'b1;
                  tx_payload_q <= store_value[e1x_pkg::E1X_FABRIC_PAYLOAD_BITS-1:0];
                end else begin
                  local_sram[mem_word_idx] <= merge_store(
                    funct3, mem_byte_off, local_sram[mem_word_idx], store_value);
                  if (funct3 == 3'b011) begin
                    local_sram[mem_word_idx + 1] <= store_value[63:32];
                  end
                end
              end
              if (wb_we && rd != 5'd0) regs[rd] <= wb_value;
              if (csr_we) begin
                unique case (csr_addr)
                  12'h340: csr_mscratch_q <= csr_wdata;
                  12'hB00: csr_mcycle_q <= csr_wdata;
                  12'hB02: csr_minstret_q <= csr_wdata;
                  default: ;
                endcase
              end
              pc_q <= next_pc[31:0];
              state_q <= S_FETCH;
            end
          end
          regs[0] <= '0;
        end

        S_LOAD_WAIT: begin
          if (rd != 5'd0) regs[rd] <= load_result;
          pc_q <= pc_q + 32'd4;
          regs[0] <= '0;
          state_q <= S_FETCH;
        end

        S_HALT: begin
          halted_q <= 1'b1;
        end

        default: state_q <= S_FETCH;
      endcase
    end
  end

  logic unused;
  assign unused = ^{XLEN[31:0], next_pc[63:32], store_addr[63:32], csr_wdata[0]};
endmodule
