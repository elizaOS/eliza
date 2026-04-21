use std::{
    fs::File,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    str::FromStr,
};

use anyhow::{anyhow, Context, Result};
use serde::{de, Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value;

/// Parsed representation of a runner plan.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub steps: Vec<ActionStep>,
}

impl Plan {
    pub fn as_json(&self) -> Value {
        serde_json::to_value(self).expect("plan must serialize")
    }
}

/// Step variants supported by the runner.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ActionStep {
    PerpOrders {
        perp_orders: PerpOrdersStep,
    },
    CancelLast {
        cancel_last: CancelLastStep,
    },
    CancelOids {
        cancel_oids: CancelOidsStep,
    },
    CancelAll {
        cancel_all: CancelAllStep,
    },
    UsdClassTransfer {
        usd_class_transfer: UsdClassTransferStep,
    },
    SetLeverage {
        set_leverage: SetLeverageStep,
    },
    Sleep {
        sleep_ms: SleepMsStep,
    },
}

impl ActionStep {
    pub fn kind(&self) -> &'static str {
        match self {
            ActionStep::PerpOrders { .. } => "perp_orders",
            ActionStep::CancelLast { .. } => "cancel_last",
            ActionStep::CancelOids { .. } => "cancel_oids",
            ActionStep::CancelAll { .. } => "cancel_all",
            ActionStep::UsdClassTransfer { .. } => "usd_class_transfer",
            ActionStep::SetLeverage { .. } => "set_leverage",
            ActionStep::Sleep { .. } => "sleep_ms",
        }
    }

    pub fn as_perp_orders(&self) -> Option<&PerpOrdersStep> {
        match self {
            ActionStep::PerpOrders { perp_orders } => Some(perp_orders),
            _ => None,
        }
    }

    pub fn as_cancel_scope(&self) -> Option<CancelScope<'_>> {
        match self {
            ActionStep::CancelLast { cancel_last } => Some(CancelScope::Last { cancel_last }),
            ActionStep::CancelOids { cancel_oids } => Some(CancelScope::Oids { cancel_oids }),
            ActionStep::CancelAll { cancel_all } => Some(CancelScope::All { cancel_all }),
            _ => None,
        }
    }
}

#[derive(Debug, Clone)]
pub enum CancelScope<'a> {
    Last { cancel_last: &'a CancelLastStep },
    Oids { cancel_oids: &'a CancelOidsStep },
    All { cancel_all: &'a CancelAllStep },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PerpOrdersStep {
    pub orders: Vec<PerpOrder>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub builder_code: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelLastStep {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub coin: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelOidsStep {
    pub coin: String,
    pub oids: Vec<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelAllStep {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub coin: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsdClassTransferStep {
    pub to_perp: bool,
    pub usdc: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetLeverageStep {
    pub coin: String,
    pub leverage: u32,
    #[serde(default)]
    pub cross: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SleepMsStep {
    #[serde(alias = "ms")]
    #[serde(alias = "duration_ms")]
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PerpOrder {
    pub coin: String,
    #[serde(default)]
    pub tif: PerpTif,
    pub side: OrderSide,
    pub sz: f64,
    #[serde(default)]
    pub reduce_only: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub builder_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cloid: Option<String>,
    #[serde(default)]
    pub trigger: Option<OrderTrigger>,
    #[serde(deserialize_with = "deserialize_order_price")]
    pub px: OrderPrice,
}

impl PerpOrder {
    pub fn is_buy(&self) -> bool {
        matches!(self.side, OrderSide::Buy)
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default)]
#[serde(rename_all = "UPPERCASE")]
pub enum PerpTif {
    #[serde(alias = "Alo", alias = "alo")]
    Alo,
    #[default]
    #[serde(alias = "Gtc", alias = "gtc")]
    Gtc,
    #[serde(alias = "Ioc", alias = "ioc")]
    Ioc,
}

impl PerpTif {
    pub fn as_sdk_str(&self) -> &'static str {
        match self {
            PerpTif::Alo => "Alo",
            PerpTif::Gtc => "Gtc",
            PerpTif::Ioc => "Ioc",
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub enum OrderSide {
    Buy,
    Sell,
}

impl OrderSide {
    pub fn as_bool(&self) -> bool {
        matches!(self, OrderSide::Buy)
    }
}

impl Serialize for OrderSide {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match self {
            OrderSide::Buy => serializer.serialize_str("buy"),
            OrderSide::Sell => serializer.serialize_str("sell"),
        }
    }
}

impl<'de> Deserialize<'de> for OrderSide {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        match value.to_ascii_lowercase().as_str() {
            "buy" => Ok(OrderSide::Buy),
            "sell" => Ok(OrderSide::Sell),
            other => Err(de::Error::custom(format!("invalid side '{other}'"))),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum OrderTrigger {
    None,
    Tp { px: OrderPrice },
    Sl { px: OrderPrice },
}

#[derive(Debug, Clone, Serialize)]
pub enum OrderPrice {
    Absolute(f64),
    MidPercent { offset_pct: f64 },
}

impl OrderPrice {
    pub fn resolve_with_mid(&self, mid: f64) -> f64 {
        match self {
            OrderPrice::Absolute(px) => *px,
            OrderPrice::MidPercent { offset_pct } => {
                let factor = 1.0 + offset_pct / 100.0;
                mid * factor
            }
        }
    }
}

fn deserialize_order_price<'de, D>(deserializer: D) -> Result<OrderPrice, D::Error>
where
    D: Deserializer<'de>,
{
    struct PriceVisitor;
    impl<'de> de::Visitor<'de> for PriceVisitor {
        type Value = OrderPrice;

        fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
            formatter.write_str("a number or a string of the form 'mid±X%'")
        }

        fn visit_f64<E>(self, value: f64) -> Result<Self::Value, E>
        where
            E: de::Error,
        {
            Ok(OrderPrice::Absolute(value))
        }

        fn visit_i64<E>(self, value: i64) -> Result<Self::Value, E>
        where
            E: de::Error,
        {
            self.visit_f64(value as f64)
        }

        fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E>
        where
            E: de::Error,
        {
            self.visit_f64(value as f64)
        }

        fn visit_str<E>(self, v: &str) -> Result<Self::Value, E>
        where
            E: de::Error,
        {
            let trimmed = v.trim();
            if let Some(rest) = trimmed.strip_prefix("mid") {
                let rest = rest.trim();
                let (sign, magnitude) = if let Some(v) = rest.strip_prefix('+') {
                    (1.0_f64, v)
                } else if let Some(v) = rest.strip_prefix('-') {
                    (-1.0_f64, v)
                } else {
                    return Err(E::custom("expected '+' or '-' after 'mid'"));
                };
                let magnitude = magnitude.trim_end_matches('%').trim();
                let pct = magnitude
                    .parse::<f64>()
                    .map_err(|_| E::custom("invalid mid% offset"))?;
                Ok(OrderPrice::MidPercent {
                    offset_pct: sign * pct,
                })
            } else {
                let value = trimmed
                    .parse::<f64>()
                    .map_err(|_| E::custom("invalid absolute price"))?;
                Ok(OrderPrice::Absolute(value))
            }
        }
    }

    deserializer.deserialize_any(PriceVisitor)
}

impl<'de> Deserialize<'de> for OrderPrice {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserialize_order_price(deserializer)
    }
}

/// Loads a plan from a JSON file or JSONL specification.
pub fn load_plan_from_spec(spec: &str) -> Result<Plan> {
    let (path, selector) = split_spec(spec)?;
    let plan_source = if let Some(index) = selector {
        read_jsonl_entry(&path, index)?
    } else {
        std::fs::read_to_string(&path)
            .with_context(|| format!("failed to read plan file {}", path.display()))?
    };

    let plan: Plan = serde_json::from_str(&plan_source)
        .with_context(|| format!("failed to deserialize plan from {}", path.display()))?;
    Ok(plan)
}

fn read_jsonl_entry(path: &Path, index: usize) -> Result<String> {
    let file = File::open(path)
        .with_context(|| format!("failed to open plan jsonl {}", path.display()))?;
    let reader = BufReader::new(file);
    let mut line = String::new();
    for (idx, result) in reader.lines().enumerate() {
        let idx = idx + 1; // 1-based for humans
        let content =
            result.with_context(|| format!("failed to read line {idx} from {}", path.display()))?;
        if idx == index {
            line = content;
            break;
        }
    }

    if line.is_empty() {
        return Err(anyhow!("line {} not found in {}", index, path.display()));
    }
    Ok(line)
}

fn split_spec(spec: &str) -> Result<(PathBuf, Option<usize>)> {
    let mut parts = spec.rsplitn(2, ':');
    let trailing = parts.next().unwrap_or(spec);
    if let Some(prefix) = parts.next() {
        if let Ok(index) = usize::from_str(trailing) {
            return Ok((PathBuf::from(prefix), Some(index)));
        }
    }
    Ok((PathBuf::from(spec), None))
}
