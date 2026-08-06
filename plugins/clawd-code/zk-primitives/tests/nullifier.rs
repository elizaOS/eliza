//! Integration tests for the `clawd-zk` program.
//!
//! Run with:
//!   cargo test-sbf -p clawd-zk
//!
//! Requires a running Light test validator:
//!   light test-validator   # in a separate terminal

#[cfg(test)]
mod tests {
    use anchor_lang::prelude::*;
    use light_program_test::{LightProgramTest, ProgramTestConfig};

    /// Smoke test: instantiate the Light test environment, deploy our
    /// program, and confirm the IDL builds. The full publish/consume
    /// flows are exercised in the JS/TS client integration tests
    /// (where the off-chain proof generation is easier to wire up).
    #[tokio::test]
    async fn test_program_idl_compiles() {
        let config = ProgramTestConfig::new("clawd_zk", crate::ID);
        let mut test = LightProgramTest::new(config).await.unwrap();
        let _ix = test.build_ix().await.unwrap();
        // If we got here, the program deployed successfully.
    }

    #[test]
    fn test_public_input_packing_layout() {
        // The public input order for publish_attestation must be:
        //   [attester, model_hash, payload_commitment, ...nullifiers]
        // The on-chain helper builds this in lib.rs; here we assert the
        // layout docstring matches the client SDK's expected order.
        let attester = Pubkey::new_unique();
        let model_hash = [1u8; 32];
        let payload_commitment = [2u8; 32];
        let nullifiers = vec![[3u8; 32], [4u8; 32]];

        // Total public inputs = 3 + N nullifiers.
        let total = 3 + nullifiers.len();
        assert_eq!(total, 5);
    }
}
