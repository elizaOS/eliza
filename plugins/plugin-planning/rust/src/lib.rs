#![allow(missing_docs)]

pub mod actions;
pub mod error;
pub mod providers;
pub mod types;

pub struct PlanningPlugin {
    pub name: &'static str,
    pub description: &'static str,
}

impl PlanningPlugin {
    pub const fn new() -> Self {
        Self {
            name: "@elizaos/plugin-planning-rs",
            description: "Plugin for planning and task management with create, update, complete, and get capabilities",
        }
    }

    pub fn actions() -> Vec<&'static str> {
        vec!["CREATE_PLAN", "UPDATE_PLAN", "COMPLETE_TASK", "GET_PLAN"]
    }

    pub fn providers() -> Vec<&'static str> {
        vec!["PLAN_STATUS"]
    }
}

impl Default for PlanningPlugin {
    fn default() -> Self {
        Self::new()
    }
}

pub static PLUGIN: PlanningPlugin = PlanningPlugin::new();
