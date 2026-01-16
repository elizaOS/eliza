//! Benchmark context provider.

use async_trait::async_trait;

use crate::error::PluginResult;
use crate::runtime::IAgentRuntime;
use crate::types::{Memory, ProviderResult, State};

use super::Provider;

pub struct ContextBenchProvider;

#[async_trait]
impl Provider for ContextBenchProvider {
    fn name(&self) -> &'static str {
        "CONTEXT_BENCH"
    }

    fn description(&self) -> &'static str {
        "Benchmark/task context injected by a benchmark harness"
    }

    fn is_dynamic(&self) -> bool {
        true
    }

    async fn get(
        &self,
        _runtime: &dyn IAgentRuntime,
        message: &Memory,
        _state: Option<&State>,
    ) -> PluginResult<ProviderResult> {
        let mut bench_ctx: Option<String> = None;
        if let Some(meta) = &message.metadata {
            if let crate::types::memory::MemoryMetadata::Custom(v) = meta {
                if let Some(obj) = v.as_object() {
                    if let Some(s) = obj.get("benchmarkContext").and_then(|x| x.as_str()) {
                        if !s.trim().is_empty() {
                            bench_ctx = Some(s.trim().to_string());
                        }
                    }
                }
            }
        }

        if let Some(ctx) = bench_ctx {
            Ok(ProviderResult {
                text: Some(format!("# Benchmark Context\n{}", ctx)),
                values: Some(
                    [(
                        "benchmark_has_context".to_string(),
                        serde_json::Value::Bool(true),
                    )]
                    .into_iter()
                    .collect(),
                ),
                data: Some(
                    [(
                        "benchmarkContext".to_string(),
                        serde_json::Value::String(ctx),
                    )]
                    .into_iter()
                    .collect(),
                ),
            })
        } else {
            Ok(ProviderResult {
                text: None,
                values: Some(
                    [(
                        "benchmark_has_context".to_string(),
                        serde_json::Value::Bool(false),
                    )]
                    .into_iter()
                    .collect(),
                ),
                data: None,
            })
        }
    }
}
