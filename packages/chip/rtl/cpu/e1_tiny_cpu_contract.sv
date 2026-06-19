`timescale 1ns/1ps

module e1_tiny_cpu_contract #(
    parameter logic [31:0] RESET_PC = 32'h0000_0000,
    parameter logic [31:0] HART_ID  = 32'h0000_0000
) (
    input  logic        clk,
    input  logic        rst_n,

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
    input  logic [1:0]  m_axil_rresp,

    input  logic        timer_irq,
    input  logic        software_irq,
    input  logic        external_irq,

    output logic [31:0] reset_pc,
    output logic [31:0] hart_id,
    output logic        cpu_halted,
    output logic        irq_pending
);
    typedef enum logic [3:0] {
        ST_FETCH_REQ,
        ST_FETCH_RSP,
        ST_EXECUTE,
        ST_LOAD_REQ,
        ST_LOAD_RSP,
        ST_STORE_REQ,
        ST_STORE_RSP,
        ST_HALT
    } state_t;

    state_t      state_q;
    logic [31:0] pc_q;
    logic [31:0] instr_q;
    logic [63:0] regs_q [0:31];
    logic [31:0] load_addr_q;
    logic [31:0] store_addr_q;
    logic [31:0] store_data_q;
    logic [4:0]  load_rd_q;

    logic [6:0] opcode;
    logic [4:0] rd;
    logic [2:0] funct3;
    logic [4:0] rs1;
    logic [4:0] rs2;
    logic [6:0] funct7;

    logic signed [63:0] imm_i;
    logic signed [63:0] imm_s;
    logic signed [63:0] imm_b;
    logic signed [63:0] imm_u;
    logic signed [63:0] imm_j;
    logic [63:0] rs1_value;
    logic [63:0] rs2_value;
    logic [31:0] next_pc;
    logic [31:0] load_addr_next;
    logic [31:0] store_addr_next;

    integer i;

    assign opcode = instr_q[6:0];
    assign rd     = instr_q[11:7];
    assign funct3 = instr_q[14:12];
    assign rs1    = instr_q[19:15];
    assign rs2    = instr_q[24:20];
    assign funct7 = instr_q[31:25];

    assign imm_i = {{52{instr_q[31]}}, instr_q[31:20]};
    assign imm_s = {{52{instr_q[31]}}, instr_q[31:25], instr_q[11:7]};
    assign imm_b = {{51{instr_q[31]}}, instr_q[31], instr_q[7], instr_q[30:25], instr_q[11:8], 1'b0};
    assign imm_u = {{32{instr_q[31]}}, instr_q[31:12], 12'h000};
    assign imm_j = {{43{instr_q[31]}}, instr_q[31], instr_q[19:12], instr_q[20], instr_q[30:21], 1'b0};

    assign rs1_value = (rs1 == 5'd0) ? 64'h0 : regs_q[rs1];
    assign rs2_value = (rs2 == 5'd0) ? 64'h0 : regs_q[rs2];
    assign next_pc   = pc_q + 32'd4;
    assign load_addr_next  = rs1_value[31:0] + imm_i[31:0];
    assign store_addr_next = rs1_value[31:0] + imm_s[31:0];

    assign m_axil_bready = 1'b1;
    assign m_axil_rready = 1'b1;

    assign reset_pc    = RESET_PC;
    assign hart_id     = HART_ID;
    assign cpu_halted  = state_q == ST_HALT;
    assign irq_pending = timer_irq | software_irq | external_irq;

    always_comb begin
        m_axil_awvalid = 1'b0;
        m_axil_awaddr  = store_addr_q;
        m_axil_wvalid  = 1'b0;
        m_axil_wdata   = store_data_q;
        m_axil_wstrb   = 4'hF;
        m_axil_arvalid = 1'b0;
        m_axil_araddr  = pc_q;

        unique case (state_q)
            ST_FETCH_REQ: begin
                m_axil_arvalid = 1'b1;
                m_axil_araddr  = pc_q;
            end
            ST_LOAD_REQ: begin
                m_axil_arvalid = 1'b1;
                m_axil_araddr  = load_addr_q;
            end
            ST_STORE_REQ: begin
                m_axil_awvalid = 1'b1;
                m_axil_awaddr  = store_addr_q;
                m_axil_wvalid  = 1'b1;
                m_axil_wdata   = store_data_q;
            end
            default: begin
            end
        endcase
    end

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            state_q      <= ST_FETCH_REQ;
            pc_q         <= RESET_PC;
            instr_q      <= 32'h0000_0013;
            load_addr_q  <= 32'h0;
            store_addr_q <= 32'h0;
            store_data_q <= 32'h0;
            load_rd_q    <= 5'h0;
            for (i = 0; i < 32; i = i + 1) begin
                regs_q[i] <= 64'h0;
            end
        end else begin
            regs_q[0] <= 64'h0;

            unique case (state_q)
                ST_FETCH_REQ: begin
                    if (m_axil_arvalid && m_axil_arready) begin
                        state_q <= ST_FETCH_RSP;
                    end
                end

                ST_FETCH_RSP: begin
                    if (m_axil_rvalid) begin
                        instr_q <= m_axil_rdata;
                        if (m_axil_rresp == 2'b00) begin
                            state_q <= ST_EXECUTE;
                        end else begin
                            state_q <= ST_HALT;
                        end
                    end
                end

                ST_EXECUTE: begin
                    unique case (opcode)
                        7'b0110111: begin // LUI
                            if (rd != 5'd0) regs_q[rd] <= imm_u;
                            pc_q    <= next_pc;
                            state_q <= ST_FETCH_REQ;
                        end
                        7'b0010111: begin // AUIPC
                            if (rd != 5'd0) regs_q[rd] <= {{32{pc_q[31]}}, pc_q} + imm_u;
                            pc_q    <= next_pc;
                            state_q <= ST_FETCH_REQ;
                        end
                        7'b1101111: begin // JAL
                            if (rd != 5'd0) regs_q[rd] <= {32'h0, next_pc};
                            pc_q    <= pc_q + imm_j[31:0];
                            state_q <= ST_FETCH_REQ;
                        end
                        7'b1100111: begin // JALR
                            if (rd != 5'd0) regs_q[rd] <= {32'h0, next_pc};
                            pc_q    <= (rs1_value[31:0] + imm_i[31:0]) & 32'hFFFF_FFFE;
                            state_q <= ST_FETCH_REQ;
                        end
                        7'b1100011: begin // Branches
                            unique case (funct3)
                                3'b000: pc_q <= (rs1_value == rs2_value) ? pc_q + imm_b[31:0] : next_pc;
                                3'b001: pc_q <= (rs1_value != rs2_value) ? pc_q + imm_b[31:0] : next_pc;
                                default: state_q <= ST_HALT;
                            endcase
                            if (funct3 == 3'b000 || funct3 == 3'b001) state_q <= ST_FETCH_REQ;
                        end
                        7'b0000011: begin // Loads
                            if (funct3 == 3'b010) begin
                                if (load_addr_next[1:0] == 2'b00) begin
                                    load_addr_q <= load_addr_next;
                                    load_rd_q   <= rd;
                                    state_q     <= ST_LOAD_REQ;
                                end else begin
                                    state_q <= ST_HALT;
                                end
                            end else begin
                                state_q <= ST_HALT;
                            end
                        end
                        7'b0100011: begin // Stores
                            if (funct3 == 3'b010) begin
                                if (store_addr_next[1:0] == 2'b00) begin
                                    store_addr_q <= store_addr_next;
                                    store_data_q <= rs2_value[31:0];
                                    state_q      <= ST_STORE_REQ;
                                end else begin
                                    state_q <= ST_HALT;
                                end
                            end else begin
                                state_q <= ST_HALT;
                            end
                        end
                        7'b0010011: begin // OP-IMM
                            if (funct3 == 3'b000) begin
                                if (rd != 5'd0) regs_q[rd] <= rs1_value + imm_i;
                                pc_q    <= next_pc;
                                state_q <= ST_FETCH_REQ;
                            end else begin
                                state_q <= ST_HALT;
                            end
                        end
                        7'b0110011: begin // OP
                            if (funct3 == 3'b000 && (funct7 == 7'b0000000 || funct7 == 7'b0100000)) begin
                                if (rd != 5'd0) begin
                                    regs_q[rd] <= (funct7 == 7'b0100000) ? rs1_value - rs2_value : rs1_value + rs2_value;
                                end
                                pc_q    <= next_pc;
                                state_q <= ST_FETCH_REQ;
                            end else begin
                                state_q <= ST_HALT;
                            end
                        end
                        7'b1110011: begin // SYSTEM: ECALL/EBREAK halt this tiny core.
                            state_q <= ST_HALT;
                        end
                        default: begin
                            state_q <= ST_HALT;
                        end
                    endcase
                end

                ST_LOAD_REQ: begin
                    if (m_axil_arvalid && m_axil_arready) begin
                        state_q <= ST_LOAD_RSP;
                    end
                end

                ST_LOAD_RSP: begin
                    if (m_axil_rvalid) begin
                        if (m_axil_rresp == 2'b00) begin
                            if (load_rd_q != 5'd0) regs_q[load_rd_q] <= {{32{m_axil_rdata[31]}}, m_axil_rdata};
                            pc_q    <= next_pc;
                            state_q <= ST_FETCH_REQ;
                        end else begin
                            state_q <= ST_HALT;
                        end
                    end
                end

                ST_STORE_REQ: begin
                    if (m_axil_awvalid && m_axil_awready && m_axil_wvalid && m_axil_wready) begin
                        state_q <= ST_STORE_RSP;
                    end
                end

                ST_STORE_RSP: begin
                    if (m_axil_bvalid) begin
                        if (m_axil_bresp == 2'b00) begin
                            pc_q    <= next_pc;
                            state_q <= ST_FETCH_REQ;
                        end else begin
                            state_q <= ST_HALT;
                        end
                    end
                end

                default: begin
                    state_q <= ST_HALT;
                end
            endcase
        end
    end

endmodule
