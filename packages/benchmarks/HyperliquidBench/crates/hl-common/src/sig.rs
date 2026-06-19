use serde::Serialize;

/// Normalized coverage signature wrapper used by the evaluator.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize)]
pub struct Signature(pub String);

impl Signature {
    pub fn perp_order(tif: &str, reduce_only: bool, trigger: &str) -> Self {
        Self(format!(
            "perp.order.{}:{}:{}",
            tif.to_ascii_uppercase(),
            reduce_only,
            trigger
        ))
    }

    pub fn perp_cancel(scope: &str) -> Self {
        Self(format!("perp.cancel.{}", scope))
    }

    pub fn account_usd_class_transfer(direction: &str) -> Self {
        Self(format!("account.usdClassTransfer.{}", direction))
    }

    pub fn risk_set_leverage(coin: &str) -> Self {
        Self(format!("risk.setLeverage.{}", coin.to_ascii_uppercase()))
    }

    pub fn into_inner(self) -> String {
        self.0
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

pub fn normalize_tif(raw: &str) -> &'static str {
    match raw.to_ascii_uppercase().as_str() {
        "ALO" => "ALO",
        "IOC" => "IOC",
        _ => "GTC",
    }
}

pub fn normalize_trigger(value: &serde_json::Value) -> String {
    if let Some(trigger) = value.get("trigger") {
        match trigger {
            serde_json::Value::Object(map) => map
                .get("kind")
                .and_then(|v| v.as_str())
                .map(|kind| kind.to_ascii_lowercase())
                .unwrap_or_else(|| "none".to_string()),
            serde_json::Value::String(label) => label.to_ascii_lowercase(),
            _ => "none".to_string(),
        }
    } else {
        "none".to_string()
    }
}
