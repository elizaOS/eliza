#![allow(missing_docs)]

pub struct TeeVendorNames;

impl TeeVendorNames {
    pub const PHALA: &'static str = "phala";
}

pub trait TeeVendorInterface: Send + Sync {
    fn vendor_type(&self) -> &'static str;
    fn name(&self) -> &'static str;
    fn description(&self) -> &'static str;
    fn action_names(&self) -> Vec<&'static str>;
    fn provider_names(&self) -> Vec<&'static str>;
}
