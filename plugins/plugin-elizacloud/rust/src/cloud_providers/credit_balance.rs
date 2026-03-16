//! creditBalanceProvider — Credit balance in agent state.

use crate::cloud_types::ProviderResult;

/// Format a credit balance into a ProviderResult.
pub fn format_balance(balance: f64) -> ProviderResult {
    let low = balance < 2.0;
    let critical = balance < 0.5;
    let mut text = format!("ElizaCloud credits: ${:.2}", balance);
    if critical {
        text.push_str(" (CRITICAL)");
    } else if low {
        text.push_str(" (LOW)");
    }

    ProviderResult {
        text,
        values: Some(serde_json::json!({
            "cloudCredits": balance,
            "cloudCreditsLow": low,
            "cloudCreditsCritical": critical,
        })),
        data: None,
    }
}

/// Get ElizaCloud credit balance (from pre-fetched value).
pub fn get_credit_balance(authenticated: bool, balance: Option<f64>) -> ProviderResult {
    if !authenticated {
        return ProviderResult {
            text: String::new(),
            values: None,
            data: None,
        };
    }

    match balance {
        Some(bal) => format_balance(bal),
        None => ProviderResult {
            text: "ElizaCloud credits: unknown".to_string(),
            values: None,
            data: None,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_format_balance_normal() {
        let result = format_balance(50.0);
        assert!(result.text.contains("$50.00"));
        assert!(!result.text.contains("LOW"));
        assert!(!result.text.contains("CRITICAL"));
    }

    #[test]
    fn test_format_balance_low() {
        let result = format_balance(1.5);
        assert!(result.text.contains("(LOW)"));
    }

    #[test]
    fn test_format_balance_critical() {
        let result = format_balance(0.3);
        assert!(result.text.contains("(CRITICAL)"));
    }

    #[test]
    fn test_unauthenticated() {
        let result = get_credit_balance(false, Some(100.0));
        assert!(result.text.is_empty());
    }

    #[test]
    fn test_authenticated_with_balance() {
        let result = get_credit_balance(true, Some(42.5));
        assert!(result.text.contains("$42.50"));
    }
}
