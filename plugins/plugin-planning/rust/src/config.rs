#![allow(missing_docs)]

use crate::types::{ExecutionModel, RetryPolicy};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanningConfig {
    pub max_steps: i32,
    pub default_timeout_ms: i64,
    pub execution_model: ExecutionModel,
    pub enable_adaptation: bool,
    pub retry_policy: RetryPolicy,
    pub planning_model_type: String,
    pub planning_temperature: f32,
    pub planning_max_tokens: i32,
}


impl Default for PlanningConfig {
    fn default() -> Self {
        Self {
            max_steps: 10,
            default_timeout_ms: 60000,
            execution_model: ExecutionModel::Sequential,
            enable_adaptation: true,
            retry_policy: RetryPolicy::default(),
            planning_model_type: "TEXT_LARGE".to_string(),
            planning_temperature: 0.3,
            planning_max_tokens: 2000,
        }
    }
}

impl PlanningConfig {
    pub fn from_env() -> Self {
        let mut config = Self::default();

        if let Ok(val) = std::env::var("PLANNING_MAX_STEPS") {
            if let Ok(n) = val.parse() {
                config.max_steps = n;
            }
        }

        if let Ok(val) = std::env::var("PLANNING_TIMEOUT_MS") {
            if let Ok(n) = val.parse() {
                config.default_timeout_ms = n;
            }
        }

        if let Ok(val) = std::env::var("PLANNING_EXECUTION_MODEL") {
            config.execution_model = match val.to_lowercase().as_str() {
                "parallel" => ExecutionModel::Parallel,
                "dag" => ExecutionModel::Dag,
                _ => ExecutionModel::Sequential,
            };
        }

        if let Ok(val) = std::env::var("PLANNING_ENABLE_ADAPTATION") {
            config.enable_adaptation = val.to_lowercase() != "false";
        }

        if let Ok(val) = std::env::var("PLANNING_MODEL_TYPE") {
            config.planning_model_type = val;
        }

        if let Ok(val) = std::env::var("PLANNING_TEMPERATURE") {
            if let Ok(n) = val.parse() {
                config.planning_temperature = n;
            }
        }

        config
    }
}
