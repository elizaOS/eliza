//! Integration tests for elizaos-plugin-trajectory-logger
//!
//! Tests type construction & serde, ART formatting, service lifecycle,
//! export functionality, and reward scoring.

use elizaos_plugin_trajectory_logger::*;
use std::collections::HashMap;
use uuid::Uuid;

// ===========================================================================
// Helper: build a minimal trajectory for reuse
// ===========================================================================

fn now_ms() -> i64 {
    1_700_000_000_000i64
}

fn make_env_state(balance: f64, pnl: f64) -> EnvironmentState {
    EnvironmentState {
        timestamp: now_ms(),
        agent_balance: balance,
        agent_points: 0.0,
        agent_pnl: pnl,
        open_positions: 0,
        active_markets: None,
        portfolio_value: None,
        unread_messages: None,
        recent_engagement: None,
        custom: None,
    }
}

fn make_llm_call(
    system: &str,
    user: &str,
    response: &str,
    purpose: LLMPurpose,
) -> LLMCall {
    LLMCall {
        call_id: Uuid::new_v4().to_string(),
        timestamp: now_ms(),
        model: "test-model".to_string(),
        model_version: None,
        system_prompt: system.to_string(),
        user_prompt: user.to_string(),
        messages: None,
        response: response.to_string(),
        reasoning: None,
        temperature: 0.7,
        max_tokens: 512,
        top_p: None,
        prompt_tokens: None,
        completion_tokens: None,
        latency_ms: None,
        purpose,
        action_type: None,
    }
}

fn make_action_attempt(action_type: &str, success: bool) -> ActionAttempt {
    ActionAttempt {
        attempt_id: Uuid::new_v4().to_string(),
        timestamp: now_ms(),
        action_type: action_type.to_string(),
        action_name: action_type.to_string(),
        parameters: HashMap::new(),
        reasoning: None,
        llm_call_id: None,
        success,
        result: None,
        error: None,
        immediate_reward: None,
    }
}

fn make_step(
    step_number: u32,
    system: &str,
    user: &str,
    response: &str,
    action_type: &str,
    reward: f64,
    done: bool,
) -> TrajectoryStep {
    TrajectoryStep {
        step_id: Uuid::new_v4().to_string(),
        step_number,
        timestamp: now_ms(),
        environment_state: make_env_state(100.0, 0.0),
        observation: HashMap::new(),
        llm_calls: vec![make_llm_call(system, user, response, LLMPurpose::Action)],
        provider_accesses: Vec::new(),
        reasoning: None,
        action: make_action_attempt(action_type, true),
        reward,
        done,
        metadata: None,
    }
}

fn make_trajectory(
    scenario_id: Option<&str>,
    steps: Vec<TrajectoryStep>,
    total_reward: f64,
) -> Trajectory {
    Trajectory {
        trajectory_id: Uuid::new_v4().to_string(),
        agent_id: Uuid::new_v4().to_string(),
        start_time: now_ms(),
        end_time: now_ms() + 10_000,
        duration_ms: 10_000,
        episode_id: None,
        scenario_id: scenario_id.map(String::from),
        batch_id: None,
        group_index: None,
        steps,
        total_reward,
        reward_components: RewardComponents {
            environment_reward: total_reward,
            ..Default::default()
        },
        metrics: TrajectoryMetrics {
            episode_length: 1,
            final_status: FinalStatus::Completed,
            ..Default::default()
        },
        metadata: HashMap::new(),
    }
}

fn make_simple_trajectory(scenario: Option<&str>, response: &str) -> Trajectory {
    let step = make_step(
        0,
        "You are a trading agent.",
        "BTC at 50%. Trade?",
        response,
        "HOLD",
        0.5,
        true,
    );
    make_trajectory(scenario, vec![step], 0.5)
}

// ===========================================================================
// Type construction & serde
// ===========================================================================

#[cfg(test)]
mod type_tests {
    use super::*;

    #[test]
    fn llm_purpose_default() {
        let p: LLMPurpose = Default::default();
        assert_eq!(p, LLMPurpose::Other);
    }

    #[test]
    fn llm_purpose_serde() {
        for (purpose, expected_str) in [
            (LLMPurpose::Action, "\"action\""),
            (LLMPurpose::Reasoning, "\"reasoning\""),
            (LLMPurpose::Evaluation, "\"evaluation\""),
            (LLMPurpose::Response, "\"response\""),
            (LLMPurpose::Other, "\"other\""),
        ] {
            let json = serde_json::to_string(&purpose).unwrap();
            assert_eq!(json, expected_str);
            let back: LLMPurpose = serde_json::from_str(&json).unwrap();
            assert_eq!(back, purpose);
        }
    }

    #[test]
    fn llm_message_construction() {
        let msg = LLMMessage {
            role: "user".to_string(),
            content: "hello".to_string(),
        };
        assert_eq!(msg.role, "user");
        assert_eq!(msg.content, "hello");
    }

    #[test]
    fn llm_message_serde() {
        let msg = LLMMessage {
            role: "assistant".to_string(),
            content: "world".to_string(),
        };
        let json = serde_json::to_string(&msg).unwrap();
        let back: LLMMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(back, msg);
    }

    #[test]
    fn llm_call_construction() {
        let call = make_llm_call("sys", "user prompt here", "response here", LLMPurpose::Action);
        assert_eq!(call.model, "test-model");
        assert_eq!(call.purpose, LLMPurpose::Action);
        assert_eq!(call.temperature, 0.7);
    }

    #[test]
    fn llm_call_serde_roundtrip() {
        let call = make_llm_call("sys", "user prompt here", "response here", LLMPurpose::Reasoning);
        let json = serde_json::to_string(&call).unwrap();
        let back: LLMCall = serde_json::from_str(&json).unwrap();
        assert_eq!(back.model, "test-model");
        assert_eq!(back.purpose, LLMPurpose::Reasoning);
    }

    #[test]
    fn environment_state_construction() {
        let env = make_env_state(1000.0, 50.0);
        assert_eq!(env.agent_balance, 1000.0);
        assert_eq!(env.agent_pnl, 50.0);
        assert_eq!(env.open_positions, 0);
    }

    #[test]
    fn environment_state_serde() {
        let env = make_env_state(500.0, -10.0);
        let json = serde_json::to_string(&env).unwrap();
        let back: EnvironmentState = serde_json::from_str(&json).unwrap();
        assert_eq!(back.agent_balance, 500.0);
        assert_eq!(back.agent_pnl, -10.0);
    }

    #[test]
    fn action_attempt_construction() {
        let action = make_action_attempt("BUY", true);
        assert_eq!(action.action_type, "BUY");
        assert!(action.success);
        assert!(action.error.is_none());
    }

    #[test]
    fn action_attempt_with_failure() {
        let mut action = make_action_attempt("SELL", false);
        action.error = Some("Insufficient balance".to_string());
        assert!(!action.success);
        assert_eq!(action.error.as_deref(), Some("Insufficient balance"));
    }

    #[test]
    fn trajectory_step_construction() {
        let step = make_step(0, "sys", "user prompt here", "response here", "HOLD", 0.5, true);
        assert_eq!(step.step_number, 0);
        assert_eq!(step.reward, 0.5);
        assert!(step.done);
        assert_eq!(step.llm_calls.len(), 1);
    }

    #[test]
    fn trajectory_construction() {
        let t = make_simple_trajectory(Some("s1"), "I will hold.");
        assert!(!t.trajectory_id.is_empty());
        assert!(!t.agent_id.is_empty());
        assert_eq!(t.steps.len(), 1);
        assert_eq!(t.total_reward, 0.5);
        assert_eq!(t.scenario_id.as_deref(), Some("s1"));
    }

    #[test]
    fn trajectory_default() {
        let t = Trajectory::default();
        assert!(t.trajectory_id.is_empty());
        assert!(t.steps.is_empty());
        assert_eq!(t.total_reward, 0.0);
    }

    #[test]
    fn trajectory_serde_roundtrip() {
        let t = make_simple_trajectory(Some("s1"), "I will hold.");
        let json = serde_json::to_string(&t).unwrap();
        let back: Trajectory = serde_json::from_str(&json).unwrap();
        assert_eq!(back.trajectory_id, t.trajectory_id);
        assert_eq!(back.steps.len(), 1);
        assert_eq!(back.total_reward, 0.5);
    }

    #[test]
    fn trajectory_metadata_construction() {
        let mut t = make_simple_trajectory(None, "hold");
        t.metadata.insert(
            "agentName".to_string(),
            serde_json::Value::String("TestBot".to_string()),
        );
        assert_eq!(
            t.metadata.get("agentName").unwrap().as_str(),
            Some("TestBot")
        );
    }

    #[test]
    fn final_status_serde() {
        for (status, expected) in [
            (FinalStatus::Completed, "\"completed\""),
            (FinalStatus::Terminated, "\"terminated\""),
            (FinalStatus::Error, "\"error\""),
            (FinalStatus::Timeout, "\"timeout\""),
        ] {
            let json = serde_json::to_string(&status).unwrap();
            assert_eq!(json, expected);
            let back: FinalStatus = serde_json::from_str(&json).unwrap();
            assert_eq!(back, status);
        }
    }

    #[test]
    fn final_status_default() {
        let s: FinalStatus = Default::default();
        assert_eq!(s, FinalStatus::Completed);
    }

    #[test]
    fn reward_components_default() {
        let rc = RewardComponents::default();
        assert_eq!(rc.environment_reward, 0.0);
        assert!(rc.ai_judge_reward.is_none());
        assert!(rc.components.is_none());
    }

    #[test]
    fn trajectory_metrics_default() {
        let m = TrajectoryMetrics::default();
        assert_eq!(m.episode_length, 0);
        assert_eq!(m.final_status, FinalStatus::Completed);
        assert!(m.final_balance.is_none());
    }

    #[test]
    fn trajectory_metrics_extra() {
        let mut m = TrajectoryMetrics::default();
        m.extra.insert(
            "customMetric".to_string(),
            serde_json::json!(42.0),
        );
        let json = serde_json::to_string(&m).unwrap();
        assert!(json.contains("customMetric"));
        let back: TrajectoryMetrics = serde_json::from_str(&json).unwrap();
        assert!(back.extra.contains_key("customMetric"));
    }

    #[test]
    fn chat_message_equality() {
        let a = ChatMessage {
            role: "user".to_string(),
            content: "hello".to_string(),
            name: None,
        };
        let b = ChatMessage {
            role: "user".to_string(),
            content: "hello".to_string(),
            name: None,
        };
        assert_eq!(a, b);
    }

    #[test]
    fn chat_message_inequality() {
        let a = ChatMessage {
            role: "user".to_string(),
            content: "hello".to_string(),
            name: None,
        };
        let b = ChatMessage {
            role: "assistant".to_string(),
            content: "hello".to_string(),
            name: None,
        };
        assert_ne!(a, b);
    }

    #[test]
    fn art_trajectory_construction() {
        let art = ARTTrajectory {
            messages: vec![ChatMessage {
                role: "system".to_string(),
                content: "You are an agent.".to_string(),
                name: None,
            }],
            reward: 0.8,
            metadata: HashMap::new(),
            metrics: Some(HashMap::from([("episodeLength".to_string(), 1.0)])),
        };
        assert_eq!(art.messages.len(), 1);
        assert_eq!(art.reward, 0.8);
    }

    #[test]
    fn trajectory_group_construction() {
        let group = TrajectoryGroup {
            group_id: "group-0".to_string(),
            scenario_id: "s1".to_string(),
            trajectories: vec![make_simple_trajectory(Some("s1"), "A")],
            shared_prefix: None,
            rankings: None,
            normalized_rewards: None,
            ruler_scores: None,
            created_at: now_ms(),
            model_version: None,
        };
        assert_eq!(group.trajectories.len(), 1);
        assert_eq!(group.scenario_id, "s1");
    }

    #[test]
    fn provider_access_construction() {
        let pa = ProviderAccess {
            provider_id: "p1".to_string(),
            provider_name: "MarketData".to_string(),
            timestamp: now_ms(),
            query: None,
            data: HashMap::from([("price".to_string(), serde_json::json!(50000.0))]),
            purpose: "market_check".to_string(),
        };
        assert_eq!(pa.provider_name, "MarketData");
        assert!(pa.data.contains_key("price"));
    }
}

// ===========================================================================
// ART format
// ===========================================================================

#[cfg(test)]
mod art_format_tests {
    use super::*;

    #[test]
    fn to_art_messages_produces_system_user_assistant() {
        let t = make_simple_trajectory(None, "I will hold.");
        let msgs = to_art_messages(&t);

        // Should have at least: system, user, assistant
        assert!(msgs.len() >= 3);
        assert_eq!(msgs[0].role, "system");
        assert_eq!(msgs[1].role, "user");
        assert_eq!(msgs[2].role, "assistant");
    }

    #[test]
    fn to_art_messages_system_from_first_llm_call() {
        let t = make_simple_trajectory(None, "response");
        let msgs = to_art_messages(&t);
        // System prompt comes from first LLM call's system_prompt
        assert_eq!(msgs[0].content, "You are a trading agent.");
    }

    #[test]
    fn to_art_messages_fallback_system_from_metadata() {
        // Trajectory with no LLM calls in step
        let mut t = make_simple_trajectory(None, "");
        t.steps[0].llm_calls.clear();
        t.metadata.insert(
            "agentName".to_string(),
            serde_json::json!("TradingBot"),
        );
        t.metadata.insert(
            "goalDescription".to_string(),
            serde_json::json!("maximize profit"),
        );
        let msgs = to_art_messages(&t);
        assert!(!msgs.is_empty());
        assert_eq!(msgs[0].role, "system");
        assert!(msgs[0].content.contains("TradingBot"));
        assert!(msgs[0].content.contains("maximize profit"));
    }

    #[test]
    fn to_art_messages_user_from_llm_prompt() {
        let t = make_simple_trajectory(None, "I will hold.");
        let msgs = to_art_messages(&t);
        // The user message should come from the LLM call's user_prompt
        assert_eq!(msgs[1].content, "BTC at 50%. Trade?");
    }

    #[test]
    fn to_art_messages_assistant_from_llm_response() {
        let t = make_simple_trajectory(None, "I will hold.");
        let msgs = to_art_messages(&t);
        assert_eq!(msgs[2].content, "I will hold.");
    }

    #[test]
    fn to_art_trajectory_preserves_reward() {
        let t = make_simple_trajectory(Some("s1"), "hold");
        let art = to_art_trajectory(&t);
        assert_eq!(art.reward, 0.5);
    }

    #[test]
    fn to_art_trajectory_has_metadata() {
        let t = make_simple_trajectory(Some("s1"), "hold");
        let art = to_art_trajectory(&t);
        assert!(art.metadata.contains_key("trajectoryId"));
        assert!(art.metadata.contains_key("agentId"));
        assert!(art.metadata.contains_key("scenarioId"));
    }

    #[test]
    fn to_art_trajectory_has_numeric_metrics() {
        let mut t = make_simple_trajectory(None, "hold");
        t.metrics.final_balance = Some(1050.0);
        t.metrics.final_pnl = Some(50.0);
        t.metrics.success_rate = Some(0.8);
        let art = to_art_trajectory(&t);
        let metrics = art.metrics.unwrap();
        assert_eq!(metrics["episodeLength"], 1.0);
        assert_eq!(metrics["finalBalance"], 1050.0);
        assert_eq!(metrics["finalPnL"], 50.0);
        assert_eq!(metrics["successRate"], 0.8);
    }

    #[test]
    fn group_trajectories_by_scenario() {
        let t1 = make_simple_trajectory(Some("s1"), "A");
        let t2 = make_simple_trajectory(Some("s1"), "B");
        let t3 = make_simple_trajectory(Some("s2"), "C");

        let groups = group_trajectories(&[t1, t2, t3], now_ms());
        assert_eq!(groups.len(), 2);

        let s1_group = groups.iter().find(|g| g.scenario_id == "s1");
        assert!(s1_group.is_some());
        assert_eq!(s1_group.unwrap().trajectories.len(), 2);

        let s2_group = groups.iter().find(|g| g.scenario_id == "s2");
        assert!(s2_group.is_some());
        assert_eq!(s2_group.unwrap().trajectories.len(), 1);
    }

    #[test]
    fn group_trajectories_default_scenario() {
        let t1 = make_simple_trajectory(None, "A");
        let t2 = make_simple_trajectory(None, "B");

        let groups = group_trajectories(&[t1, t2], now_ms());
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].scenario_id, "default");
        assert_eq!(groups[0].trajectories.len(), 2);
    }

    #[test]
    fn group_trajectories_has_shared_prefix() {
        let t1 = make_simple_trajectory(Some("s1"), "A");
        let t2 = make_simple_trajectory(Some("s1"), "B");

        let groups = group_trajectories(&[t1, t2], now_ms());
        let group = &groups[0];
        assert!(group.shared_prefix.is_some());
        let prefix = group.shared_prefix.as_ref().unwrap();
        // At minimum, the system message should be shared
        assert!(!prefix.is_empty());
    }

    #[test]
    fn extract_shared_prefix_empty_input() {
        let prefix = extract_shared_prefix(&[]);
        assert!(prefix.is_empty());
    }

    #[test]
    fn extract_shared_prefix_single_trajectory() {
        let t = make_simple_trajectory(None, "hold");
        let prefix = extract_shared_prefix(&[t.clone()]);
        let all_msgs = to_art_messages(&t);
        // With a single trajectory, prefix equals all messages
        assert_eq!(prefix.len(), all_msgs.len());
    }

    #[test]
    fn extract_shared_prefix_same_system_different_response() {
        let t1 = make_simple_trajectory(Some("s1"), "buy");
        let t2 = make_simple_trajectory(Some("s1"), "sell");

        let prefix = extract_shared_prefix(&[t1, t2]);
        // System message should be shared; user prompt should be shared;
        // assistant response differs -> prefix = system + user
        assert!(prefix.len() >= 2);
        assert_eq!(prefix[0].role, "system");
        assert_eq!(prefix[1].role, "user");
    }

    #[test]
    fn remove_shared_prefix_works() {
        let msgs = vec![
            ChatMessage {
                role: "system".to_string(),
                content: "sys".to_string(),
                name: None,
            },
            ChatMessage {
                role: "user".to_string(),
                content: "user".to_string(),
                name: None,
            },
            ChatMessage {
                role: "assistant".to_string(),
                content: "asst".to_string(),
                name: None,
            },
        ];
        let prefix = &msgs[..2];
        let suffix = remove_shared_prefix(&msgs, prefix);
        assert_eq!(suffix.len(), 1);
        assert_eq!(suffix[0].role, "assistant");
    }

    #[test]
    fn prepare_for_ruler_splits_correctly() {
        let t1 = make_simple_trajectory(Some("s1"), "buy");
        let t2 = make_simple_trajectory(Some("s1"), "sell");

        let groups = group_trajectories(&[t1, t2], now_ms());
        let group = &groups[0];
        let (shared, suffixes, metadata) = prepare_for_ruler(group);

        assert!(!shared.is_empty());
        assert_eq!(suffixes.len(), 2);
        assert_eq!(metadata.len(), 2);
    }

    #[test]
    fn validate_art_compatibility_valid() {
        let t = make_simple_trajectory(None, "I will hold.");
        let (valid, errors, _warnings) = validate_art_compatibility(&t);
        assert!(valid);
        assert!(errors.is_empty());
    }

    #[test]
    fn validate_art_compatibility_no_steps() {
        let t = make_trajectory(None, vec![], 0.0);
        let (valid, errors, _warnings) = validate_art_compatibility(&t);
        assert!(!valid);
        assert!(errors.iter().any(|e| e.contains("no steps")));
    }

    #[test]
    fn validate_art_compatibility_no_llm_calls() {
        let mut t = make_simple_trajectory(None, "hold");
        t.steps[0].llm_calls.clear();
        let (valid, errors, _warnings) = validate_art_compatibility(&t);
        assert!(!valid);
        assert!(errors.iter().any(|e| e.contains("no LLM calls")));
    }

    #[test]
    fn validate_art_compatibility_short_prompts_warn() {
        let step = make_step(0, "sys", "short", "ok", "HOLD", 0.0, true);
        let t = make_trajectory(None, vec![step], 0.0);
        let (_valid, _errors, warnings) = validate_art_compatibility(&t);
        assert!(warnings.iter().any(|w| w.contains("short")));
    }
}

// ===========================================================================
// Service lifecycle
// ===========================================================================

#[cfg(test)]
mod service_tests {
    use super::*;

    #[test]
    fn service_creation() {
        let svc = TrajectoryLoggerService::new();
        // No active trajectories at start
        assert!(svc.get_active_trajectory("nonexistent").is_none());
    }

    #[test]
    fn start_trajectory_returns_id() {
        let mut svc = TrajectoryLoggerService::new();
        let traj_id = svc.start_trajectory(
            "agent-1",
            now_ms(),
            StartTrajectoryOptions::default(),
        );
        assert!(!traj_id.is_empty());
        let traj = svc.get_active_trajectory(&traj_id).unwrap();
        assert_eq!(traj.agent_id, "agent-1");
        assert!(traj.steps.is_empty());
    }

    #[test]
    fn start_trajectory_with_options() {
        let mut svc = TrajectoryLoggerService::new();
        let opts = StartTrajectoryOptions {
            scenario_id: Some("s1".to_string()),
            episode_id: Some("ep1".to_string()),
            batch_id: Some("batch1".to_string()),
            group_index: Some(0),
            metadata: Some(HashMap::from([(
                "key".to_string(),
                serde_json::json!("value"),
            )])),
        };
        let traj_id = svc.start_trajectory("agent-1", now_ms(), opts);
        let traj = svc.get_active_trajectory(&traj_id).unwrap();
        assert_eq!(traj.scenario_id.as_deref(), Some("s1"));
        assert_eq!(traj.episode_id.as_deref(), Some("ep1"));
        assert_eq!(traj.batch_id.as_deref(), Some("batch1"));
        assert_eq!(traj.group_index, Some(0));
        assert!(traj.metadata.contains_key("key"));
    }

    #[test]
    fn start_step_returns_id() {
        let mut svc = TrajectoryLoggerService::new();
        let traj_id = svc.start_trajectory("agent-1", now_ms(), Default::default());
        let step_id = svc.start_step(&traj_id, make_env_state(100.0, 0.0), now_ms());
        assert!(!step_id.is_empty());

        let traj = svc.get_active_trajectory(&traj_id).unwrap();
        assert_eq!(traj.steps.len(), 1);
        assert_eq!(traj.steps[0].step_number, 0);
    }

    #[test]
    fn start_multiple_steps_increments_number() {
        let mut svc = TrajectoryLoggerService::new();
        let traj_id = svc.start_trajectory("agent-1", now_ms(), Default::default());

        let step1 = svc.start_step(&traj_id, make_env_state(100.0, 0.0), now_ms());
        svc.complete_step(
            &traj_id,
            &step1,
            make_action_attempt("HOLD", true),
            Some(0.1),
            None,
        );

        let step2 = svc.start_step(&traj_id, make_env_state(100.0, 0.1), now_ms());
        svc.complete_step(
            &traj_id,
            &step2,
            make_action_attempt("BUY", true),
            Some(0.2),
            None,
        );

        let traj = svc.get_active_trajectory(&traj_id).unwrap();
        assert_eq!(traj.steps.len(), 2);
        assert_eq!(traj.steps[0].step_number, 0);
        assert_eq!(traj.steps[1].step_number, 1);
    }

    #[test]
    fn get_current_step_id() {
        let mut svc = TrajectoryLoggerService::new();
        let traj_id = svc.start_trajectory("agent-1", now_ms(), Default::default());

        assert!(svc.get_current_step_id(&traj_id).is_none());

        let step_id = svc.start_step(&traj_id, make_env_state(100.0, 0.0), now_ms());
        assert_eq!(svc.get_current_step_id(&traj_id), Some(step_id.clone()));

        svc.complete_step(
            &traj_id,
            &step_id,
            make_action_attempt("HOLD", true),
            None,
            None,
        );
        assert!(svc.get_current_step_id(&traj_id).is_none());
    }

    #[test]
    fn log_llm_call_into_step() {
        let mut svc = TrajectoryLoggerService::new();
        let traj_id = svc.start_trajectory("agent-1", now_ms(), Default::default());
        let step_id = svc.start_step(&traj_id, make_env_state(100.0, 0.0), now_ms());

        svc.log_llm_call(
            &step_id,
            make_llm_call("sys", "user", "response", LLMPurpose::Action),
        );

        let traj = svc.get_active_trajectory(&traj_id).unwrap();
        assert_eq!(traj.steps[0].llm_calls.len(), 1);
        assert_eq!(traj.steps[0].llm_calls[0].purpose, LLMPurpose::Action);
    }

    #[test]
    fn log_llm_call_by_trajectory_id() {
        let mut svc = TrajectoryLoggerService::new();
        let traj_id = svc.start_trajectory("agent-1", now_ms(), Default::default());
        let _step_id = svc.start_step(&traj_id, make_env_state(100.0, 0.0), now_ms());

        svc.log_llm_call_by_trajectory_id(
            &traj_id,
            make_llm_call("sys", "user", "response", LLMPurpose::Reasoning),
        );

        let traj = svc.get_active_trajectory(&traj_id).unwrap();
        assert_eq!(traj.steps[0].llm_calls.len(), 1);
    }

    #[test]
    fn log_provider_access_into_step() {
        let mut svc = TrajectoryLoggerService::new();
        let traj_id = svc.start_trajectory("agent-1", now_ms(), Default::default());
        let step_id = svc.start_step(&traj_id, make_env_state(100.0, 0.0), now_ms());

        svc.log_provider_access(
            &step_id,
            ProviderAccess {
                provider_id: "p1".to_string(),
                provider_name: "MarketData".to_string(),
                timestamp: now_ms(),
                query: None,
                data: HashMap::from([("price".to_string(), serde_json::json!(50000))]),
                purpose: "market_check".to_string(),
            },
        );

        let traj = svc.get_active_trajectory(&traj_id).unwrap();
        assert_eq!(traj.steps[0].provider_accesses.len(), 1);
        assert_eq!(traj.steps[0].provider_accesses[0].provider_name, "MarketData");
    }

    #[test]
    fn log_provider_access_by_trajectory_id() {
        let mut svc = TrajectoryLoggerService::new();
        let traj_id = svc.start_trajectory("agent-1", now_ms(), Default::default());
        let _step_id = svc.start_step(&traj_id, make_env_state(100.0, 0.0), now_ms());

        svc.log_provider_access_by_trajectory_id(
            &traj_id,
            ProviderAccess {
                provider_id: "p1".to_string(),
                provider_name: "Data".to_string(),
                timestamp: now_ms(),
                query: None,
                data: HashMap::new(),
                purpose: "test".to_string(),
            },
        );

        let traj = svc.get_active_trajectory(&traj_id).unwrap();
        assert_eq!(traj.steps[0].provider_accesses.len(), 1);
    }

    #[test]
    fn complete_step_updates_action_and_reward() {
        let mut svc = TrajectoryLoggerService::new();
        let traj_id = svc.start_trajectory("agent-1", now_ms(), Default::default());
        let step_id = svc.start_step(&traj_id, make_env_state(100.0, 0.0), now_ms());

        svc.complete_step(
            &traj_id,
            &step_id,
            make_action_attempt("BUY", true),
            Some(0.3),
            None,
        );

        let traj = svc.get_active_trajectory(&traj_id).unwrap();
        assert_eq!(traj.steps[0].action.action_type, "BUY");
        assert_eq!(traj.steps[0].reward, 0.3);
        assert_eq!(traj.total_reward, 0.3);
    }

    #[test]
    fn complete_step_accumulates_total_reward() {
        let mut svc = TrajectoryLoggerService::new();
        let traj_id = svc.start_trajectory("agent-1", now_ms(), Default::default());

        let s1 = svc.start_step(&traj_id, make_env_state(100.0, 0.0), now_ms());
        svc.complete_step(&traj_id, &s1, make_action_attempt("HOLD", true), Some(0.1), None);

        let s2 = svc.start_step(&traj_id, make_env_state(100.0, 0.0), now_ms());
        svc.complete_step(&traj_id, &s2, make_action_attempt("BUY", true), Some(0.2), None);

        let traj = svc.get_active_trajectory(&traj_id).unwrap();
        assert!((traj.total_reward - 0.3).abs() < 1e-10);
    }

    #[test]
    fn end_trajectory_finalizes_metrics() {
        let mut svc = TrajectoryLoggerService::new();
        let start = now_ms();
        let traj_id = svc.start_trajectory("agent-1", start, Default::default());
        let step_id = svc.start_step(&traj_id, make_env_state(100.0, 0.0), start);

        svc.log_llm_call(
            &step_id,
            make_llm_call("sys", "user", "response", LLMPurpose::Action),
        );
        svc.complete_step(
            &traj_id,
            &step_id,
            make_action_attempt("HOLD", true),
            Some(0.5),
            None,
        );

        let end = start + 5000;
        svc.end_trajectory(&traj_id, FinalStatus::Completed, end, None);

        let traj = svc.get_active_trajectory(&traj_id).unwrap();
        assert_eq!(traj.end_time, end);
        assert_eq!(traj.duration_ms, 5000);
        assert_eq!(traj.metrics.episode_length, 1);
        assert_eq!(traj.metrics.final_status, FinalStatus::Completed);
    }

    #[test]
    fn end_trajectory_with_final_metrics() {
        let mut svc = TrajectoryLoggerService::new();
        let traj_id = svc.start_trajectory("agent-1", now_ms(), Default::default());
        let step_id = svc.start_step(&traj_id, make_env_state(100.0, 0.0), now_ms());
        svc.complete_step(&traj_id, &step_id, make_action_attempt("HOLD", true), None, None);

        let mut extras = HashMap::new();
        extras.insert("customKey".to_string(), serde_json::json!("customValue"));
        svc.end_trajectory(&traj_id, FinalStatus::Terminated, now_ms() + 1000, Some(extras));

        let traj = svc.get_active_trajectory(&traj_id).unwrap();
        assert_eq!(traj.metrics.final_status, FinalStatus::Terminated);
        assert!(traj.metrics.extra.contains_key("customKey"));
    }

    #[test]
    fn full_lifecycle() {
        let mut svc = TrajectoryLoggerService::new();
        let start = now_ms();

        // Start trajectory
        let traj_id = svc.start_trajectory(
            "agent-1",
            start,
            StartTrajectoryOptions {
                scenario_id: Some("test-scenario".to_string()),
                ..Default::default()
            },
        );

        // Step 1
        let step1 = svc.start_step(&traj_id, make_env_state(1000.0, 0.0), start);
        svc.log_llm_call(
            &step1,
            make_llm_call("system", "What should I do?", "Buy BTC", LLMPurpose::Action),
        );
        svc.complete_step(
            &traj_id,
            &step1,
            make_action_attempt("BUY", true),
            Some(0.3),
            None,
        );

        // Step 2
        let step2 = svc.start_step(&traj_id, make_env_state(1050.0, 50.0), start + 1000);
        svc.log_llm_call(
            &step2,
            make_llm_call("system", "Position up. What now?", "Hold position", LLMPurpose::Action),
        );
        svc.complete_step(
            &traj_id,
            &step2,
            make_action_attempt("HOLD", true),
            Some(0.2),
            None,
        );

        // End trajectory
        svc.end_trajectory(&traj_id, FinalStatus::Completed, start + 2000, None);

        let traj = svc.get_active_trajectory(&traj_id).unwrap();
        assert_eq!(traj.steps.len(), 2);
        assert_eq!(traj.metrics.episode_length, 2);
        assert!((traj.total_reward - 0.5).abs() < 1e-10);
        assert_eq!(traj.duration_ms, 2000);

        // Verify ART conversion works on the result
        let art = to_art_trajectory(traj);
        assert!(art.messages.len() >= 3); // system + at least 2 user/assistant pairs
        assert_eq!(art.reward, 0.5);
    }
}

// ===========================================================================
// Export functionality
// ===========================================================================

#[cfg(test)]
mod export_tests {
    use super::*;

    #[test]
    fn export_art_jsonl_writes_file() {
        let t = make_simple_trajectory(Some("s1"), "hold");
        let tmpdir = tempfile::tempdir().unwrap();
        let out_path = tmpdir.path().join("test.art.jsonl");

        let result = export_for_openpipe_art("test", &[t], Some(&out_path));
        assert!(result.is_ok());
        let path = result.unwrap();
        assert!(std::path::Path::new(&path).exists());

        let content = std::fs::read_to_string(&path).unwrap();
        let lines: Vec<&str> = content.trim().split('\n').collect();
        assert_eq!(lines.len(), 1);

        // Verify it's valid JSON
        let parsed: serde_json::Value = serde_json::from_str(lines[0]).unwrap();
        assert!(parsed.get("messages").is_some());
        assert!(parsed.get("reward").is_some());
    }

    #[test]
    fn export_art_jsonl_multiple_trajectories() {
        let t1 = make_simple_trajectory(Some("s1"), "A");
        let t2 = make_simple_trajectory(Some("s1"), "B");
        let tmpdir = tempfile::tempdir().unwrap();
        let out_path = tmpdir.path().join("multi.art.jsonl");

        let result = export_for_openpipe_art("multi", &[t1, t2], Some(&out_path));
        assert!(result.is_ok());

        let content = std::fs::read_to_string(result.unwrap()).unwrap();
        let lines: Vec<&str> = content.trim().split('\n').collect();
        assert_eq!(lines.len(), 2);
    }

    #[test]
    fn export_grpo_groups_writes_file() {
        let t1 = make_simple_trajectory(Some("s1"), "A");
        let t2 = make_simple_trajectory(Some("s1"), "B");
        let t3 = make_simple_trajectory(Some("s2"), "C");
        let tmpdir = tempfile::tempdir().unwrap();
        let out_path = tmpdir.path().join("test.grpo.json");

        let result =
            export_grouped_for_grpo("test", &[t1, t2, t3], now_ms(), Some(&out_path));
        assert!(result.is_ok());
        let path = result.unwrap();
        assert!(std::path::Path::new(&path).exists());

        let content = std::fs::read_to_string(&path).unwrap();
        let parsed: Vec<serde_json::Value> = serde_json::from_str(&content).unwrap();
        assert_eq!(parsed.len(), 2); // Two scenario groups
    }

    #[test]
    fn export_art_default_path() {
        let t = make_simple_trajectory(None, "hold");
        // Use None path to trigger default naming
        let result = export_for_openpipe_art::<std::path::PathBuf>("my-dataset", &[t], None);
        assert!(result.is_ok());
        let path = result.unwrap();
        assert!(path.contains("my-dataset"));
        assert!(path.ends_with(".art.jsonl"));
        // Cleanup
        let _ = std::fs::remove_file(&path);
    }
}

// ===========================================================================
// Reward service
// ===========================================================================

#[cfg(test)]
mod reward_tests {
    use super::*;

    #[test]
    fn reward_service_creation() {
        let svc = RewardService::new();
        // Just verify it can be created (unit struct)
        let _ = format!("{:?}", svc);
    }

    #[test]
    fn score_trajectory_completed_positive_pnl() {
        let svc = RewardService::new();
        let mut t = Trajectory::default();
        t.metrics = TrajectoryMetrics {
            episode_length: 5,
            final_status: FinalStatus::Completed,
            final_pnl: Some(100.0),
            success_rate: Some(0.8),
            ..Default::default()
        };
        t.reward_components = RewardComponents {
            environment_reward: 0.3,
            ..Default::default()
        };

        let score = svc.score_trajectory(&t);
        assert!(score > 0.0, "Positive PnL + completed should score > 0, got {}", score);
        assert!(score <= 1.0);
        assert!(score >= -1.0);
    }

    #[test]
    fn score_trajectory_error_negative_pnl() {
        let svc = RewardService::new();
        let mut t = Trajectory::default();
        t.metrics = TrajectoryMetrics {
            episode_length: 2,
            final_status: FinalStatus::Error,
            final_pnl: Some(-200.0),
            success_rate: Some(0.2),
            ..Default::default()
        };
        t.reward_components = RewardComponents {
            environment_reward: -0.5,
            ..Default::default()
        };

        let score = svc.score_trajectory(&t);
        assert!(score < 0.0, "Negative PnL + error should score < 0, got {}", score);
    }

    #[test]
    fn score_trajectory_clamped_to_range() {
        let svc = RewardService::new();
        let t = Trajectory::default();
        let score = svc.score_trajectory(&t);
        assert!(score >= -1.0);
        assert!(score <= 1.0);
    }

    #[test]
    fn score_trajectory_group_empty() {
        let svc = RewardService::new();
        let scores = svc.score_trajectory_group(&[]);
        assert!(scores.is_empty());
    }

    #[test]
    fn score_trajectory_group_single() {
        let svc = RewardService::new();
        let mut t = Trajectory::default();
        t.metrics.final_status = FinalStatus::Completed;
        t.metrics.final_pnl = Some(50.0);

        let scores = svc.score_trajectory_group(&[t]);
        assert_eq!(scores.len(), 1);
        assert!(scores[0] >= 0.0 && scores[0] <= 1.0);
    }

    #[test]
    fn score_trajectory_group_normalized() {
        let svc = RewardService::new();

        let mut t1 = Trajectory::default();
        t1.metrics = TrajectoryMetrics {
            episode_length: 1,
            final_status: FinalStatus::Completed,
            final_pnl: Some(100.0),
            ..Default::default()
        };
        t1.reward_components = RewardComponents {
            environment_reward: 0.2,
            ..Default::default()
        };

        let mut t2 = t1.clone();
        t2.metrics.final_pnl = Some(-50.0);

        let scores = svc.score_trajectory_group(&[t1, t2]);
        assert_eq!(scores.len(), 2);
        // All normalized to [0, 1]
        for s in &scores {
            assert!(*s >= 0.0 && *s <= 1.0, "Score {} not in [0,1]", s);
        }
        // Better trajectory should score higher
        assert!(scores[0] > scores[1]);
    }

    #[test]
    fn score_trajectory_group_equal_scores() {
        let svc = RewardService::new();
        let mut t1 = Trajectory::default();
        t1.metrics.final_status = FinalStatus::Completed;

        let t2 = t1.clone();

        let scores = svc.score_trajectory_group(&[t1, t2]);
        assert_eq!(scores.len(), 2);
        // Equal trajectories -> all get 0.5
        assert_eq!(scores[0], 0.5);
        assert_eq!(scores[1], 0.5);
    }

    #[test]
    fn compute_heuristic_reward_directly() {
        let mut t = Trajectory::default();
        t.metrics = TrajectoryMetrics {
            episode_length: 10,
            final_status: FinalStatus::Completed,
            final_pnl: Some(50.0),
            success_rate: Some(0.9),
            ..Default::default()
        };
        t.reward_components = RewardComponents {
            environment_reward: 0.5,
            ..Default::default()
        };

        let reward = compute_heuristic_reward(&t);
        assert!(reward > 0.0);
        assert!(reward <= 1.0);
    }
}
