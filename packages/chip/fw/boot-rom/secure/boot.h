/*
 * Mask-ROM C entrypoint contract.
 *
 * reset.S sets up the stack and trap vector, then calls e1_secure_boot_main().
 * The C side reads OTP and the candidate first-stage image, verifies it with
 * the OPNPHN01 verifier, extends the boot measurement, and returns the
 * authenticated entry address. On any failure it returns 0, which the assembly
 * treats as a hard fail-closed trap (no unsigned fallback, no fixed handoff).
 *
 * The platform-specific OTP read and image-location read are provided by the
 * ROM integration as e1_rom_read_otp() and e1_rom_image_base()/_len(); in this
 * software-only checkout they are weak stubs that fail closed (parity not OK),
 * so a ROM built without a real platform binding refuses to hand off rather
 * than booting an unverified image.
 */

#ifndef E1_BOOTROM_SECURE_BOOT_H
#define E1_BOOTROM_SECURE_BOOT_H

#include <stddef.h>
#include <stdint.h>

#include "verify.h"

/*
 * Returns the authenticated next-stage entry address, or 0 to trap. The
 * accumulated boot measurement and the parsed first-stage header are written
 * through the out-params when non-NULL (for the measurement export path).
 */
uint64_t e1_secure_boot_main(void);

/* Platform bindings (provided by the RTL/SoC integration). */
const uint8_t *e1_rom_image_base(void);
size_t e1_rom_image_len(void);
uint64_t e1_rom_image_entry(void);
void e1_rom_read_otp(struct opnphn01_otp *otp);
void e1_rom_emit_halt(const uint8_t record[HALT_RECORD_LEN]);

#endif /* E1_BOOTROM_SECURE_BOOT_H */
