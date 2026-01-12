pub mod shell_history;

pub use shell_history::ShellHistoryProvider;

pub fn get_shell_providers() -> Vec<Box<dyn crate::Provider>> {
    vec![Box::new(ShellHistoryProvider)]
}
