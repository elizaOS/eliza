pub mod command_registry;

pub use command_registry::CommandRegistryProvider;

pub fn get_command_providers() -> Vec<Box<dyn crate::Provider>> {
    vec![Box::new(CommandRegistryProvider)]
}
