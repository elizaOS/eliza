/*
 * Secure boot key handling.
 *
 * Placeholder. Production firmware verifies the OpenSBI image HMAC against
 * a fused public key and seeds the AVFS / DVFS table with signed entries.
 *
 * Release blockers:
 *   - Key provisioning policy not closed.
 *   - HMAC/ECDSA implementation not landed.
 *   - Fuse map not selected.
 */

#include "pmc.h"

int pmc_secure_boot_verify(const uint8_t *image, size_t length)
{
    (void)image;
    (void)length;
    return 0;
}
