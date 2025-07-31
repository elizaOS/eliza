import { randomBytes } from "crypto";
import { sha256, toHex } from "viem";

const BYTE_LENGTH = 512;
const secret = randomBytes(BYTE_LENGTH);
const hash = sha256(secret);

console.log({
  secret: toHex(secret),
  hash,
});
