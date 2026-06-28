/*
 * Boot shim for the OpenSBI-on-CVA6 Verilator boot.
 *
 * CVA6 is released by the RoT with its reset vector at the DRAM base
 * (0x8000_0000) and all GPRs zero.  Real silicon's secure boot-ROM / loader
 * would place OpenSBI in DRAM and enter it with a0=hartid and a1=DTB pointer;
 * in this sim the deterministic preload image plays the role of that loader,
 * and this shim plays the role of its final hand-off stub: it sets the two
 * argument registers OpenSBI's _fw_start expects, then jumps to OpenSBI's
 * link/entry address (FW_TEXT_START), which sits just above the shim.
 *
 * The shim, OpenSBI, the DTB, and the S-mode payload are all assembled into
 * one dense DRAM preload image by build_boot_image.py; the addresses below are
 * injected at assemble time so the shim and the layout stay in lock-step.
 *
 *   OPENSBI_ENTRY  - OpenSBI FW_TEXT_START (its _fw_start)
 *   DTB_ADDR       - device-tree blob load address (passed in a1)
 *
 * Both are -D defines on the assembler command line (build_boot_image.py).
 */

#ifndef OPENSBI_ENTRY
#error "OPENSBI_ENTRY must be defined (OpenSBI FW_TEXT_START)"
#endif
#ifndef DTB_ADDR
#error "DTB_ADDR must be defined (device-tree blob load address)"
#endif

	.option norvc
	.section .text.shim, "ax", @progbits
	.globl _start
_start:
	li	a0, 0            /* hartid = 0 */
	li	a1, DTB_ADDR     /* a1 = device-tree blob pointer */
	li	t0, OPENSBI_ENTRY
	jr	t0               /* enter OpenSBI _fw_start in M-mode */
