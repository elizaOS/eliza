pub mod create_cron;
pub mod delete_cron;
pub mod list_crons;
pub mod run_cron;
pub mod update_cron;

pub use create_cron::CreateCronAction;
pub use delete_cron::DeleteCronAction;
pub use list_crons::ListCronsAction;
pub use run_cron::RunCronAction;
pub use update_cron::UpdateCronAction;

pub fn get_cron_actions() -> Vec<Box<dyn crate::Action>> {
    vec![
        Box::new(CreateCronAction),
        Box::new(UpdateCronAction),
        Box::new(DeleteCronAction),
        Box::new(ListCronsAction),
        Box::new(RunCronAction),
    ]
}
