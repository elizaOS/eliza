use std::{
    fs::{self, File},
    io::{BufWriter, Write},
    path::{Path, PathBuf},
};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::time::window_start_ms;

const DEFAULT_WINDOW_MS: i64 = 200;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionLogRecord {
    pub step_idx: usize,
    pub action: String,
    pub submit_ts_ms: i64,
    pub window_key_ms: i64,
    pub request: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ack: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub observed: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutedOrderRecord {
    pub ts_ms: i64,
    pub oid: Option<u64>,
    pub coin: String,
    pub side: String,
    pub px: f64,
    pub sz: f64,
    pub tif: String,
    pub reduce_only: bool,
    pub builder_code: Option<String>,
}

pub struct RunArtifacts {
    per_action: BufWriter<File>,
    ws_stream: BufWriter<File>,
    routed_csv: csv::Writer<File>,
    window_ms: i64,
    per_action_path: PathBuf,
    ws_stream_path: PathBuf,
    meta_path: PathBuf,
}

impl RunArtifacts {
    pub fn create<P: AsRef<Path>>(
        out_dir: P,
        plan: &Value,
        plan_raw: Option<&str>,
        window_ms: Option<i64>,
    ) -> Result<Self> {
        let out_dir = out_dir.as_ref();
        fs::create_dir_all(out_dir)
            .with_context(|| format!("failed to create run directory {}", out_dir.display()))?;

        let per_action_path = out_dir.join("per_action.jsonl");
        let ws_stream_path = out_dir.join("ws_stream.jsonl");
        let routed_path = out_dir.join("orders_routed.csv");
        let meta_path = out_dir.join("run_meta.json");
        let plan_path = out_dir.join("plan.json");
        let plan_raw_path = plan_raw.map(|_| out_dir.join("plan_raw.txt"));

        let per_action = BufWriter::new(
            File::create(&per_action_path)
                .with_context(|| format!("failed to create {}", per_action_path.display()))?,
        );
        let ws_stream = BufWriter::new(
            File::create(&ws_stream_path)
                .with_context(|| format!("failed to create {}", ws_stream_path.display()))?,
        );
        let routed_file = File::create(&routed_path)
            .with_context(|| format!("failed to create {}", routed_path.display()))?;
        let mut routed_csv = csv::Writer::from_writer(routed_file);
        routed_csv.write_record([
            "ts",
            "oid",
            "coin",
            "side",
            "px",
            "sz",
            "tif",
            "reduceOnly",
            "builderCode",
        ])?;

        let plan_writer = File::create(&plan_path)
            .with_context(|| format!("failed to create {}", plan_path.display()))?;
        serde_json::to_writer_pretty(plan_writer, plan)
            .with_context(|| format!("failed to write plan json {}", plan_path.display()))?;

        if let (Some(raw), Some(raw_path)) = (plan_raw, plan_raw_path.as_ref()) {
            let mut writer = BufWriter::new(
                File::create(raw_path)
                    .with_context(|| format!("failed to create {}", raw_path.display()))?,
            );
            writer.write_all(raw.as_bytes())?;
        }

        Ok(Self {
            per_action,
            ws_stream,
            routed_csv,
            window_ms: window_ms.unwrap_or(DEFAULT_WINDOW_MS),
            per_action_path,
            ws_stream_path,
            meta_path,
        })
    }

    pub fn log_action(&mut self, record: &ActionLogRecord) -> Result<()> {
        serde_json::to_writer(&mut self.per_action, record).with_context(|| {
            format!(
                "failed to write action log to {}",
                self.per_action_path.display()
            )
        })?;
        self.per_action.write_all(b"\n")?;
        self.per_action.flush()?;
        Ok(())
    }

    pub fn log_ws_event(&mut self, raw: &Value) -> Result<()> {
        serde_json::to_writer(&mut self.ws_stream, raw).with_context(|| {
            format!(
                "failed to write ws event to {}",
                self.ws_stream_path.display()
            )
        })?;
        self.ws_stream.write_all(b"\n")?;
        Ok(())
    }

    pub fn log_routed_order(&mut self, record: &RoutedOrderRecord) -> Result<()> {
        self.routed_csv.serialize(record)?;
        self.routed_csv.flush()?;
        Ok(())
    }

    pub fn write_meta(&self, meta: &Value) -> Result<()> {
        let meta_file = File::create(&self.meta_path)
            .with_context(|| format!("failed to create {}", self.meta_path.display()))?;
        let mut writer = BufWriter::new(meta_file);
        serde_json::to_writer_pretty(&mut writer, meta)
            .with_context(|| format!("failed to write meta to {}", self.meta_path.display()))?;
        writer.write_all(b"\n")?;
        writer.flush()?;
        Ok(())
    }

    pub fn window_ms(&self) -> i64 {
        self.window_ms
    }

    #[allow(clippy::too_many_arguments)]
    pub fn make_action_record(
        &self,
        step_idx: usize,
        action: impl Into<String>,
        submit_ts_ms: i64,
        request: Value,
        ack: Option<Value>,
        observed: Option<Value>,
        notes: Option<String>,
    ) -> ActionLogRecord {
        let window_key_ms = window_start_ms(submit_ts_ms, self.window_ms);
        ActionLogRecord {
            step_idx,
            action: action.into(),
            submit_ts_ms,
            window_key_ms,
            request,
            ack,
            observed,
            notes,
        }
    }
}

impl Drop for RunArtifacts {
    fn drop(&mut self) {
        let _ = self.per_action.flush();
        let _ = self.ws_stream.flush();
        let _ = self.routed_csv.flush();
    }
}
