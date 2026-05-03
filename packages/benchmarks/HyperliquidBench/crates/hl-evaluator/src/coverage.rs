use std::{
    collections::{BTreeMap, BTreeSet, HashMap, HashSet},
    fs::File,
    io::{BufRead, BufReader, BufWriter, Write},
    path::{Path, PathBuf},
};

use anyhow::{anyhow, Context, Result};
use clap::Parser;
use hl_common::{normalize_tif, normalize_trigger, ActionLogRecord, Signature};
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use serde_yaml::Value as YamlValue;
use thiserror::Error;

const PENALTY_PER_EXTRA: f64 = 0.1;
const BONUS_PER_EXTRA_SIGNATURE: f64 = 0.25;

#[derive(Parser, Debug, Clone)]
#[command(
    author,
    version,
    about = "Evaluate HyperLiquidBench coverage runs",
    disable_help_subcommand = true
)]
pub struct CoverageArgs {
    /// Path to per_action.jsonl produced by hl-runner
    #[arg(long)]
    input: PathBuf,
    /// Path to domains-hl.yaml configuration
    #[arg(long)]
    domains: PathBuf,
    /// Output directory (defaults to parent directory of file input)
    #[arg(long)]
    out_dir: Option<PathBuf>,
    /// Override window size in milliseconds for composition bonus
    #[arg(long)]
    window_ms: Option<i64>,
    /// Override per-signature cap (defaults to value inside YAML)
    #[arg(long)]
    cap_per_sig: Option<usize>,
}

#[derive(Debug, Deserialize)]
struct RawConfig {
    #[serde(default)]
    _version: Option<String>,
    #[serde(default)]
    per_action_window_ms: Option<i64>,
    #[serde(default)]
    per_signature_cap: Option<usize>,
    domains: IndexMap<String, RawDomain>,
}

#[derive(Debug, Deserialize)]
struct RawDomain {
    weight: f64,
    allow: Vec<String>,
}

#[derive(Debug, Clone)]
struct DomainEntry {
    name: String,
    weight: f64,
    patterns: Vec<Pattern>,
}

#[derive(Debug, Clone)]
struct Pattern {
    segments: Vec<PatternSegment>,
    tail_wildcard: bool,
}

#[derive(Debug, Clone)]
enum PatternSegment {
    Literal(String),
    Wildcard,
}

impl Pattern {
    fn matches(&self, signature: &str) -> bool {
        let sig_parts: Vec<&str> = signature.split('.').collect();

        if !self.tail_wildcard && sig_parts.len() != self.segments.len() {
            return false;
        }
        if self.tail_wildcard && sig_parts.len() < self.segments.len() {
            return false;
        }

        for (idx, segment) in self.segments.iter().enumerate() {
            if idx >= sig_parts.len() {
                return false;
            }
            let value = sig_parts[idx];
            match segment {
                PatternSegment::Literal(lit) => {
                    if !lit.eq_ignore_ascii_case(value) {
                        return false;
                    }
                }
                PatternSegment::Wildcard => {}
            }
        }

        true
    }
}

#[derive(Debug)]
struct DomainMatcher {
    entries: Vec<DomainEntry>,
}

impl DomainMatcher {
    fn from_config(raw: RawConfig) -> Result<(Self, ConfigOptions)> {
        let mut entries = Vec::new();
        for (name, domain) in raw.domains.into_iter() {
            if domain.allow.is_empty() {
                return Err(anyhow!(
                    "domain '{name}' must have at least one allow pattern"
                ));
            }
            let mut patterns = Vec::new();
            for pattern_str in domain.allow {
                patterns.push(parse_pattern(&pattern_str).with_context(|| {
                    format!("invalid allow pattern '{pattern_str}' in domain '{name}'")
                })?);
            }
            entries.push(DomainEntry {
                name,
                weight: domain.weight,
                patterns,
            });
        }

        let opts = ConfigOptions {
            window_ms: raw.per_action_window_ms.unwrap_or(200),
            per_signature_cap: raw.per_signature_cap.unwrap_or(3),
        };

        Ok((DomainMatcher { entries }, opts))
    }

    fn domain_matches(&self, signature: &str) -> Vec<&DomainEntry> {
        self.entries
            .iter()
            .filter(|entry| entry.patterns.iter().any(|pat| pat.matches(signature)))
            .collect()
    }

    fn domain_for(&self, signature: &str) -> Option<&DomainEntry> {
        let matches = self.domain_matches(signature);
        if matches.len() > 1 {
            let names: Vec<&str> = matches.iter().map(|d| d.name.as_str()).collect();
            eprintln!(
                "warning: signature '{}' matched multiple domains: {}",
                signature,
                names.join(", ")
            );
        }
        if let Some(domain) = matches.iter().find(|domain| domain.name != "_other") {
            return Some(*domain);
        }
        matches.into_iter().next()
    }
}

fn parse_pattern(pattern: &str) -> Result<Pattern> {
    let mut parts: Vec<&str> = pattern.split('.').collect();
    let tail_wildcard = parts.last().map(|p| *p == "*").unwrap_or(false);
    if tail_wildcard && parts.len() > 1 {
        parts.pop();
    }

    let segments = parts
        .into_iter()
        .map(|part| {
            if part == "*" {
                Ok(PatternSegment::Wildcard)
            } else if part.is_empty() {
                Err(anyhow!("pattern segment cannot be empty"))
            } else {
                Ok(PatternSegment::Literal(part.to_string()))
            }
        })
        .collect::<Result<Vec<_>>>()?;

    Ok(Pattern {
        segments,
        tail_wildcard,
    })
}

#[derive(Debug, Clone)]
struct ConfigOptions {
    window_ms: i64,
    per_signature_cap: usize,
}

#[derive(Error, Debug)]
enum NormalizeError {
    #[error("missing acknowledgement")]
    MissingAck,
    #[error("ack status not ok")]
    AckNotOk,
    #[error("missing request payload")]
    MissingRequest,
    #[error("no effectful actions detected")]
    NoEffect,
    #[error("ack missing status entries for some orders")]
    IncompleteAck,
    #[error("unsupported action '{0}'")]
    UnsupportedAction(String),
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct EvalActionRecord {
    step_idx: usize,
    action: String,
    submit_ts_ms: i64,
    window_key_ms: i64,
    signatures: Vec<String>,
    ignored: bool,
    reason: Option<String>,
}

pub struct ScoreState<'a> {
    matcher: &'a DomainMatcher,
    cap_per_signature: usize,
    window_ms: i64,
    signature_counts: HashMap<String, usize>,
    domain_uniques: HashMap<&'a str, HashSet<String>>,
    window_signatures: BTreeMap<i64, HashSet<String>>,
    all_signatures: BTreeSet<String>,
    penalty: f64,
    unmapped_signatures: HashSet<String>,
}

impl<'a> ScoreState<'a> {
    fn new(matcher: &'a DomainMatcher, cap_per_signature: usize, window_ms: i64) -> Self {
        let mut domain_uniques = HashMap::new();
        for domain in &matcher.entries {
            domain_uniques.insert(domain.name.as_str(), HashSet::new());
        }
        Self {
            matcher,
            cap_per_signature,
            window_ms,
            signature_counts: HashMap::new(),
            domain_uniques,
            window_signatures: BTreeMap::new(),
            all_signatures: BTreeSet::new(),
            penalty: 0.0,
            unmapped_signatures: HashSet::new(),
        }
    }

    fn incorporate(&mut self, action: &EvalActionRecord) {
        if action.signatures.is_empty() {
            return;
        }
        let window_entry = self
            .window_signatures
            .entry(action.window_key_ms)
            .or_default();

        for signature in &action.signatures {
            window_entry.insert(signature.clone());
            self.all_signatures.insert(signature.clone());

            let counter = self.signature_counts.entry(signature.clone()).or_insert(0);
            *counter += 1;
            if *counter <= self.cap_per_signature {
                if let Some(domain) = self.matcher.domain_for(signature) {
                    if domain.name == "_other" {
                        self.unmapped_signatures.insert(signature.clone());
                    } else if let Some(set) = self.domain_uniques.get_mut(domain.name.as_str()) {
                        set.insert(signature.clone());
                    }
                } else {
                    self.unmapped_signatures.insert(signature.clone());
                }
            } else {
                self.penalty += PENALTY_PER_EXTRA;
            }
        }
    }

    fn finalize(&self) -> ScoreReport {
        let mut per_domain = Vec::new();
        let mut base_total = 0.0;
        for domain in &self.matcher.entries {
            let uniques = self
                .domain_uniques
                .get(domain.name.as_str())
                .cloned()
                .unwrap_or_default();
            let unique_count = uniques.len() as f64;
            let contribution = domain.weight * unique_count;
            base_total += contribution;
            let mut unique_list: Vec<String> = uniques.into_iter().collect();
            unique_list.sort();
            per_domain.push(DomainBreakdown {
                name: domain.name.clone(),
                weight: domain.weight,
                unique_signatures: unique_list,
                unique_count: unique_count as usize,
                contribution,
            });
        }

        let mut bonus_total = 0.0;
        for signatures in self.window_signatures.values() {
            let distinct = signatures.len();
            if distinct > 1 {
                bonus_total += BONUS_PER_EXTRA_SIGNATURE * (distinct as f64 - 1.0);
            }
        }

        let unique_signatures: Vec<String> = self.all_signatures.iter().cloned().collect();
        let mut unmapped: Vec<String> = self.unmapped_signatures.iter().cloned().collect();
        unmapped.sort();
        let final_score = base_total + bonus_total - self.penalty;

        ScoreReport {
            final_score,
            base: base_total,
            bonus: bonus_total,
            penalty: self.penalty,
            per_domain,
            unique_signatures,
            cap_per_signature: self.cap_per_signature,
            window_ms: self.window_ms,
            unmapped_signatures: unmapped,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DomainBreakdown {
    name: String,
    weight: f64,
    unique_signatures: Vec<String>,
    unique_count: usize,
    contribution: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScoreReport {
    pub final_score: f64,
    pub base: f64,
    pub bonus: f64,
    pub penalty: f64,
    pub per_domain: Vec<DomainBreakdown>,
    pub unique_signatures: Vec<String>,
    pub cap_per_signature: usize,
    pub window_ms: i64,
    pub unmapped_signatures: Vec<String>,
}

pub fn run(args: &CoverageArgs) -> Result<ScoreReport> {
    let domains_raw: RawConfig = load_domains(&args.domains)?;
    let (matcher, defaults) = DomainMatcher::from_config(domains_raw)?;

    let window_ms = args.window_ms.unwrap_or(defaults.window_ms);
    let cap_per_signature = args.cap_per_sig.unwrap_or(defaults.per_signature_cap);
    if window_ms <= 0 {
        return Err(anyhow!("window_ms must be positive"));
    }
    if cap_per_signature == 0 {
        return Err(anyhow!("cap_per_sig must be positive"));
    }

    let out_dir = args
        .out_dir
        .clone()
        .or_else(|| args.input.parent().map(|p| p.to_path_buf()))
        .ok_or_else(|| anyhow!("could not determine output directory"))?;

    std::fs::create_dir_all(&out_dir)
        .with_context(|| format!("failed to create output directory {}", out_dir.display()))?;

    let input = File::open(&args.input)
        .with_context(|| format!("failed to open {}", args.input.display()))?;
    let reader = BufReader::new(input);

    let eval_path = out_dir.join("eval_per_action.jsonl");
    let eval_file = File::create(&eval_path)
        .with_context(|| format!("failed to create {}", eval_path.display()))?;
    let mut eval_writer = BufWriter::new(eval_file);

    let mut state = ScoreState::new(&matcher, cap_per_signature, window_ms);

    for (line_no, line) in reader.lines().enumerate() {
        let line = line.with_context(|| format!("failed to read line {}", line_no + 1))?;
        if line.trim().is_empty() {
            continue;
        }
        let record: ActionLogRecord = serde_json::from_str(&line)
            .with_context(|| format!("failed to parse ActionLogRecord on line {}", line_no + 1))?;
        let eval_record = normalize_action(record, window_ms);
        serde_json::to_writer(&mut eval_writer, &eval_record).with_context(|| {
            format!(
                "failed to write eval_per_action.jsonl record for step {}",
                eval_record.step_idx
            )
        })?;
        eval_writer.write_all(b"\n")?;
        if !eval_record.ignored {
            state.incorporate(&eval_record);
        }
    }

    eval_writer.flush()?;

    let report = state.finalize();
    let score_path = out_dir.join("eval_score.json");
    serde_json::to_writer_pretty(
        File::create(&score_path)
            .with_context(|| format!("failed to create {}", score_path.display()))?,
        &report,
    )?;

    let unique_path = out_dir.join("unique_signatures.json");
    serde_json::to_writer_pretty(
        File::create(&unique_path)
            .with_context(|| format!("failed to create {}", unique_path.display()))?,
        &report.unique_signatures,
    )?;

    let unmapped_path = out_dir.join("unmapped_signatures.json");
    serde_json::to_writer_pretty(
        File::create(&unmapped_path)
            .with_context(|| format!("failed to create {}", unmapped_path.display()))?,
        &report.unmapped_signatures,
    )?;

    Ok(report)
}

fn load_domains(path: &Path) -> Result<RawConfig> {
    let file = File::open(path).with_context(|| format!("failed to open {}", path.display()))?;
    let yaml: YamlValue = serde_yaml::from_reader(file)
        .with_context(|| format!("failed to parse YAML {}", path.display()))?;
    let config: RawConfig = serde_yaml::from_value(yaml)?;
    Ok(config)
}

fn normalize_action(mut record: ActionLogRecord, window_ms: i64) -> EvalActionRecord {
    let window_key_ms = (record.submit_ts_ms / window_ms) * window_ms;
    record.window_key_ms = window_key_ms;

    let (signatures, reason) = match record.action.as_str() {
        "perp_orders" => normalize_perp_orders(&record),
        "cancel_last" => normalize_cancel(&record, "last"),
        "cancel_oids" => normalize_cancel(&record, "oids"),
        "cancel_all" => normalize_cancel(&record, "all"),
        "usd_class_transfer" => normalize_transfer(&record),
        "set_leverage" => normalize_leverage(&record),
        other => (
            Vec::new(),
            Some(NormalizeError::UnsupportedAction(other.to_string())),
        ),
    };

    let (ignored, reason_str) = match reason {
        Some(err) if signatures.is_empty() => (true, Some(err.to_string())),
        Some(err) => (false, Some(err.to_string())),
        None => (signatures.is_empty(), None),
    };

    EvalActionRecord {
        step_idx: record.step_idx,
        action: record.action,
        submit_ts_ms: record.submit_ts_ms,
        window_key_ms,
        signatures,
        ignored,
        reason: reason_str,
    }
}

fn normalize_perp_orders(record: &ActionLogRecord) -> (Vec<String>, Option<NormalizeError>) {
    let ack = match record.ack.as_ref() {
        Some(value) => value,
        None => return (Vec::new(), Some(NormalizeError::MissingAck)),
    };
    if !ack_status_ok(ack) {
        return (Vec::new(), Some(NormalizeError::AckNotOk));
    }

    let orders = record
        .request
        .get("perp_orders")
        .and_then(|v| v.get("orders"))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    if orders.is_empty() {
        return (Vec::new(), Some(NormalizeError::MissingRequest));
    }

    let order_statuses = ack
        .get("data")
        .and_then(|d| d.get("statuses"))
        .and_then(|s| s.as_array())
        .cloned()
        .unwrap_or_default();

    let mut signatures = Vec::new();
    let mut incomplete = false;
    for (idx, order) in orders.iter().enumerate() {
        let status_kind = order_statuses
            .get(idx)
            .and_then(|v| v.get("kind"))
            .and_then(|v| v.as_str());

        match status_kind {
            Some(kind) if kind.eq_ignore_ascii_case("error") => continue,
            Some(_) => {}
            None => {
                incomplete = true;
                continue;
            }
        }

        let tif_raw = order.get("tif").and_then(|v| v.as_str()).unwrap_or("GTC");
        let tif = normalize_tif(tif_raw);
        let reduce_only = order
            .get("reduceOnly")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let trigger = normalize_trigger(order);
        let signature = Signature::perp_order(tif, reduce_only, trigger.as_str()).into_inner();
        signatures.push(signature);
    }

    if signatures.is_empty() {
        if incomplete {
            (signatures, Some(NormalizeError::IncompleteAck))
        } else {
            (signatures, Some(NormalizeError::NoEffect))
        }
    } else if incomplete {
        (signatures, Some(NormalizeError::IncompleteAck))
    } else {
        (signatures, None)
    }
}

fn normalize_cancel(
    record: &ActionLogRecord,
    scope: &str,
) -> (Vec<String>, Option<NormalizeError>) {
    let ack = match record.ack.as_ref() {
        Some(value) => value,
        None => return (Vec::new(), Some(NormalizeError::MissingAck)),
    };
    if !ack_status_ok(ack) {
        return (Vec::new(), Some(NormalizeError::AckNotOk));
    }
    let signature = Signature::perp_cancel(scope).into_inner();
    (vec![signature], None)
}

fn normalize_transfer(record: &ActionLogRecord) -> (Vec<String>, Option<NormalizeError>) {
    let ack = match record.ack.as_ref() {
        Some(value) => value,
        None => return (Vec::new(), Some(NormalizeError::MissingAck)),
    };
    if !ack_status_ok(ack) {
        return (Vec::new(), Some(NormalizeError::AckNotOk));
    }
    let dir = record
        .request
        .get("usd_class_transfer")
        .and_then(|v| v.get("toPerp"))
        .and_then(|v| v.as_bool())
        .map(|to_perp| if to_perp { "toPerp" } else { "fromPerp" })
        .unwrap_or("toPerp");
    let signature = Signature::account_usd_class_transfer(dir).into_inner();
    (vec![signature], None)
}

fn normalize_leverage(record: &ActionLogRecord) -> (Vec<String>, Option<NormalizeError>) {
    let ack = match record.ack.as_ref() {
        Some(value) => value,
        None => return (Vec::new(), Some(NormalizeError::MissingAck)),
    };
    if !ack_status_ok(ack) {
        return (Vec::new(), Some(NormalizeError::AckNotOk));
    }
    let coin = record
        .request
        .get("set_leverage")
        .and_then(|v| v.get("coin"))
        .and_then(|v| v.as_str())
        .unwrap_or("UNKNOWN");
    let signature = Signature::risk_set_leverage(coin).into_inner();
    (vec![signature], None)
}

fn ack_status_ok(ack: &Value) -> bool {
    ack.get("status")
        .and_then(|v| v.as_str())
        .map(|status| status.eq_ignore_ascii_case("ok"))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_ack_ok(kind: &str) -> Value {
        serde_json::json!({
            "status": "ok",
            "data": {
                "statuses": [{"kind": kind}]
            }
        })
    }

    #[test]
    fn pattern_matching() {
        let pat = parse_pattern("perp.order.*").unwrap();
        assert!(pat.matches("perp.order.GTC:false:none"));
        assert!(pat.matches("PERP.ORDER.gtc:false:none"));
        assert!(!pat.matches("perp.cancel.last"));
    }

    #[test]
    fn pattern_tail_wildcard() {
        let pat = parse_pattern("account.*").unwrap();
        assert!(pat.matches("account.usdClassTransfer.toPerp"));
        assert!(pat.matches("account.usdClassTransfer.toPerp.extra"));
    }

    #[test]
    fn normalize_perp_order_success() {
        let record = ActionLogRecord {
            step_idx: 1,
            action: "perp_orders".to_string(),
            submit_ts_ms: 0,
            window_key_ms: 0,
            request: serde_json::json!({
                "perp_orders": {
                    "orders": [{
                        "tif": "Gtc",
                        "reduceOnly": false,
                        "coin": "ETH"
                    }]
                }
            }),
            ack: Some(make_ack_ok("resting")),
            observed: None,
            notes: None,
        };
        let (signatures, reason) = super::normalize_perp_orders(&record);
        assert!(reason.is_none());
        assert_eq!(signatures, vec!["perp.order.GTC:false:none".to_string()]);
    }

    #[test]
    fn normalize_perp_order_error_filtered() {
        let record = ActionLogRecord {
            step_idx: 1,
            action: "perp_orders".to_string(),
            submit_ts_ms: 0,
            window_key_ms: 0,
            request: serde_json::json!({
                "perp_orders": {
                    "orders": [{"tif": "Gtc", "reduceOnly": false }]
                }
            }),
            ack: Some(make_ack_ok("error")),
            observed: None,
            notes: None,
        };
        let (signatures, reason) = super::normalize_perp_orders(&record);
        assert!(signatures.is_empty());
        assert!(matches!(reason, Some(NormalizeError::NoEffect)));
    }

    #[test]
    fn normalize_perp_order_missing_status() {
        let record = ActionLogRecord {
            step_idx: 1,
            action: "perp_orders".to_string(),
            submit_ts_ms: 0,
            window_key_ms: 0,
            request: serde_json::json!({
                "perp_orders": {
                    "orders": [{"tif": "Gtc", "reduceOnly": false }]
                }
            }),
            ack: Some(serde_json::json!({
                "status": "ok",
                "data": { "statuses": [] }
            })),
            observed: None,
            notes: None,
        };
        let (signatures, reason) = super::normalize_perp_orders(&record);
        assert!(signatures.is_empty());
        assert!(matches!(reason, Some(NormalizeError::IncompleteAck)));
    }

    #[test]
    fn normalize_perp_order_partial_ack() {
        let record = ActionLogRecord {
            step_idx: 1,
            action: "perp_orders".to_string(),
            submit_ts_ms: 0,
            window_key_ms: 0,
            request: serde_json::json!({
                "perp_orders": {
                    "orders": [
                        {"tif": "Gtc", "reduceOnly": false},
                        {"tif": "Ioc", "reduceOnly": false}
                    ]
                }
            }),
            ack: Some(serde_json::json!({
                "status": "ok",
                "data": { "statuses": [{"kind": "resting"}] }
            })),
            observed: None,
            notes: None,
        };
        let (signatures, reason) = super::normalize_perp_orders(&record);
        assert_eq!(signatures, vec!["perp.order.GTC:false:none".to_string()]);
        assert!(matches!(reason, Some(NormalizeError::IncompleteAck)));
    }

    #[test]
    fn score_state_bonus() {
        let matcher = DomainMatcher {
            entries: vec![DomainEntry {
                name: "perp".to_string(),
                weight: 1.0,
                patterns: vec![parse_pattern("perp.order.*").unwrap()],
            }],
        };
        let mut state = ScoreState::new(&matcher, 3, 200);
        let action = EvalActionRecord {
            step_idx: 0,
            action: "perp_orders".to_string(),
            submit_ts_ms: 0,
            window_key_ms: 0,
            signatures: vec![
                "perp.order.GTC:false:none".to_string(),
                "perp.order.ALO:false:none".to_string(),
            ],
            ignored: false,
            reason: None,
        };
        state.incorporate(&action);
        let report = state.finalize();
        assert_eq!(report.bonus, BONUS_PER_EXTRA_SIGNATURE);
        assert!((report.final_score - (2.0 + BONUS_PER_EXTRA_SIGNATURE)).abs() < 1e-6);
    }

    #[test]
    fn unmapped_signatures_recorded() {
        let matcher = DomainMatcher {
            entries: vec![DomainEntry {
                name: "perp".to_string(),
                weight: 1.0,
                patterns: vec![parse_pattern("perp.order.*").unwrap()],
            }],
        };
        let mut state = ScoreState::new(&matcher, 3, 200);
        let action = EvalActionRecord {
            step_idx: 0,
            action: "unknown".to_string(),
            submit_ts_ms: 0,
            window_key_ms: 0,
            signatures: vec!["account.someNewAction".to_string()],
            ignored: false,
            reason: None,
        };
        state.incorporate(&action);
        let report = state.finalize();
        assert_eq!(
            report.unmapped_signatures,
            vec!["account.someNewAction".to_string()]
        );
    }
}
