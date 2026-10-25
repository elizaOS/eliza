/**
 * Generates the short-lived human-entered proof used by identity linking.
 * Every symbol is selected with `randomInt`, which performs rejection sampling
 * and avoids the modulo bias introduced by reducing a random byte.
 */
import { randomInt } from "node:crypto";

/** Unambiguous alphabet (no 0/O, 1/I/L) so codes survive being typed by hand. */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;

/** How the code is presented to and typed by the user, e.g. `LINK-7KQ2M4XW`. */
export const LINK_CODE_PATTERN = /\bLINK-([A-HJ-NP-Z2-9]{8})\b/i;

type SecureRandomIndex = (maxExclusive: number) => number;

/** Mint one unbiased identity-link proof code from the platform CSPRNG. */
export function mintIdentityLinkCode(randomIndex: SecureRandomIndex = randomInt): string {
  let code = "";
  for (let index = 0; index < CODE_LENGTH; index++) {
    const alphabetIndex = randomIndex(CODE_ALPHABET.length);
    if (
      !Number.isInteger(alphabetIndex) ||
      alphabetIndex < 0 ||
      alphabetIndex >= CODE_ALPHABET.length
    ) {
      throw new RangeError("Identity-link random index is outside the code alphabet");
    }
    code += CODE_ALPHABET[alphabetIndex];
  }
  return code;
}
