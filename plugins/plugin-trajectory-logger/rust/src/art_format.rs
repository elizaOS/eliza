use crate::types::{
    ARTTrajectory, ChatMessage, JsonValue, Trajectory, TrajectoryGroup, TrajectoryStep,
};
use std::collections::HashMap;

/// Convert a rich trajectory to an ART message array.
pub fn to_art_messages(trajectory: &Trajectory) -> Vec<ChatMessage> {
    let mut messages: Vec<ChatMessage> = Vec::new();

    if let Some(system) = build_system_message(trajectory) {
        messages.push(system);
    }

    for step in &trajectory.steps {
        if let Some(user) = build_user_message(step) {
            messages.push(ChatMessage {
                role: "user".to_string(),
                content: user,
                name: None,
            });
        }

        if let Some(assistant) = build_assistant_message(step) {
            messages.push(ChatMessage {
                role: "assistant".to_string(),
                content: assistant,
                name: None,
            });
        }
    }

    messages
}

fn build_system_message(trajectory: &Trajectory) -> Option<ChatMessage> {
    if let Some(first_step) = trajectory.steps.first() {
        if let Some(first_call) = first_step.llm_calls.first() {
            if !first_call.system_prompt.is_empty() {
                return Some(ChatMessage {
                    role: "system".to_string(),
                    content: first_call.system_prompt.clone(),
                    name: None,
                });
            }
        }
    }

    let agent_name = trajectory
        .metadata
        .get("agentName")
        .and_then(|v| v.as_str())
        .unwrap_or("Agent");
    let goal = trajectory
        .metadata
        .get("goalDescription")
        .and_then(|v| v.as_str())
        .unwrap_or("make good decisions");

    Some(ChatMessage {
        role: "system".to_string(),
        content: format!(
            "You are {}, an autonomous agent. Your goal is to {}.",
            agent_name, goal
        ),
        name: None,
    })
}

fn build_user_message(step: &TrajectoryStep) -> Option<String> {
    if let Some(call) = step
        .llm_calls
        .iter()
        .find(|c| matches!(c.purpose, crate::types::LLMPurpose::Action))
    {
        if !call.user_prompt.is_empty() {
            return Some(call.user_prompt.clone());
        }
    }

    let mut parts: Vec<String> = Vec::new();
    parts.push("Current state:".to_string());
    parts.push(format!(
        "- Balance: ${}",
        step.environment_state.agent_balance
    ));
    parts.push(format!("- P&L: ${}", step.environment_state.agent_pnl));
    parts.push(format!(
        "- Open Positions: {}",
        step.environment_state.open_positions
    ));

    for provider in &step.provider_accesses {
        parts.push(format!("\n{} data:", provider.provider_name));
        parts.push(
            serde_json::to_string_pretty(&provider.data)
                .unwrap_or_default()
                .to_string(),
        );
    }

    parts.push("\nWhat action should you take?".to_string());
    Some(parts.join("\n"))
}

fn build_assistant_message(step: &TrajectoryStep) -> Option<String> {
    if let Some(call) = step
        .llm_calls
        .iter()
        .find(|c| matches!(c.purpose, crate::types::LLMPurpose::Action))
    {
        if !call.response.is_empty() {
            return Some(call.response.clone());
        }
    }

    let action = &step.action;
    let mut parts: Vec<String> = vec![format!("I will {}.", action.action_type)];
    if let Some(reasoning) = &action.reasoning {
        parts.push(format!("Reasoning: {}", reasoning));
    }
    parts.push(format!(
        "Parameters: {}",
        serde_json::to_string(&action.parameters).unwrap_or_default()
    ));
    Some(parts.join("\n"))
}

/// Convert to ART trajectory object.
pub fn to_art_trajectory(trajectory: &Trajectory) -> ARTTrajectory {
    let mut metadata: HashMap<String, JsonValue> = HashMap::new();
    metadata.insert(
        "trajectoryId".to_string(),
        JsonValue::String(trajectory.trajectory_id.clone()),
    );
    metadata.insert(
        "agentId".to_string(),
        JsonValue::String(trajectory.agent_id.clone()),
    );
    if let Some(s) = &trajectory.scenario_id {
        metadata.insert("scenarioId".to_string(), JsonValue::String(s.clone()));
    }
    if let Some(g) = trajectory.group_index {
        metadata.insert(
            "groupIndex".to_string(),
            JsonValue::Number(serde_json::Number::from(g as u64)),
        );
    }
    metadata.insert(
        "metrics".to_string(),
        serde_json::to_value(&trajectory.metrics).unwrap_or(JsonValue::Null),
    );

    ARTTrajectory {
        messages: to_art_messages(trajectory),
        reward: trajectory.total_reward,
        metadata,
        metrics: Some(filter_numeric_metrics(&trajectory.metrics)),
    }
}

fn filter_numeric_metrics(metrics: &crate::types::TrajectoryMetrics) -> HashMap<String, f64> {
    let mut out: HashMap<String, f64> = HashMap::new();
    out.insert("episodeLength".to_string(), metrics.episode_length as f64);
    if let Some(v) = metrics.final_balance {
        out.insert("finalBalance".to_string(), v);
    }
    if let Some(v) = metrics.final_pnl {
        out.insert("finalPnL".to_string(), v);
    }
    if let Some(v) = metrics.success_rate {
        out.insert("successRate".to_string(), v);
    }
    out
}

/// Group trajectories by scenario id for GRPO.
pub fn group_trajectories(trajectories: &[Trajectory], now_ms: i64) -> Vec<TrajectoryGroup> {
    let mut map: HashMap<String, Vec<Trajectory>> = HashMap::new();
    for t in trajectories {
        let scenario = t
            .scenario_id
            .clone()
            .unwrap_or_else(|| "default".to_string());
        map.entry(scenario).or_default().push(t.clone());
    }

    map.into_iter()
        .enumerate()
        .map(|(idx, (scenario_id, trajs))| TrajectoryGroup {
            group_id: format!("group-{}", idx),
            scenario_id,
            shared_prefix: Some(extract_shared_prefix(&trajs)),
            trajectories: trajs,
            rankings: None,
            normalized_rewards: None,
            ruler_scores: None,
            created_at: now_ms,
            model_version: None,
        })
        .collect()
}

/// Extract shared prefix messages across trajectories.
pub fn extract_shared_prefix(trajectories: &[Trajectory]) -> Vec<ChatMessage> {
    if trajectories.is_empty() {
        return Vec::new();
    }

    let all_messages: Vec<Vec<ChatMessage>> = trajectories.iter().map(to_art_messages).collect();
    let first = match all_messages.first() {
        Some(m) => m,
        None => return Vec::new(),
    };

    let mut shared: Vec<ChatMessage> = Vec::new();
    for (i, msg) in first.iter().enumerate() {
        let all_match = all_messages.iter().all(|msgs| msgs.get(i) == Some(msg));
        if all_match {
            shared.push(msg.clone());
        } else {
            break;
        }
    }

    shared
}

/// Remove a shared prefix from messages.
pub fn remove_shared_prefix(
    messages: &[ChatMessage],
    shared_prefix: &[ChatMessage],
) -> Vec<ChatMessage> {
    messages.iter().skip(shared_prefix.len()).cloned().collect()
}

/// Prepare GRPO group for judge (shared prefix + per-trajectory suffixes).
pub fn prepare_for_ruler(
    group: &TrajectoryGroup,
) -> (
    Vec<ChatMessage>,
    Vec<Vec<ChatMessage>>,
    Vec<HashMap<String, JsonValue>>,
) {
    let shared = group
        .shared_prefix
        .clone()
        .unwrap_or_else(|| extract_shared_prefix(&group.trajectories));

    let art_trajs: Vec<ARTTrajectory> = group.trajectories.iter().map(to_art_trajectory).collect();
    let suffixes: Vec<Vec<ChatMessage>> = art_trajs
        .iter()
        .map(|t| remove_shared_prefix(&t.messages, &shared))
        .collect();

    let metadata: Vec<HashMap<String, JsonValue>> =
        art_trajs.into_iter().map(|t| t.metadata).collect();
    (shared, suffixes, metadata)
}

/// Validate trajectory can be converted to ART.
pub fn validate_art_compatibility(trajectory: &Trajectory) -> (bool, Vec<String>, Vec<String>) {
    let mut errors: Vec<String> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();

    if trajectory.steps.is_empty() {
        errors.push("Trajectory has no steps".to_string());
    }

    for (idx, step) in trajectory.steps.iter().enumerate() {
        if step.llm_calls.is_empty() {
            errors.push(format!(
                "Step {} has no LLM calls - can't extract messages",
                idx
            ));
        }
        for call in &step.llm_calls {
            if call.user_prompt.len() < 10 {
                warnings.push(format!("Step {} has very short user prompt", idx));
            }
            if call.response.len() < 5 {
                warnings.push(format!("Step {} has very short response", idx));
            }
        }
    }

    let art = to_art_trajectory(trajectory);
    if art.messages.len() < 2 {
        warnings.push("Trajectory converts to very few messages (< 2)".to_string());
    }

    (errors.is_empty(), errors, warnings)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{
        ActionAttempt, EnvironmentState, LLMCall, LLMPurpose, RewardComponents, Trajectory,
        TrajectoryMetrics,
    };
    use uuid::Uuid;

    #[test]
    fn test_to_art_messages() {
        let now = 1_700_000_000_000i64;
        let t = Trajectory {
            trajectory_id: Uuid::new_v4().to_string(),
            agent_id: Uuid::new_v4().to_string(),
            start_time: now,
            end_time: now,
            duration_ms: 0,
            episode_id: None,
            scenario_id: Some("s1".to_string()),
            batch_id: None,
            group_index: None,
            steps: vec![TrajectoryStep {
                step_id: Uuid::new_v4().to_string(),
                step_number: 0,
                timestamp: now,
                environment_state: EnvironmentState {
                    timestamp: now,
                    agent_balance: 100.0,
                    agent_points: 0.0,
                    agent_pnl: 0.0,
                    open_positions: 0,
                    active_markets: None,
                    portfolio_value: None,
                    unread_messages: None,
                    recent_engagement: None,
                    custom: None,
                },
                observation: HashMap::new(),
                llm_calls: vec![LLMCall {
                    call_id: Uuid::new_v4().to_string(),
                    timestamp: now,
                    model: "test-model".to_string(),
                    model_version: None,
                    system_prompt: "sys".to_string(),
                    user_prompt: "user prompt long enough".to_string(),
                    messages: None,
                    response: "assistant response".to_string(),
                    reasoning: None,
                    temperature: 0.7,
                    max_tokens: 32,
                    top_p: None,
                    prompt_tokens: None,
                    completion_tokens: None,
                    latency_ms: None,
                    purpose: LLMPurpose::Action,
                    action_type: None,
                }],
                provider_accesses: Vec::new(),
                reasoning: None,
                action: ActionAttempt {
                    attempt_id: Uuid::new_v4().to_string(),
                    timestamp: now,
                    action_type: "HOLD".to_string(),
                    action_name: "HOLD".to_string(),
                    parameters: HashMap::new(),
                    reasoning: None,
                    llm_call_id: None,
                    success: true,
                    result: None,
                    error: None,
                    immediate_reward: None,
                },
                reward: 0.5,
                done: true,
                metadata: None,
            }],
            total_reward: 0.5,
            reward_components: RewardComponents {
                environment_reward: 0.5,
                ..Default::default()
            },
            metrics: TrajectoryMetrics {
                episode_length: 1,
                ..Default::default()
            },
            metadata: HashMap::new(),
        };

        let messages = to_art_messages(&t);
        assert!(messages.len() >= 2);
    }
}
