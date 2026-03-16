#![allow(missing_docs)]

pub mod phala;
pub mod types;

pub use phala::PhalaVendor;
pub use types::{TeeVendorInterface, TeeVendorNames};

use crate::error::{Result, TeeError};

pub fn get_vendor(vendor_type: &str) -> Result<Box<dyn TeeVendorInterface>> {
    match vendor_type.to_lowercase().as_str() {
        "phala" => Ok(Box::new(PhalaVendor::new())),
        _ => Err(TeeError::InvalidVendor(vendor_type.to_string())),
    }
}
