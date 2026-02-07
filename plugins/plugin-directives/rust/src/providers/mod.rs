pub mod directive_state;

pub use directive_state::DirectiveStateProvider;

pub fn get_directive_providers() -> Vec<Box<dyn crate::Provider>> {
    vec![Box::new(DirectiveStateProvider)]
}
