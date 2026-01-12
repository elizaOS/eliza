pub mod execute_command;
pub mod clear_history;

pub use execute_command::ExecuteCommandAction;
pub use clear_history::ClearHistoryAction;

pub fn get_shell_actions() -> Vec<Box<dyn crate::Action>> {
    vec![
        Box::new(ExecuteCommandAction),
        Box::new(ClearHistoryAction),
    ]
}
