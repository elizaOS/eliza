//! TEE Vendor types and interfaces.

/// Supported TEE vendor names.
pub struct TeeVendorNames;

impl TeeVendorNames {
    /// Phala Network.
    pub const PHALA: &'static str = "phala";
}

/// Interface for a TEE vendor implementation.
pub trait TeeVendorInterface: Send + Sync {
    /// Get the vendor type.
    fn vendor_type(&self) -> &'static str;

    /// Get the vendor name.
    fn name(&self) -> &'static str;

    /// Get the vendor description.
    fn description(&self) -> &'static str;

    /// Get action names provided by this vendor.
    fn action_names(&self) -> Vec<&'static str>;

    /// Get provider names provided by this vendor.
    fn provider_names(&self) -> Vec<&'static str>;
}


