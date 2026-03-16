pub mod commands_list;
pub mod help;
pub mod models;
pub mod status;
pub mod stop;

pub use commands_list::CommandsListAction;
pub use help::HelpCommandAction;
pub use models::ModelsCommandAction;
pub use status::StatusCommandAction;
pub use stop::StopCommandAction;

pub fn get_command_actions() -> Vec<Box<dyn crate::Action>> {
    vec![
        Box::new(HelpCommandAction),
        Box::new(StatusCommandAction),
        Box::new(StopCommandAction),
        Box::new(ModelsCommandAction),
        Box::new(CommandsListAction),
    ]
}
