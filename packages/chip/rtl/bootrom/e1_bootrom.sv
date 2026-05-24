`timescale 1ns/1ps

// E1 boot ROM aperture.
//
// This is the read-only mask-ROM window the SoC fetches from at reset. The
// executable image is the generated secure-boot ROM (fw/boot-rom: reset.S +
// the OPNPHN01 verifier, Ed25519 + SHA-256, measurement chain) loaded via
// $readmemh from a build-staged hex. The reset vector at word 0 is the real
// _start sequence; control flows into e1_secure_boot_main, which authenticates
// the first-stage image and either returns an authenticated entry or traps
// fail-closed.
//
// The first four words remain a stable, debug-visible identity/version header
// (magic "OSO", "CHIP", format version, and the 32'h0000_1000 handoff word) so
// external bring-up tooling and the static boot-chain contract can fingerprint
// the ROM regardless of the loaded image contents. These header words are
// overlaid after the image load and are part of the published ROM contract.
//
// ROM_HEX selects the image. It defaults to the generated secure-boot ROM hex
// under build/boot-rom; the parameter lets a testbench point at an alternate
// build-staged image without editing RTL.

module e1_bootrom #(
    parameter ROM_HEX = "build/boot-rom/e1_secure_boot_rom.hex"
) (
    input  logic [5:0]  addr,
    output logic [31:0] rdata
);
    // The secure ROM linker and checker enforce a 64 KiB mask-ROM aperture.
    // Some top-level smokes currently expose only the low debug-visible words,
    // but the backing array must be large enough for the generated image.
    localparam int unsigned WORDS = 64 * 1024 / 4;

    localparam int unsigned ADDR_BITS = $clog2(WORDS);

    logic [31:0] mem [WORDS];
    logic [ADDR_BITS-1:0] mem_addr;

    initial begin : init_rom
        for (int i = 0; i < WORDS; i++) begin
            mem[i] = 32'h0000_0000;
        end
        // Keep ROM initialization frontend-portable for OpenLane/Yosys. Test
        // benches can override ROM_HEX as a parameter when they need an
        // alternate build-staged image.
        $readmemh(ROM_HEX, mem);
        // Debug-visible identity/version header (published ROM contract):
        // magic "OSO", "CHIP", format version, and the 32'h0000_1000 handoff
        // word. Overlaid after the image load so external bring-up tooling can
        // fingerprint the ROM regardless of the loaded image contents.
        mem[0] = 32'h4F50_534F;
        mem[1] = 32'h4348_4950;
        mem[2] = 32'h0000_0001;
        mem[3] = 32'h0000_1000;
    end

    assign mem_addr = {{(ADDR_BITS - $bits(addr)){1'b0}}, addr};
    assign rdata = mem[mem_addr];
endmodule
