`timescale 1ns/1ps

// e1_imsic — RISC-V AIA Incoming MSI Controller (production).
//
// Implements the RISC-V Advanced Interrupt Architecture (AIA) IMSIC: per-hart
// interrupt files that receive message-signalled interrupts (MSIs) and present
// the highest-priority pending+enabled external interrupt to the hart via the
// xtopei CSR-side claim interface (mtopei / stopei / vstopei). This is the
// modern interrupt path Linux uses for MSIs and virtualization; it is the
// complement to the level-line PLIC at rtl/interrupts/e1_plic.sv.
//
// Compatible with the riscv,imsics device-tree binding. Each interrupt file is
// a 4 KiB page exposing the AIA seteipnum doorbell at offset 0x000:
//
//   <file page> + 0x000 : seteipnum (write-only MSI doorbell).
//                         A 32-bit write of interrupt identity N sets EIP[N].
//                         Identity 0 is the spec-reserved "no interrupt" and a
//                         write of 0 is a no-op. Identities > NUM_IDS are
//                         dropped (out-of-range MSIs cannot pend an interrupt).
//
// The file's EIP (external interrupt pending) and EIE (external interrupt
// enable) arrays are otherwise accessed indirectly through the hart's
// eidelivery/eithreshold/eip*/eie* CSRs via the *iselect/*ireg window; that
// CSR-side accessor lives in the core. This leaf models the architectural
// EIP/EIE state, the memory-mapped doorbell write port (the only port a device
// or the IOMMU MSI-translation stage can reach), and the xtopei claim/clear
// path the hart drives.
//
// FILE LAYOUT. NUM_HARTS harts; each hart owns NUM_FILES interrupt files.
// File 0 is the supervisor (S) file, files 1..NUM_GUESTS are the guest
// (VS) files for that hart, and — when SECURE_FILE=1 — the highest-indexed
// file is the monitor/confidential-domain (M / secure) file. The flat file
// index is f = hart*NUM_FILES + local_file. The memory-mapped doorbell page
// for flat file f sits at f*PAGE_BYTES within the IMSIC window.
//
// SECURE-DOMAIN HOOK (TEE lane 03, docs/security/tee-plan/03-secure-io-iommu-npu.md
// §5). Every doorbell write carries a world qualifier `msi_world_i` (1 =
// confidential/secure world, 0 = untrusted/host world). A write is committed to
// a file only if the file's own world bit (SECURE_FILE makes the top file
// secure-world) matches the write's world. An untrusted-world MSI therefore
// can NEVER set a bit in the secure file, and a secure-world MSI never lands in
// a host file. The world bit is driven upstream by the IOMMU MSI-translation
// stage (e1_iommu_msi_xlate.sv) from the issuing device's owning DID, so the
// host cannot forge a secure-domain interrupt by writing the doorbell address.
//
// xtopei CLAIM. For each file, topei_id_o / topei_prio_o report the highest-
// priority pending+enabled identity (AIA orders by identity: lowest identity =
// highest priority; identity P > threshold is ignored when eithreshold != 0).
// Pulsing topei_claim_i[f] for one cycle atomically clears that identity's EIP
// (the architectural effect of a CSR read of xtopei with the write-1-to-claim
// convention), re-arming the file for the next pending identity.

module e1_imsic #(
    parameter int unsigned NUM_HARTS  = 1,
    parameter int unsigned NUM_IDS    = 63,  // identities 1..NUM_IDS per file
    parameter int unsigned NUM_GUESTS = 0,   // VS (guest) files per hart
    parameter bit          SECURE_FILE = 1'b1, // top file is the monitor/secure file
    parameter int unsigned PAGE_BYTES = 4096,
    // Derived dimensions (computed from the above; not intended to be overridden).
    //   NUM_FILES : interrupt files per hart = S file + guest files (+ secure file).
    //   NUM_FLAT  : total flat file count across all harts.
    //   ID_W      : identity index width (identities 1..NUM_IDS; index 0 reserved).
    parameter int unsigned NUM_FILES = 1 + NUM_GUESTS + (SECURE_FILE ? 1 : 0),
    parameter int unsigned NUM_FLAT  = NUM_HARTS * NUM_FILES,
    parameter int unsigned ID_W      = $clog2(NUM_IDS + 1)
) (
    input  logic clk,
    input  logic rst_n,

    // --- Memory-mapped MSI doorbell write port (the only device-reachable port).
    // A device / the IOMMU MSI-translation stage issues a 32-bit write of an
    // interrupt identity to the addressed file's seteipnum doorbell.
    input  logic                          msi_we_i,     // doorbell write strobe
    input  logic [31:0]                   msi_addr_i,   // window-relative byte address
    input  logic [31:0]                   msi_id_i,     // interrupt identity to set
    input  logic                          msi_world_i,  // 1 = secure/confidential world
    output logic                          msi_accept_o, // write committed to a file
    output logic                          msi_reject_o, // write dropped (world/range/decode)

    // --- xtopei claim interface (one port per flat file, driven by the hart).
    output logic [NUM_HARTS*NUM_FILES-1:0]               eip_any_o,   // file has a deliverable IRQ
    output logic [ID_W-1:0] topei_id_o   [NUM_HARTS*NUM_FILES],       // highest pending+enabled id
    output logic [ID_W-1:0] topei_prio_o [NUM_HARTS*NUM_FILES],       // its priority (== id; lower=higher)
    input  logic [NUM_HARTS*NUM_FILES-1:0]               topei_claim_i, // pulse: claim+clear top id

    // --- CSR-side enable / threshold programming (driven by the core's eie/
    // eithreshold accessor). One eithreshold per file; eie set/clear per id.
    input  logic [NUM_HARTS*NUM_FILES-1:0]               eie_we_i,    // write eie[id] for this file
    input  logic [ID_W-1:0]                              eie_id_i,    // identity addressed
    input  logic [NUM_HARTS*NUM_FILES-1:0]               eie_val_i,   // value to write
    input  logic [NUM_HARTS*NUM_FILES-1:0]               thr_we_i,    // write eithreshold
    input  logic [ID_W-1:0]                              thr_val_i,   // threshold value (0 = disabled)

    // --- External interrupt line to each hart context (drives mip.MEIP/SEIP/
    // hgeip). One bit per flat file; the SoC owner maps file->context.
    output logic [NUM_HARTS*NUM_FILES-1:0]               irq_o
);
    // The secure/monitor file is the top local file when SECURE_FILE=1.
    localparam int unsigned SECURE_LOCAL = NUM_FILES - 1;

    // --- Architectural state ----------------------------------------------
    // EIP[f][id] : external interrupt pending. EIE[f][id] : enable.
    // Index 0 is the reserved "no interrupt" identity and is held at 0.
    logic [NUM_IDS:0] eip_q [NUM_FLAT];
    logic [NUM_IDS:0] eie_q [NUM_FLAT];
    logic [ID_W-1:0]  thr_q [NUM_FLAT];   // eithreshold (0 disables masking)

    // --- Doorbell decode ---------------------------------------------------
    // The addressed flat file is msi_addr_i / PAGE_BYTES (the doorbell is at
    // offset 0 within each 4 KiB file page). The committed identity is msi_id_i.
    wire [31:0] page_idx = msi_addr_i / PAGE_BYTES[31:0];
    wire        page_off0 = (msi_addr_i % PAGE_BYTES[31:0]) == 32'h0;
    wire [31:0] msi_id    = msi_id_i;

    wire        page_in_range = page_idx < NUM_FLAT[31:0];
    wire        id_in_range    = (msi_id >= 32'h1) && (msi_id <= NUM_IDS[31:0]);
    // The addressed page is a secure-world file iff it is the top local file of
    // its hart (and SECURE_FILE is set).
    wire        addr_is_secure = SECURE_FILE &&
                                 ((page_idx % NUM_FILES[31:0]) == SECURE_LOCAL[31:0]);
    // World gate: a doorbell write is committed only if the addressed file's
    // world matches the write's world. This is the secure-domain isolation: an
    // untrusted-world MSI cannot set a bit in the secure file, and vice versa.
    wire        world_ok = page_in_range && (addr_is_secure == msi_world_i);

    wire        doorbell_ok = msi_we_i && page_off0 && page_in_range &&
                              id_in_range && world_ok;

    assign msi_accept_o = doorbell_ok;
    assign msi_reject_o = msi_we_i && !doorbell_ok;

    // --- Per-file claim arbitration (AIA: lowest identity = highest priority).
    // The top deliverable identity is the smallest id that is pending, enabled,
    // and (when eithreshold != 0) strictly below the threshold.
    logic [ID_W-1:0] top_id  [NUM_FLAT];
    logic            top_any [NUM_FLAT];
    always_comb begin
        for (int unsigned f = 0; f < NUM_FLAT; f++) begin
            top_id[f]  = '0;
            top_any[f] = 1'b0;
            // Iterate high->low so the lowest (highest-priority) id wins.
            for (int unsigned i = NUM_IDS; i >= 1; i--) begin
                if (eip_q[f][i] && eie_q[f][i] &&
                    ((thr_q[f] == '0) || (i[ID_W-1:0] < thr_q[f]))) begin
                    top_id[f]  = i[ID_W-1:0];
                    top_any[f] = 1'b1;
                end
            end
        end
    end

    always_comb begin
        for (int unsigned f = 0; f < NUM_FLAT; f++) begin
            topei_id_o[f]   = top_id[f];
            topei_prio_o[f] = top_id[f];          // AIA priority == identity
            eip_any_o[f]    = top_any[f];
            irq_o[f]        = top_any[f];
        end
    end

    // --- State update ------------------------------------------------------
    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            for (int unsigned f = 0; f < NUM_FLAT; f++) begin
                eip_q[f] <= '0;
                eie_q[f] <= '0;
                thr_q[f] <= '0;
            end
        end else begin
            // Reserved identity 0 is never pending/enabled.
            for (int unsigned f = 0; f < NUM_FLAT; f++) begin
                eip_q[f][0] <= 1'b0;
                eie_q[f][0] <= 1'b0;
            end

            // Doorbell: set EIP for the addressed file/identity (world-checked).
            if (doorbell_ok) begin
                for (int unsigned f = 0; f < NUM_FLAT; f++)
                    if (page_idx == f[31:0])
                        eip_q[f][msi_id[ID_W-1:0]] <= 1'b1;
            end

            // CSR-side enable programming and xtopei claim.
            for (int unsigned f = 0; f < NUM_FLAT; f++) begin
                if (eie_we_i[f] && (eie_id_i != '0))
                    eie_q[f][eie_id_i] <= eie_val_i[f];
                if (thr_we_i[f])
                    thr_q[f] <= thr_val_i;
                // Claim clears the top identity's pending bit (xtopei read).
                if (topei_claim_i[f] && top_any[f])
                    eip_q[f][top_id[f]] <= 1'b0;
            end
        end
    end

    // Unused upper address / id bits.
    /* verilator lint_off UNUSEDSIGNAL */
    logic unused;
    /* verilator lint_on UNUSEDSIGNAL */
    assign unused = ^{msi_addr_i, msi_id_i[31:ID_W], page_idx[31:1]};

endmodule : e1_imsic
