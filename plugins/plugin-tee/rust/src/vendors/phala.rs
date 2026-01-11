#![allow(missing_docs)]
//! Phala Network TEE Vendor implementation.

use crate::vendors::types::{TeeVendorInterface, TeeVendorNames};

/// Phala Network TEE Vendor.
///
/// Provides TEE capabilities using Phala Network's DStack SDK.
pub struct PhalaVendor;

impl PhalaVendor {
    /// Create a new Phala vendor.
    pub fn new() -> Self {
        Self
    }
}


impl Default for PhalaVendor {
    fn default() -> Self {
        Self::new()
    }
}

impl TeeVendorInterface for PhalaVendor {
    fn vendor_type(&self) -> &'static str {
        TeeVendorNames::PHALA
    }

    fn name(&self) -> &'static str {
        "phala-tee-plugin"
    }

    fn description(&self) -> &'static str {
        "Phala Network TEE for secure agent execution"
    }

    fn action_names(&self) -> Vec<&'static str> {
        vec!["REMOTE_ATTESTATION"]
    }

    fn provider_names(&self) -> Vec<&'static str> {
        vec!["phala-derive-key", "phala-remote-attestation"]
    }
}




