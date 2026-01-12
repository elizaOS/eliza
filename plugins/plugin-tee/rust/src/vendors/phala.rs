#![allow(missing_docs)]

use crate::vendors::types::{TeeVendorInterface, TeeVendorNames};

pub struct PhalaVendor;

impl PhalaVendor {
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
