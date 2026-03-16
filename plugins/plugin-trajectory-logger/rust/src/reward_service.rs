use crate::types::Trajectory;

/// Heuristic reward scoring service.
#[derive(Debug, Default)]
pub struct RewardService;

impl RewardService {
    /// Creates a new reward scoring service instance.
    pub fn new() -> Self {
        Self
    }

    /// Score a single trajectory (returns -1..1).
    pub fn score_trajectory(&self, trajectory: &Trajectory) -> f64 {
        compute_heuristic_reward(trajectory)
    }

    /// Score a group of trajectories and normalize to 0..1.
    pub fn score_trajectory_group(&self, trajectories: &[Trajectory]) -> Vec<f64> {
        if trajectories.is_empty() {
            return Vec::new();
        }
        if trajectories.len() == 1 {
            return vec![normalize_score(self.score_trajectory(&trajectories[0]))];
        }

        let raw: Vec<f64> = trajectories
            .iter()
            .map(|t| self.score_trajectory(t))
            .collect();
        normalize_scores_for_group(&raw)
    }
}

/// Compute a heuristic reward using observable metrics.
pub fn compute_heuristic_reward(trajectory: &Trajectory) -> f64 {
    let metrics = &trajectory.metrics;
    let components = &trajectory.reward_components;

    let mut reward = 0.0;
    let mut weight_sum = 0.0;

    // P&L (0.4)
    if let Some(pnl) = metrics.final_pnl {
        reward += normalize_pnl(pnl) * 0.4;
        weight_sum += 0.4;
    }

    // Success rate (0.3)
    if let Some(sr) = metrics.success_rate {
        reward += (sr * 2.0 - 1.0) * 0.3;
        weight_sum += 0.3;
    }

    // Completion (0.2)
    let completion = match metrics.final_status {
        crate::types::FinalStatus::Completed => 1.0,
        _ => -0.5,
    };
    reward += completion * 0.2;
    weight_sum += 0.2;

    // Environment reward (0.1)
    reward += components.environment_reward.clamp(-1.0, 1.0) * 0.1;
    weight_sum += 0.1;

    if weight_sum > 0.0 {
        reward /= weight_sum;
    }

    reward.clamp(-1.0, 1.0)
}

fn normalize_pnl(pnl: f64) -> f64 {
    (pnl / 500.0).tanh()
}

fn normalize_score(score: f64) -> f64 {
    (score + 1.0) / 2.0
}

fn normalize_scores_for_group(scores: &[f64]) -> Vec<f64> {
    let min = scores.iter().cloned().fold(f64::INFINITY, |a, b| a.min(b));
    let max = scores
        .iter()
        .cloned()
        .fold(f64::NEG_INFINITY, |a, b| a.max(b));
    let range = max - min;

    if range == 0.0 {
        return scores.iter().map(|_| 0.5).collect();
    }

    scores.iter().map(|s| (s - min) / range).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{FinalStatus, RewardComponents, Trajectory, TrajectoryMetrics};
    use std::collections::HashMap;

    #[test]
    fn test_score_group() {
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
        t1.metadata = HashMap::new();

        let mut t2 = t1.clone();
        t2.metrics.final_pnl = Some(-50.0);

        let scores = svc.score_trajectory_group(&[t1, t2]);
        assert_eq!(scores.len(), 2);
        assert!(scores[0] >= 0.0 && scores[0] <= 1.0);
        assert!(scores[1] >= 0.0 && scores[1] <= 1.0);
    }
}
