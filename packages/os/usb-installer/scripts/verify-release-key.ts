// Production packaging gate: no USB installer is released without a pinned key.
import {
  loadPinnedEd25519PublicKey,
  publicKeyFingerprint,
} from "../src/backend/ed25519-trust";

const key = loadPinnedEd25519PublicKey();
if (!/^[a-f0-9]{64}$/.test(publicKeyFingerprint(key))) {
  throw new Error("Pinned Ed25519 release key fingerprint is invalid.");
}
