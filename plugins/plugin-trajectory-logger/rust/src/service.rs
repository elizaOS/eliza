use crate::types::{
    ActionAttempt, EnvironmentState, FinalStatus, JsonValue, LLMCall, ProviderAccess,
    RewardComponents, Trajectory, TrajectoryMetrics, TrajectoryStep,
};
use std::collections::HashMap;
use uuid::Uuid;

/// In-memory trajectory logger.
#[derive(Debug, Default)]
pub struct TrajectoryLoggerService {
    active_trajectories: HashMap<String, Trajectory>,
    active_step_ids: HashMap<String, String>,
}

impl TrajectoryLoggerService {
    /// Create a new empty logger service.
    pub fn new() -> Self {
        Self::default()
    }

    /// Start a new trajectory and return its id.
    pub fn start_trajectory(
        &mut self,
        agent_id: &str,
        now_ms: i64,
        options: StartTrajectoryOptions,
    ) -> String {
        let trajectory_id = Uuid::new_v4().to_string();

        let traj = Trajectory {
            trajectory_id: trajectory_id.clone(),
            agent_id: agent_id.to_string(),
            start_time: now_ms,
            end_time: now_ms,
            duration_ms: 0,
            episode_id: options.episode_id,
            scenario_id: options.scenario_id,
            batch_id: options.batch_id,
            group_index: options.group_index,
            steps: Vec::new(),
            total_reward: 0.0,
            reward_components: RewardComponents {
                environment_reward: 0.0,
                ..Default::default()
            },
            metrics: TrajectoryMetrics {
                episode_length: 0,
                final_status: FinalStatus::Completed,
                ..Default::default()
            },
            metadata: options.metadata.unwrap_or_default(),
        };

        self.active_trajectories.insert(trajectory_id.clone(), traj);
        trajectory_id
    }

    /// Start a new step in an existing trajectory and return the step id.
    pub fn start_step(
        &mut self,
        trajectory_id: &str,
        env_state: EnvironmentState,
        now_ms: i64,
    ) -> String {
        let traj = self
            .active_trajectories
            .get_mut(trajectory_id)
            .expect("trajectory not found");

        let step_id = Uuid::new_v4().to_string();
        let step = TrajectoryStep {
            step_id: step_id.clone(),
            step_number: traj.steps.len() as u32,
            timestamp: if env_state.timestamp == 0 {
                now_ms
            } else {
                env_state.timestamp
            },
            environment_state: env_state,
            observation: HashMap::new(),
            llm_calls: Vec::new(),
            provider_accesses: Vec::new(),
            reasoning: None,
            action: ActionAttempt {
                attempt_id: "".to_string(),
                timestamp: 0,
                action_type: "pending".to_string(),
                action_name: "pending".to_string(),
                parameters: HashMap::new(),
                reasoning: None,
                llm_call_id: None,
                success: false,
                result: None,
                error: None,
                immediate_reward: None,
            },
            reward: 0.0,
            done: false,
            metadata: None,
        };

        traj.steps.push(step);
        self.active_step_ids
            .insert(trajectory_id.to_string(), step_id.clone());
        step_id
    }

    /// Get current step id for a trajectory.
    pub fn get_current_step_id(&self, trajectory_id: &str) -> Option<String> {
        self.active_step_ids.get(trajectory_id).cloned()
    }

    /// Log an LLM call into a step.
    pub fn log_llm_call(&mut self, step_id: &str, llm_call: LLMCall) {
        if let Some(traj_id) = self.find_trajectory_id_by_step_id(step_id) {
            if let Some(traj) = self.active_trajectories.get_mut(&traj_id) {
                if let Some(step) = traj.steps.iter_mut().find(|s| s.step_id == step_id) {
                    step.llm_calls.push(llm_call);
                }
            }
        }
    }

    /// Log provider access into a step.
    pub fn log_provider_access(&mut self, step_id: &str, access: ProviderAccess) {
        if let Some(traj_id) = self.find_trajectory_id_by_step_id(step_id) {
            if let Some(traj) = self.active_trajectories.get_mut(&traj_id) {
                if let Some(step) = traj.steps.iter_mut().find(|s| s.step_id == step_id) {
                    step.provider_accesses.push(access);
                }
            }
        }
    }

    /// Convenience: log an LLM call by trajectory id (uses current step).
    pub fn log_llm_call_by_trajectory_id(&mut self, trajectory_id: &str, llm_call: LLMCall) {
        if let Some(step_id) = self.active_step_ids.get(trajectory_id).cloned() {
            self.log_llm_call(&step_id, llm_call);
        }
    }

    /// Convenience: log provider access by trajectory id (uses current step).
    pub fn log_provider_access_by_trajectory_id(
        &mut self,
        trajectory_id: &str,
        access: ProviderAccess,
    ) {
        if let Some(step_id) = self.active_step_ids.get(trajectory_id).cloned() {
            self.log_provider_access(&step_id, access);
        }
    }

    /// Complete a step with action and optional reward updates.
    pub fn complete_step(
        &mut self,
        trajectory_id: &str,
        step_id: &str,
        action: ActionAttempt,
        reward: Option<f64>,
        components: Option<RewardComponents>,
    ) {
        let traj = match self.active_trajectories.get_mut(trajectory_id) {
            Some(t) => t,
            None => return,
        };

        let step = match traj.steps.iter_mut().find(|s| s.step_id == step_id) {
            Some(s) => s,
            None => return,
        };

        step.action = action;

        if let Some(r) = reward {
            step.reward = r;
            traj.total_reward += r;
        }

        if let Some(c) = components {
            traj.reward_components = c;
        }

        self.active_step_ids.remove(trajectory_id);
    }

    /// End trajectory and finalize metrics.
    pub fn end_trajectory(
        &mut self,
        trajectory_id: &str,
        status: FinalStatus,
        now_ms: i64,
        final_metrics: Option<HashMap<String, JsonValue>>,
    ) {
        let traj = match self.active_trajectories.get_mut(trajectory_id) {
            Some(t) => t,
            None => return,
        };

        traj.end_time = now_ms;
        traj.duration_ms = traj.end_time - traj.start_time;
        traj.metrics.final_status = status;
        traj.metrics.episode_length = traj.steps.len() as u32;

        if let Some(extra) = final_metrics {
            for (k, v) in extra {
                traj.metrics.extra.insert(k, v);
            }
        }

        self.active_step_ids.remove(trajectory_id);
    }

    /// Get an active trajectory by id.
    pub fn get_active_trajectory(&self, trajectory_id: &str) -> Option<&Trajectory> {
        self.active_trajectories.get(trajectory_id)
    }

    fn find_trajectory_id_by_step_id(&self, step_id: &str) -> Option<String> {
        for (id, traj) in &self.active_trajectories {
            if traj.steps.iter().any(|s| s.step_id == step_id) {
                return Some(id.clone());
            }
        }
        None
    }
}

/// Options for starting a trajectory.
#[derive(Debug, Clone, Default)]
pub struct StartTrajectoryOptions {
    /// Optional scenario identifier for grouping related trajectories.
    pub scenario_id: Option<String>,
    /// Optional episode identifier within a scenario.
    pub episode_id: Option<String>,
    /// Optional batch identifier for bulk processing.
    pub batch_id: Option<String>,
    /// Optional index within a trajectory group.
    pub group_index: Option<u32>,
    /// Optional additional metadata as key-value pairs.
    pub metadata: Option<HashMap<String, JsonValue>>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{LLMMessage, LLMPurpose};

    #[test]
    fn test_service_records_step() {
        let mut svc = TrajectoryLoggerService::new();
        let now = 1_700_000_000_000i64;

        let traj_id = svc.start_trajectory("agent-1", now, StartTrajectoryOptions::default());
        let step_id = svc.start_step(
            &traj_id,
            EnvironmentState {
                timestamp: now,
                agent_balance: 0.0,
                agent_points: 0.0,
                agent_pnl: 0.0,
                open_positions: 0,
                active_markets: None,
                portfolio_value: None,
                unread_messages: None,
                recent_engagement: None,
                custom: None,
            },
            now,
        );

        svc.log_llm_call(
            &step_id,
            LLMCall {
                call_id: Uuid::new_v4().to_string(),
                timestamp: now,
                model: "test-model".to_string(),
                model_version: None,
                system_prompt: "sys".to_string(),
                user_prompt: "user".to_string(),
                messages: Some(vec![LLMMessage {
                    role: "user".to_string(),
                    content: "user".to_string(),
                }]),
                response: "assistant".to_string(),
                reasoning: None,
                temperature: 0.7,
                max_tokens: 32,
                top_p: None,
                prompt_tokens: None,
                completion_tokens: None,
                latency_ms: None,
                purpose: LLMPurpose::Action,
                action_type: None,
            },
        );

        svc.complete_step(
            &traj_id,
            &step_id,
            ActionAttempt {
                attempt_id: Uuid::new_v4().to_string(),
                timestamp: now,
                action_type: "TEST".to_string(),
                action_name: "TEST".to_string(),
                parameters: HashMap::new(),
                reasoning: None,
                llm_call_id: None,
                success: true,
                result: None,
                error: None,
                immediate_reward: None,
            },
            Some(0.1),
            None,
        );

        svc.end_trajectory(&traj_id, FinalStatus::Completed, now + 10, None);
        let t = svc.get_active_trajectory(&traj_id).unwrap();
        assert_eq!(t.steps.len(), 1);
        assert_eq!(t.metrics.episode_length, 1);
    }
}
