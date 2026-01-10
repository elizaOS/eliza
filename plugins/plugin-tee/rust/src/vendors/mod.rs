//! TEE Vendors module.

pub mod phala;
pub mod types;

pub use phala::PhalaVendor;
pub use types::{TeeVendorInterface, TeeVendorNames};

use crate::error::{Result, TeeError};

/// Get a vendor by name.
///
/// # Arguments
///
/// * `vendor_type` - The vendor type name.
///
/// # Returns
///
/// The vendor implementation.
///
/// # Errors
///
/// Returns an error if the vendor is not supported.
pub fn get_vendor(vendor_type: &str) -> Result<Box<dyn TeeVendorInterface>> {
    match vendor_type.to_lowercase().as_str() {
        "phala" => Ok(Box::new(PhalaVendor::new())),
        _ => Err(TeeError::InvalidVendor(vendor_type.to_string())),
    }
}

