pub mod coder_status;

pub use coder_status::CoderStatusProvider;

pub fn get_code_providers() -> Vec<Box<dyn crate::Provider>> {
    vec![Box::new(CoderStatusProvider)]
}
