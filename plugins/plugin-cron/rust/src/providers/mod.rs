pub mod cron_context;

pub use cron_context::CronContextProvider;

pub fn get_cron_providers() -> Vec<Box<dyn crate::Provider>> {
    vec![Box::new(CronContextProvider)]
}
