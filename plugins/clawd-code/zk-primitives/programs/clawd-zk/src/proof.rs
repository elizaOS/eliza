//! Groth16 proof verification.
//!
//! Uses `light-verifier` (the same verifier Light Protocol uses
//! internally for its validity proofs). ~200k CU per verification.
//!
//! The verifying key is supplied as instruction data, which means the
//! program can support any circuit the client produces — model inference
//! proofs, shielded-pool proofs, ZK-ID proofs, etc. — without program
//! upgrades. The cost is a slightly larger instruction (a few hundred
//! bytes for the VK).

use anchor_lang::prelude::Result;
use light_verifier::{Groth16, Groth16Verifier, G1, G2};

/// Verify a Groth16 proof against the supplied public inputs and
/// verifying key. Returns `Ok(())` on success; an error on any parse
/// or pairing failure.
pub fn verify_groth16(
    proof_a: &[u8; 64],
    proof_b: &[u8; 128],
    proof_c: &[u8; 64],
    public_inputs: &[[u8; 32]],
    verifying_key: &[u8],
) -> Result<()> {
    // Parse proof points. The wire format is big-endian alt-bn128;
    // light-verifier expects little-endian. We swap on parse.
    let mut proof_a_bytes = [0u8; 64];
    swap_endianness(&mut proof_a_bytes, proof_a);
    let g1_a = <G1 as FromBytes>::read(&proof_a_bytes[..])
        .map_err(|_| ProofError::MalformedProofPointA)?;

    let g2_b = <G2 as FromBytes>::read(proof_b)
        .map_err(|_| ProofError::MalformedProofPointB)?;

    let g1_c = <G1 as FromBytes>::read(proof_c)
        .map_err(|_| ProofError::MalformedProofPointC)?;

    // Parse the verifying key. The on-chain VK is a serialized
    // [G1; 2] (alpha, gamma) + [G2; 2] (beta, delta) + [G1; n] (gamma_abc).
    // `light-verifier` expects this layout. The total length depends on
    // the circuit's number of public inputs.
    let vk = deserialize_vk(verifying_key)?;

    // Run the verifier. The constructor handles pairing prep; `verify`
    // returns `Result<(), ()>`.
    let mut verifier = Groth16Verifier::new(&g1_a, &g2_b, &g1_c, public_inputs, &vk)
        .map_err(|_| ProofError::VerifierInitFailed)?;
    verifier
        .verify()
        .map_err(|_| ProofError::ProofRejected)?;

    Ok(())
}

fn swap_endianness(out: &mut [u8; 64], inp: &[u8; 64]) {
    // Reverse 32-byte chunks (alt_bn128 field elements are 32 bytes
    // in big-endian; Solana Groth16 libs use little-endian).
    for i in 0..2 {
        let chunk = &inp[i * 32..(i + 1) * 32];
        let mut le = [0u8; 32];
        for j in 0..32 {
            le[j] = chunk[31 - j];
        }
        out[i * 32..(i + 1) * 32].copy_from_slice(&le);
    }
}

fn deserialize_vk(bytes: &[u8]) -> Result<Groth16> {
    // The simplest portable format: serialize each element as 32 (G1) or
    // 64 (G2) raw bytes. The total length tells us how many gamma_abc
    // entries to read. For a circuit with N public inputs, the VK has
    // 2 G1 elements (alpha, gamma_g2) + 2 G2 (beta_g1, delta_g1) + (N+1) G1
    // gamma_abc elements. In our scheme the alpha/beta/gamma/delta are
    // G1+G2 and gamma_abc is the IC vector.
    //
    // For brevity, we accept a single pre-encoded byte string the
    // light-verifier can parse. In a production build this would be
    // pinned to a circuit-specific format.
    use std::io::Cursor;
    let mut cursor = Cursor::new(bytes);
    Groth16::deserialize(&mut cursor).map_err(|_| ProofError::MalformedVerifyingKey)
}

#[derive(Debug)]
pub enum ProofError {
    MalformedProofPointA,
    MalformedProofPointB,
    MalformedProofPointC,
    MalformedVerifyingKey,
    VerifierInitFailed,
    ProofRejected,
}

impl std::fmt::Display for ProofError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}", self)
    }
}

impl std::error::Error for ProofError {}

impl From<ProofError> for anchor_lang::error::Error {
    fn from(_: ProofError) -> Self {
        anchor_lang::error::Error::default()
    }
}

/// Extension trait: parse a G1 point from a fixed-size byte slice.
trait FromBytes: Sized {
    fn read(bytes: &[u8]) -> Result<Self, ()>;
}

impl FromBytes for G1 {
    fn read(bytes: &[u8]) -> Result<Self, ()> {
        // The actual parser is provided by light-verifier. We delegate
        // by deserializing the whole point via a temporary Groth16
        // helper. For the purposes of this scaffold, we use the
        // `light-verifier` `read` API which is stable across versions.
        use light_verifier::G1 as G1T;
        // 32-byte field element read.
        if bytes.len() < 32 {
            return Err(());
        }
        let mut x = [0u8; 32];
        x.copy_from_slice(&bytes[..32]);
        let mut y = [0u8; 32];
        if bytes.len() >= 64 {
            y.copy_from_slice(&bytes[32..64]);
        }
        G1T::from_le_bytes(&x, &y).ok_or(())
    }
}

impl FromBytes for G2 {
    fn read(bytes: &[u8]) -> Result<Self, ()> {
        use light_verifier::G2 as G2T;
        if bytes.len() < 128 {
            return Err(());
        }
        let mut x0 = [0u8; 32];
        x0.copy_from_slice(&bytes[..32]);
        let mut x1 = [0u8; 32];
        x1.copy_from_slice(&bytes[32..64]);
        let mut y0 = [0u8; 32];
        y0.copy_from_slice(&bytes[64..96]);
        let mut y1 = [0u8; 32];
        y1.copy_from_slice(&bytes[96..128]);
        G2T::from_le_bytes(&x0, &x1, &y0, &y1).ok_or(())
    }
}
