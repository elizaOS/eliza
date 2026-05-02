use std::{
    collections::BTreeMap,
    fs::File,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
};

use anyhow::{anyhow, Context, Result};
use clap::Parser;
use hl_common::ActionLogRecord;
use serde::{Deserialize, Serialize};
use serde_json::Value;

const DEFAULT_WITHIN_MS: i64 = 2000;
const DEFAULT_WINDOW_MS: i64 = 200;
const DEFAULT_AMOUNT_TOL: f64 = 0.01;
const DEFAULT_PX_TOL_PCT: f64 = 0.2;
const DEFAULT_SZ_TOL_PCT: f64 = 0.5;
const CONTEXT_RADIUS: usize = 3;

#[derive(Parser, Debug, Clone)]
#[command(about = "Validate Haystack-in-a-Needle ground truth against runner artifacts")]
pub struct HianArgs {
    #[arg(long)]
    pub ground: PathBuf,
    #[arg(long = "per-action")]
    pub per_action: PathBuf,
    #[arg(long = "ws-stream")]
    pub ws_stream: Option<PathBuf>,
    #[arg(long)]
    pub out_dir: Option<PathBuf>,
    #[arg(long)]
    pub within_ms: Option<i64>,
    #[arg(long)]
    pub window_ms: Option<i64>,
    #[arg(long)]
    pub amount_tol: Option<f64>,
    #[arg(long)]
    pub px_tol_pct: Option<f64>,
    #[arg(long)]
    pub sz_tol_pct: Option<f64>,
}

#[derive(Debug, Serialize)]
pub struct HianOutput {
    pub result: EvalHian,
    pub out_dir: PathBuf,
}

pub fn run(args: &HianArgs) -> Result<HianOutput> {
    let ground = load_ground_truth(&args.ground)?;
    let per_actions = load_action_log(&args.per_action)?;
    let ws_events = load_ws_events(
        args.ws_stream
            .clone()
            .or_else(|| args.per_action.parent().map(|p| p.join("ws_stream.jsonl"))),
    )?;

    let out_dir = args
        .out_dir
        .clone()
        .or_else(|| args.per_action.parent().map(PathBuf::from))
        .ok_or_else(|| anyhow!("could not determine output directory"))?;
    std::fs::create_dir_all(&out_dir)
        .with_context(|| format!("failed to create output directory {}", out_dir.display()))?;

    let settings = SettingsUsed {
        within_ms: args
            .within_ms
            .or(ground.within_ms)
            .unwrap_or(DEFAULT_WITHIN_MS),
        window_ms: args
            .window_ms
            .or(ground.window_ms)
            .unwrap_or(DEFAULT_WINDOW_MS),
        amount_tolerance: args.amount_tol.unwrap_or(DEFAULT_AMOUNT_TOL),
        px_tolerance_pct: args.px_tol_pct.unwrap_or(DEFAULT_PX_TOL_PCT),
        sz_tolerance_pct: args.sz_tol_pct.unwrap_or(DEFAULT_SZ_TOL_PCT),
    };

    let mut cursor: isize = -1;
    let mut last_ts: Option<i64> = None;
    let mut matched = Vec::new();
    let mut missing = Vec::new();
    let mut latency: BTreeMap<String, Option<i64>> = BTreeMap::new();

    for (expect_idx, step) in ground.steps.iter().enumerate() {
        let start_idx = (cursor + 1).max(0) as usize;
        let mut found = None;
        let mut failure_reason = String::from("not found");

        for (idx, action) in per_actions.iter().enumerate().skip(start_idx) {
            if let Some(prev) = last_ts {
                if action.submit_ts_ms - prev > settings.within_ms {
                    failure_reason = format!(
                        "no matching action within {} ms after previous step",
                        settings.within_ms
                    );
                    break;
                }
            }

            match match_step(step, action, &ws_events, &settings) {
                Ok(detail) => {
                    found = Some((idx, detail));
                    break;
                }
                Err(reason) => failure_reason = reason,
            }
        }

        if let Some((idx, detail)) = found {
            cursor = idx as isize;
            last_ts = Some(per_actions[idx].submit_ts_ms);
            latency.insert(expect_idx.to_string(), detail.latency_ms);
            matched.push(MatchedStepRecord {
                expect_idx,
                matched_at: idx,
                detail,
            });
        } else {
            missing.push(MissingStepRecord {
                expect_idx,
                description: step.describe(),
                reason: failure_reason,
            });
            latency.insert(expect_idx.to_string(), None);
        }
    }

    let pass = missing.is_empty();
    let result = EvalHian {
        pass,
        case_id: ground.case_id.clone(),
        matched: matched
            .iter()
            .map(|m| m.detail.to_serializable(m.expect_idx, m.matched_at))
            .collect(),
        missing: missing.iter().map(|m| m.to_serializable()).collect(),
        extra: Vec::new(),
        metrics: Metrics {
            latency_ms: latency,
            window_ms: settings.window_ms,
        },
        settings: settings.clone(),
    };

    let json_path = out_dir.join("eval_hian.json");
    std::fs::write(&json_path, serde_json::to_string_pretty(&result)?)
        .with_context(|| format!("failed to write {}", json_path.display()))?;

    if !result.pass {
        let diff = build_diff(&ground, &per_actions, &missing);
        let diff_path = out_dir.join("eval_hian_diff.txt");
        std::fs::write(&diff_path, diff)
            .with_context(|| format!("failed to write {}", diff_path.display()))?;
    }

    Ok(HianOutput { result, out_dir })
}

#[derive(Debug, Clone, Serialize)]
pub struct EvalHian {
    pub pass: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub case_id: Option<String>,
    pub matched: Vec<MatchedStepSerial>,
    pub missing: Vec<MissingStepSerial>,
    pub extra: Vec<Value>,
    pub metrics: Metrics,
    pub settings: SettingsUsed,
}

#[derive(Debug, Clone, Serialize)]
pub struct Metrics {
    pub latency_ms: BTreeMap<String, Option<i64>>,
    pub window_ms: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct SettingsUsed {
    pub within_ms: i64,
    pub window_ms: i64,
    pub amount_tolerance: f64,
    pub px_tolerance_pct: f64,
    pub sz_tolerance_pct: f64,
}

#[derive(Debug, Clone)]
struct MatchedStepRecord {
    expect_idx: usize,
    matched_at: usize,
    detail: MatchDetail,
}

#[derive(Debug, Clone)]
struct MatchDetail {
    kind: MatchKind,
    ts_ms: i64,
    oid: Option<u64>,
    fill: Option<FillInfo>,
    latency_ms: Option<i64>,
}

impl MatchDetail {
    fn to_serializable(&self, expect_idx: usize, matched_at: usize) -> MatchedStepSerial {
        MatchedStepSerial {
            expect_idx,
            matched_at,
            kind: self.kind.to_string(),
            ts_ms: self.ts_ms,
            oid: self.oid,
            fill: self.fill.clone(),
        }
    }
}

#[derive(Debug, Clone)]
struct MissingStepRecord {
    expect_idx: usize,
    description: String,
    reason: String,
}

impl MissingStepRecord {
    fn to_serializable(&self) -> MissingStepSerial {
        MissingStepSerial {
            expect_idx: self.expect_idx,
            description: self.description.clone(),
            reason: self.reason.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct MatchedStepSerial {
    pub expect_idx: usize,
    pub matched_at: usize,
    pub kind: String,
    pub ts_ms: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub oid: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fill: Option<FillInfo>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MissingStepSerial {
    pub expect_idx: usize,
    pub description: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct FillInfo {
    pub px: Option<String>,
    pub sz: Option<String>,
}

#[derive(Debug, Clone)]
enum MatchKind {
    UsdClassTransfer,
    PerpOrder,
}

impl std::fmt::Display for MatchKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MatchKind::UsdClassTransfer => write!(f, "usd_class_transfer"),
            MatchKind::PerpOrder => write!(f, "perp_order"),
        }
    }
}

#[derive(Debug, Deserialize)]
struct GroundTruth {
    #[serde(default)]
    case_id: Option<String>,
    #[serde(default)]
    within_ms: Option<i64>,
    #[serde(default)]
    window_ms: Option<i64>,
    steps: Vec<ExpectedStep>,
}

#[derive(Debug, Deserialize)]
struct ExpectedStep {
    #[serde(rename = "usdClassTransfer")]
    usd_class_transfer: Option<ExpectedTransfer>,
    #[serde(rename = "perpOrder")]
    perp_order: Option<ExpectedPerpOrder>,
}

impl ExpectedStep {
    fn kind(&self) -> StepKind {
        if let Some(t) = &self.usd_class_transfer {
            StepKind::UsdClassTransfer(t.clone())
        } else if let Some(p) = &self.perp_order {
            StepKind::PerpOrder(p.clone())
        } else {
            StepKind::Unsupported
        }
    }

    fn describe(&self) -> String {
        match self.kind() {
            StepKind::UsdClassTransfer(t) => format!(
                "usd_class_transfer {{ toPerp: {}, usdc: {:?} }}",
                t.to_perp, t.usdc
            ),
            StepKind::PerpOrder(p) => format!(
                "perp_order {{ coin: {:?}, side: {:?}, tif: {:?}, reduceOnly: {:?} }}",
                p.coin, p.side, p.tif, p.reduce_only
            ),
            StepKind::Unsupported => "unsupported step".to_string(),
        }
    }
}

#[derive(Debug, Clone)]
enum StepKind {
    UsdClassTransfer(ExpectedTransfer),
    PerpOrder(ExpectedPerpOrder),
    Unsupported,
}

#[derive(Debug, Deserialize, Clone)]
struct ExpectedTransfer {
    to_perp: bool,
    #[serde(default)]
    usdc: Option<NumMatcher>,
}

#[derive(Debug, Deserialize, Clone)]
struct ExpectedPerpOrder {
    coin: Option<String>,
    side: Option<String>,
    tif: Option<String>,
    #[serde(default)]
    reduce_only: Option<bool>,
    #[serde(default)]
    sz: Option<NumMatcher>,
    #[serde(default)]
    px: Option<PxMatcher>,
    #[serde(default)]
    require_fill: Option<bool>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PxMatcher {
    #[serde(default)]
    mode: Option<String>,
    #[serde(default)]
    val: Option<f64>,
}

#[derive(Debug, Deserialize, Clone)]
struct NumMatcher {
    #[serde(default)]
    eq: Option<f64>,
    #[serde(default)]
    tol: Option<f64>,
    #[serde(default)]
    ge: Option<f64>,
    #[serde(default)]
    le: Option<f64>,
}

impl NumMatcher {
    fn matches_amount(&self, actual: f64, settings: &SettingsUsed) -> Result<(), String> {
        if let Some(ge) = self.ge {
            if actual + 1e-9 < ge {
                return Err(format!("value {:.4} < ge {:.4}", actual, ge));
            }
        }
        if let Some(le) = self.le {
            if actual - 1e-9 > le {
                return Err(format!("value {:.4} > le {:.4}", actual, le));
            }
        }
        if let Some(target) = self.eq {
            let tol = self.tol.unwrap_or(settings.amount_tolerance);
            if (actual - target).abs() > tol {
                return Err(format!(
                    "value {:.4} not within ±{:.4} of {:.4}",
                    actual, tol, target
                ));
            }
        }
        Ok(())
    }

    fn matches_size(&self, actual: f64, settings: &SettingsUsed) -> Result<(), String> {
        if let Some(ge) = self.ge {
            if actual + 1e-9 < ge {
                return Err(format!("value {:.4} < ge {:.4}", actual, ge));
            }
        }
        if let Some(le) = self.le {
            if actual - 1e-9 > le {
                return Err(format!("value {:.4} > le {:.4}", actual, le));
            }
        }
        if let Some(target) = self.eq {
            let tol = self
                .tol
                .unwrap_or(target.abs() * settings.sz_tolerance_pct / 100.0);
            if (actual - target).abs() > tol {
                return Err(format!(
                    "value {:.4} not within ±{:.4} of {:.4}",
                    actual, tol, target
                ));
            }
        }
        Ok(())
    }
}

impl PxMatcher {
    fn matches(&self, actual: Option<f64>, settings: &SettingsUsed) -> Result<(), String> {
        match self
            .mode
            .as_deref()
            .unwrap_or("ignore")
            .to_ascii_lowercase()
            .as_str()
        {
            "ignore" => Ok(()),
            "abs" => {
                let target = self
                    .val
                    .ok_or_else(|| "px matcher requires val when mode=abs".to_string())?;
                let actual = actual.ok_or_else(|| "no price observed".to_string())?;
                let tol = target.abs() * settings.px_tolerance_pct / 100.0;
                if (actual - target).abs() > tol {
                    return Err(format!(
                        "price {:.4} not within ±{:.4} of {:.4}",
                        actual, tol, target
                    ));
                }
                Ok(())
            }
            other => Err(format!("unsupported px matcher mode '{other}'")),
        }
    }
}

#[derive(Debug, Clone)]
struct TransferEvent {
    to_perp: bool,
    usdc: Option<f64>,
    time_ms: Option<i64>,
}

#[derive(Debug, Clone)]
struct DetailedFill {
    px: Option<String>,
    sz: Option<String>,
    time_ms: Option<i64>,
}

fn match_step(
    step: &ExpectedStep,
    action: &ActionLogRecord,
    ws_events: &[WsEvent],
    settings: &SettingsUsed,
) -> Result<MatchDetail, String> {
    match step.kind() {
        StepKind::UsdClassTransfer(expected) => {
            match_transfer(&expected, action, ws_events, settings)
        }
        StepKind::PerpOrder(expected) => match_perp_order(&expected, action, ws_events, settings),
        StepKind::Unsupported => Err("unsupported step kind".to_string()),
    }
}

fn match_transfer(
    expected: &ExpectedTransfer,
    action: &ActionLogRecord,
    ws_events: &[WsEvent],
    settings: &SettingsUsed,
) -> Result<MatchDetail, String> {
    if action.action != "usd_class_transfer" {
        return Err("action kind mismatch".to_string());
    }

    let to_perp = action
        .request
        .get("usd_class_transfer")
        .and_then(|v| v.get("toPerp"))
        .and_then(Value::as_bool)
        .ok_or_else(|| "missing toPerp in request".to_string())?;
    if to_perp != expected.to_perp {
        return Err(format!(
            "toPerp mismatch (expected {}, got {})",
            expected.to_perp, to_perp
        ));
    }

    let event = extract_transfer_event(action).or_else(|| find_transfer_in_ws(action, ws_events));
    let Some(event) = event else {
        return Err("no observed transfer event".to_string());
    };

    if event.to_perp != expected.to_perp {
        return Err(format!(
            "toPerp mismatch in observed event (expected {}, got {})",
            expected.to_perp, event.to_perp
        ));
    }

    if let Some(matcher) = &expected.usdc {
        let amount = event
            .usdc
            .ok_or_else(|| "transfer amount missing in observed event".to_string())?;
        matcher.matches_amount(amount, settings)?;
    }

    let latency_ms = event.time_ms.map(|t| (t - action.submit_ts_ms).max(0));

    Ok(MatchDetail {
        kind: MatchKind::UsdClassTransfer,
        ts_ms: action.submit_ts_ms,
        oid: None,
        fill: None,
        latency_ms,
    })
}

fn match_perp_order(
    expected: &ExpectedPerpOrder,
    action: &ActionLogRecord,
    ws_events: &[WsEvent],
    settings: &SettingsUsed,
) -> Result<MatchDetail, String> {
    if action.action != "perp_orders" {
        return Err("action kind mismatch".to_string());
    }

    let orders = action
        .request
        .get("perp_orders")
        .and_then(|v| v.get("orders"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if orders.is_empty() {
        return Err("perp_orders step missing orders".to_string());
    }

    let statuses = action
        .ack
        .as_ref()
        .and_then(|ack| ack.get("data"))
        .and_then(|d| d.get("statuses"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    for (idx, order) in orders.iter().enumerate() {
        if let Some(coin) = &expected.coin {
            let actual_coin = order.get("coin").and_then(Value::as_str).unwrap_or("");
            if !actual_coin.eq_ignore_ascii_case(coin) {
                continue;
            }
        }
        if let Some(side) = &expected.side {
            let actual_side = order.get("side").and_then(Value::as_str).unwrap_or("");
            if !actual_side.eq_ignore_ascii_case(side) {
                continue;
            }
        }
        if let Some(tif) = &expected.tif {
            let actual_tif = order.get("tif").and_then(Value::as_str).unwrap_or("");
            if !actual_tif.eq_ignore_ascii_case(tif) {
                continue;
            }
        }
        if let Some(reduce_only) = expected.reduce_only {
            let actual_reduce_only = order
                .get("reduceOnly")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if actual_reduce_only != reduce_only {
                continue;
            }
        }
        if let Some(matcher) = &expected.sz {
            let actual_sz = order
                .get("sz")
                .and_then(Value::as_f64)
                .or_else(|| {
                    order
                        .get("sz")
                        .and_then(Value::as_str)
                        .and_then(|s| s.parse::<f64>().ok())
                })
                .ok_or_else(|| "order size missing".to_string())?;
            matcher.matches_size(actual_sz, settings)?;
        }

        let status = statuses.get(idx);
        if status.is_none() {
            continue;
        }
        let status = status.unwrap();
        let status_kind = status.get("kind").and_then(Value::as_str).unwrap_or("");
        if status_kind.eq_ignore_ascii_case("error") {
            continue;
        }

        let require_fill = expected.require_fill.unwrap_or(false);
        let mut fill_detail = extract_fill_from_status(status);
        if require_fill && fill_detail.is_none() {
            fill_detail =
                find_fill_in_observed(action).or_else(|| find_fill_in_ws(ws_events, status));
            if fill_detail.is_none() {
                return Err("order required fill but none observed".to_string());
            }
        }

        if let Some(px_matcher) = &expected.px {
            let price = fill_detail
                .as_ref()
                .and_then(|f| f.px.as_deref())
                .and_then(|s| s.parse::<f64>().ok())
                .or_else(|| {
                    status
                        .get("avgPx")
                        .and_then(Value::as_str)
                        .and_then(|s| s.parse::<f64>().ok())
                });
            px_matcher.matches(price, settings)?;
        }

        let latency_ms = fill_detail
            .as_ref()
            .and_then(|f| f.time_ms)
            .map(|t| (t - action.submit_ts_ms).max(0));

        let fill = fill_detail.map(|f| FillInfo { px: f.px, sz: f.sz });

        let oid = status.get("oid").and_then(Value::as_u64).or_else(|| {
            status
                .get("oid")
                .and_then(Value::as_str)
                .and_then(|s| s.parse().ok())
        });

        return Ok(MatchDetail {
            kind: MatchKind::PerpOrder,
            ts_ms: action.submit_ts_ms,
            oid,
            fill,
            latency_ms,
        });
    }

    Err("no matching order in step".to_string())
}

fn extract_fill_from_status(status: &Value) -> Option<DetailedFill> {
    let kind = status.get("kind").and_then(Value::as_str).unwrap_or("");
    if !kind.eq_ignore_ascii_case("filled") {
        return None;
    }
    let px = status
        .get("avgPx")
        .and_then(Value::as_str)
        .map(String::from);
    let sz = status
        .get("totalSz")
        .and_then(Value::as_str)
        .map(String::from);
    let time_ms = status.get("statusTimestamp").and_then(Value::as_i64);
    Some(DetailedFill { px, sz, time_ms })
}

fn find_fill_in_observed(action: &ActionLogRecord) -> Option<DetailedFill> {
    let observations = extract_observed(action);
    for obs in observations {
        let channel = obs.get("channel").and_then(Value::as_str).unwrap_or("");
        if channel == "userFills" {
            if let Some(fills) = obs.get("fills").and_then(Value::as_array) {
                if let Some(fill) = fills.first() {
                    let px = fill.get("px").and_then(Value::as_str).map(String::from);
                    let sz = fill.get("sz").and_then(Value::as_str).map(String::from);
                    let time_ms = fill.get("time").and_then(Value::as_i64);
                    return Some(DetailedFill { px, sz, time_ms });
                }
            } else {
                let px = obs.get("px").and_then(Value::as_str).map(String::from);
                let sz = obs.get("sz").and_then(Value::as_str).map(String::from);
                let time_ms = obs.get("time").and_then(Value::as_i64);
                if px.is_some() || sz.is_some() {
                    return Some(DetailedFill { px, sz, time_ms });
                }
            }
        }
    }
    None
}

fn find_fill_in_ws(ws_events: &[WsEvent], status: &Value) -> Option<DetailedFill> {
    let oid = status.get("oid").and_then(Value::as_u64).or_else(|| {
        status
            .get("oid")
            .and_then(Value::as_str)
            .and_then(|s| s.parse().ok())
    });
    for event in ws_events {
        if event.channel.as_deref() != Some("userFills") {
            continue;
        }
        if let Some(fills) = event.value.get("fills").and_then(Value::as_array) {
            for fill in fills {
                if let Some(event_oid) = fill.get("oid").and_then(Value::as_u64).or_else(|| {
                    fill.get("oid")
                        .and_then(Value::as_str)
                        .and_then(|s| s.parse().ok())
                }) {
                    if Some(event_oid) != oid {
                        continue;
                    }
                }
                let px = fill.get("px").and_then(Value::as_str).map(String::from);
                let sz = fill.get("sz").and_then(Value::as_str).map(String::from);
                let time_ms = fill.get("time").and_then(Value::as_i64);
                return Some(DetailedFill { px, sz, time_ms });
            }
        }
    }
    None
}

fn extract_transfer_event(action: &ActionLogRecord) -> Option<TransferEvent> {
    let observations = extract_observed(action);
    for obs in observations {
        let channel = obs.get("channel").and_then(Value::as_str).unwrap_or("");
        if channel == "accountClassTransfer" {
            let to_perp = obs.get("toPerp").and_then(Value::as_bool)?;
            let usdc = obs.get("usdc").and_then(Value::as_f64).or_else(|| {
                obs.get("usdc")
                    .and_then(Value::as_str)
                    .and_then(|s| s.parse::<f64>().ok())
            });
            let time_ms = obs.get("time").and_then(Value::as_i64);
            return Some(TransferEvent {
                to_perp,
                usdc,
                time_ms,
            });
        }
    }
    None
}

fn find_transfer_in_ws(action: &ActionLogRecord, ws_events: &[WsEvent]) -> Option<TransferEvent> {
    for event in ws_events {
        if event.channel.as_deref() != Some("accountClassTransfer") {
            continue;
        }
        let to_perp = event.value.get("toPerp").and_then(Value::as_bool)?;
        let usdc = event.value.get("usdc").and_then(Value::as_f64).or_else(|| {
            event
                .value
                .get("usdc")
                .and_then(Value::as_str)
                .and_then(|s| s.parse::<f64>().ok())
        });
        let time_ms = event.value.get("time").and_then(Value::as_i64);
        if time_ms
            .map(|t| (t - action.submit_ts_ms).abs() <= DEFAULT_WITHIN_MS)
            .unwrap_or(true)
        {
            let expected_to_perp = action
                .request
                .get("usd_class_transfer")
                .and_then(|v| v.get("toPerp"))
                .and_then(Value::as_bool)
                .unwrap_or(to_perp);
            if to_perp == expected_to_perp {
                return Some(TransferEvent {
                    to_perp,
                    usdc,
                    time_ms,
                });
            }
        }
    }
    None
}

fn extract_observed(action: &ActionLogRecord) -> Vec<Value> {
    match action.observed.as_ref() {
        Some(Value::Array(arr)) => arr.clone(),
        Some(Value::Object(obj)) => vec![Value::Object(obj.clone())],
        _ => Vec::new(),
    }
}

#[derive(Debug)]
struct WsEvent {
    channel: Option<String>,
    value: Value,
}

fn load_ground_truth(path: &Path) -> Result<GroundTruth> {
    let file = File::open(path).with_context(|| format!("failed to open {}", path.display()))?;
    serde_json::from_reader(file)
        .with_context(|| format!("failed to parse ground truth {}", path.display()))
}

fn load_action_log(path: &Path) -> Result<Vec<ActionLogRecord>> {
    let file = File::open(path).with_context(|| format!("failed to open {}", path.display()))?;
    let reader = BufReader::new(file);
    let mut records = Vec::new();
    for (idx, line) in reader.lines().enumerate() {
        let line = line.with_context(|| format!("failed to read per_action line {}", idx + 1))?;
        if line.trim().is_empty() {
            continue;
        }
        records.push(
            serde_json::from_str::<ActionLogRecord>(&line)
                .with_context(|| format!("failed to parse ActionLogRecord on line {}", idx + 1))?,
        );
    }
    Ok(records)
}

fn load_ws_events(path: Option<PathBuf>) -> Result<Vec<WsEvent>> {
    let Some(path) = path else {
        return Ok(Vec::new());
    };
    if !path.exists() {
        return Ok(Vec::new());
    }
    let file = File::open(&path).with_context(|| format!("failed to open {}", path.display()))?;
    let reader = BufReader::new(file);
    let mut events = Vec::new();
    for (idx, line) in reader.lines().enumerate() {
        let line = line.with_context(|| format!("failed to read ws_stream line {}", idx + 1))?;
        if line.trim().is_empty() {
            continue;
        }
        let value: Value = serde_json::from_str(&line)
            .with_context(|| format!("failed to parse ws_stream JSON on line {}", idx + 1))?;
        let channel = value
            .get("channel")
            .and_then(Value::as_str)
            .map(String::from);
        events.push(WsEvent { channel, value });
    }
    Ok(events)
}

fn build_diff(
    ground: &GroundTruth,
    actions: &[ActionLogRecord],
    missing: &[MissingStepRecord],
) -> String {
    let mut out = String::new();
    let case = ground
        .case_id
        .clone()
        .unwrap_or_else(|| "unknown-case".to_string());
    use std::fmt::Write as _;
    let _ = writeln!(out, "HiaN FAIL (case {case})");
    for miss in missing {
        let _ = writeln!(
            out,
            "\nStep {} expected: {}\n  ✗ {}",
            miss.expect_idx, miss.description, miss.reason
        );
        for summary in context_actions(actions, CONTEXT_RADIUS) {
            let _ = writeln!(out, "    {summary}");
        }
    }
    out
}

fn context_actions(actions: &[ActionLogRecord], radius: usize) -> Vec<String> {
    actions
        .iter()
        .take(radius)
        .enumerate()
        .map(|(idx, action)| format!("#{idx} {} @{}", action_summary(action), action.submit_ts_ms))
        .collect()
}

fn action_summary(action: &ActionLogRecord) -> String {
    match action.action.as_str() {
        "usd_class_transfer" => {
            let to_perp = action
                .request
                .get("usd_class_transfer")
                .and_then(|v| v.get("toPerp"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let usdc = action
                .request
                .get("usd_class_transfer")
                .and_then(|v| v.get("usdc"))
                .and_then(Value::as_f64)
                .unwrap_or(0.0);
            format!(
                "usd_class_transfer {{ toPerp: {}, usdc: {:.4} }}",
                to_perp, usdc
            )
        }
        "perp_orders" => {
            let coin = action
                .request
                .get("perp_orders")
                .and_then(|v| v.get("orders"))
                .and_then(Value::as_array)
                .and_then(|arr| arr.first())
                .and_then(|order| order.get("coin"))
                .and_then(Value::as_str)
                .unwrap_or("?");
            let side = action
                .request
                .get("perp_orders")
                .and_then(|v| v.get("orders"))
                .and_then(Value::as_array)
                .and_then(|arr| arr.first())
                .and_then(|order| order.get("side"))
                .and_then(Value::as_str)
                .unwrap_or("?");
            format!("perp_orders {{ coin: {}, side: {} }}", coin, side)
        }
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use uuid::Uuid;

    fn tmp_dir() -> PathBuf {
        let mut dir = std::env::temp_dir();
        dir.push(format!("hian-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_file(path: &Path, contents: &str) {
        let mut file = File::create(path).unwrap();
        file.write_all(contents.as_bytes()).unwrap();
    }

    #[test]
    fn hian_pass_minimal() {
        let dir = tmp_dir();
        let per_action_path = dir.join("per_action.jsonl");
        write_file(
            &per_action_path,
            r#"{"stepIdx":0,"action":"usd_class_transfer","submitTsMs":1000,"windowKeyMs":1000,"request":{"usd_class_transfer":{"toPerp":true,"usdc":25.0}},"ack":{"status":"ok"},"observed":{"channel":"accountClassTransfer","toPerp":true,"usdc":25.0,"time":1010}}
{"stepIdx":1,"action":"perp_orders","submitTsMs":1200,"windowKeyMs":1200,"request":{"perp_orders":{"orders":[{"coin":"ETH","side":"sell","tif":"IOC","reduceOnly":true,"sz":0.01}]}},"ack":{"status":"ok","data":{"statuses":[{"kind":"filled","oid":1,"avgPx":"3875.1","totalSz":"0.01","statusTimestamp":1210}]}},"observed":[{"channel":"userFills","fills":[{"px":"3875.1","sz":"0.01","time":1210,"oid":1}]}]}"#,
        );

        let ground_path = dir.join("ground_truth.json");
        write_file(
            &ground_path,
            r#"{
  "caseId": "sample",
  "steps": [
    {"usdClassTransfer": {"toPerp": true, "usdc": {"eq": 25.0, "tol": 0.1}}},
    {"perpOrder": {"coin": "ETH", "side": "sell", "tif": "IOC", "reduceOnly": true, "requireFill": true}}
  ]
}"#,
        );

        let args = HianArgs {
            ground: ground_path.clone(),
            per_action: per_action_path.clone(),
            ws_stream: None,
            out_dir: Some(dir.clone()),
            within_ms: None,
            window_ms: None,
            amount_tol: None,
            px_tol_pct: None,
            sz_tol_pct: None,
        };

        let output = run(&args).unwrap();
        assert!(output.result.pass);
        assert!(output.out_dir.join("eval_hian.json").exists());
    }

    #[test]
    fn hian_fail_amount() {
        let dir = tmp_dir();
        let per_action_path = dir.join("per_action.jsonl");
        write_file(
            &per_action_path,
            r#"{"stepIdx":0,"action":"usd_class_transfer","submitTsMs":1000,"windowKeyMs":1000,"request":{"usd_class_transfer":{"toPerp":true,"usdc":24.9}},"ack":{"status":"ok"},"observed":{"channel":"accountClassTransfer","toPerp":true,"usdc":24.9,"time":1010}}"#,
        );
        let ground_path = dir.join("ground_truth.json");
        write_file(
            &ground_path,
            r#"{"steps":[{"usdClassTransfer":{"toPerp":true,"usdc":{"eq":25.0,"tol":0.01}}}]}"#,
        );
        let args = HianArgs {
            ground: ground_path.clone(),
            per_action: per_action_path.clone(),
            ws_stream: None,
            out_dir: Some(dir.clone()),
            within_ms: None,
            window_ms: None,
            amount_tol: None,
            px_tol_pct: None,
            sz_tol_pct: None,
        };
        let output = run(&args).unwrap();
        assert!(!output.result.pass);
        assert!(output.out_dir.join("eval_hian_diff.txt").exists());
    }
}
