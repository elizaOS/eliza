//! CHECK_CLOUD_CREDITS — Query ElizaCloud credit balance and usage.

use std::collections::HashMap;

use crate::cloud_api::CloudApiClient;
use crate::cloud_types::{ActionResult, ContainerStatus};
use crate::error::Result;
use crate::services::CloudContainerService;

pub const ACTION_NAME: &str = "CHECK_CLOUD_CREDITS";
pub const ACTION_DESCRIPTION: &str =
    "Check ElizaCloud credit balance, container costs, and estimated remaining runtime.";

const DAILY_COST_PER_CONTAINER: f64 = 0.67;

/// Handle the CHECK_CLOUD_CREDITS action.
pub async fn handle_check_credits(
    client: &CloudApiClient,
    container_svc: Option<&CloudContainerService>,
    options: &HashMap<String, serde_json::Value>,
) -> Result<ActionResult> {
    let resp = client.get("/credits/balance").await?;
    let balance = resp
        .get("data")
        .and_then(|d| d.get("balance"))
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0);

    let running = container_svc
        .map(|svc| {
            svc.tracked_containers()
                .iter()
                .filter(|c| c.status == ContainerStatus::Running)
                .count()
        })
        .unwrap_or(0);

    let daily_cost = running as f64 * DAILY_COST_PER_CONTAINER;
    let days_remaining = if daily_cost > 0.0 {
        Some(balance / daily_cost)
    } else {
        None
    };

    let mut lines = vec![format!("ElizaCloud credits: ${:.2}", balance)];

    if running > 0 {
        lines.push(format!(
            "Active containers: {} (${:.2}/day) — ~{:.1} days remaining",
            running,
            daily_cost,
            days_remaining.unwrap_or(0.0)
        ));
    } else {
        lines.push("No active containers.".to_string());
    }

    let detailed = options
        .get("detailed")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    if detailed {
        let summary_resp = client.get("/credits/summary").await?;
        if let Some(data) = summary_resp.get("data") {
            let total_spent = data["totalSpent"].as_f64().unwrap_or(0.0);
            let total_added = data["totalAdded"].as_f64().unwrap_or(0.0);
            lines.push(format!(
                "Total spent: ${:.2} | Total added: ${:.2}",
                total_spent, total_added
            ));

            if let Some(txns) = data["recentTransactions"].as_array() {
                for tx in txns.iter().take(10) {
                    let amount = tx["amount"].as_f64().unwrap_or(0.0);
                    let sign = if amount >= 0.0 { "+" } else { "" };
                    let desc = tx["description"].as_str().unwrap_or("");
                    let date = tx["created_at"].as_str().unwrap_or("").get(..10).unwrap_or("");
                    lines.push(format!("  {}${:.2} — {} ({})", sign, amount, desc, date));
                }
            }
        }
    }

    let text = lines.join("\n");

    Ok(ActionResult::ok(
        text,
        serde_json::json!({
            "balance": balance,
            "runningContainers": running,
            "dailyCost": daily_cost,
            "estimatedDaysRemaining": days_remaining,
        }),
    ))
}
