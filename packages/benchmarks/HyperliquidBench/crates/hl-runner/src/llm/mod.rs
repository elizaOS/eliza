mod openrouter;
mod plan_decode;
mod prompts;

use std::{
    env,
    fs::{self, File},
    path::PathBuf,
};

use anyhow::{anyhow, Context, Result};
use hl_common::plan::{ActionStep, Plan};
use openrouter::{
    build_cached_payload, cache_filename, hash_prompt, parse_cached_payload, OpenRouter,
    OpenRouterConfig,
};
use prompts::{coverage_prompts, hian_prompts, CoveragePrompt, HianPrompt};
use serde::Serialize;
use serde_json::Value;

const OPENROUTER_ENDPOINT: &str = "https://openrouter.ai/api/v1/chat/completions";
const USER_AGENT: &str = "HyperLiquidBenchRunner/0.1";
const LLM_TITLE: &str = "HyperLiquidBench";
const MAX_ORDER_SIZE: f64 = 1.0;
const MIN_ORDER_SIZE: f64 = 0.0001;
const MAX_LEVERAGE: u32 = 20;

#[derive(Debug)]
pub enum LlmPlanSpec {
    Coverage,
    Hian(PathBuf),
}

impl LlmPlanSpec {
    pub fn parse(spec: &str) -> Option<Self> {
        if let Some(rest) = spec.strip_prefix("llm:") {
            if rest.eq_ignore_ascii_case("coverage") {
                Some(LlmPlanSpec::Coverage)
            } else {
                rest.strip_prefix("hian:")
                    .map(|path| LlmPlanSpec::Hian(PathBuf::from(path)))
            }
        } else {
            None
        }
    }
}

#[derive(Clone)]
pub struct LlmOptions {
    pub api_key: String,
    pub model: String,
    pub temperature: f32,
    pub top_p: f32,
    pub max_output_tokens: u32,
    pub max_steps: u32,
    pub allowed_coins: Vec<String>,
    pub default_builder_code: Option<String>,
    pub cache_dir: Option<PathBuf>,
    pub dry_run: bool,
}

#[derive(Debug, Serialize, Clone)]
pub struct LlmMeta {
    pub model: String,
    pub temperature: f32,
    pub top_p: f32,
    pub max_output_tokens: u32,
    pub max_steps: u32,
    pub allowed_coins: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_builder_code: Option<String>,
    pub prompt_hash: String,
    pub cached: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<openrouter::Usage>,
}

pub struct PlanResult {
    pub plan: Plan,
    pub raw: String,
    pub meta: LlmMeta,
}

pub async fn generate_plan(spec: LlmPlanSpec, opts: &LlmOptions) -> Result<PlanResult> {
    let system_user = match spec {
        LlmPlanSpec::Coverage => {
            let ctx = CoveragePrompt {
                max_steps: opts.max_steps,
                allowed_coins: &opts.allowed_coins,
                builder_code: opts.default_builder_code.as_deref(),
                network: "testnet",
            };
            coverage_prompts(&ctx)
        }
        LlmPlanSpec::Hian(ref path) => {
            let context_text = fs::read_to_string(path)
                .with_context(|| format!("failed to read HiaN context file {}", path.display()))?;
            let ctx = HianPrompt {
                max_steps: opts.max_steps,
                allowed_coins: &opts.allowed_coins,
                builder_code: opts.default_builder_code.as_deref(),
                context: &context_text,
            };
            hian_prompts(&ctx)
        }
    };

    let (system, user) = system_user;
    let prompt_hash = hash_prompt(&opts.model, &system, &user, opts.temperature, opts.top_p);

    let mut was_cached = false;
    let completion = if let Some(ref cache_dir) = opts.cache_dir {
        fs::create_dir_all(cache_dir)
            .with_context(|| format!("failed to create cache directory {}", cache_dir.display()))?;
        let cache_path = cache_dir.join(cache_filename(&prompt_hash));
        if cache_path.exists() {
            was_cached = true;
            let cached_value: Value =
                serde_json::from_reader(File::open(&cache_path).with_context(|| {
                    format!("failed to open cache file {}", cache_path.display())
                })?)
                .context("failed to read cached completion")?;
            parse_cached_payload(cached_value).context("failed to parse cached completion")?
        } else {
            let completion = request_completion(&system, &user, opts).await?;
            let payload = build_cached_payload(&completion.content, completion.usage.as_ref());
            serde_json::to_writer_pretty(
                File::create(&cache_path).with_context(|| {
                    format!("failed to create cache file {}", cache_path.display())
                })?,
                &payload,
            )
            .context("failed to persist cached completion")?;
            completion
        }
    } else {
        request_completion(&system, &user, opts).await?
    };

    let plan = plan_decode::decode_plan(&completion.content, opts.max_steps)?;
    let mut plan = plan;
    sanitize_plan(&mut plan, opts)?;

    let meta = LlmMeta {
        model: opts.model.clone(),
        temperature: opts.temperature,
        top_p: opts.top_p,
        max_output_tokens: opts.max_output_tokens,
        max_steps: opts.max_steps,
        allowed_coins: opts.allowed_coins.clone(),
        default_builder_code: opts.default_builder_code.clone(),
        prompt_hash,
        cached: was_cached,
        usage: completion.usage.clone(),
    };

    Ok(PlanResult {
        plan,
        raw: completion.content.trim().to_string(),
        meta,
    })
}

async fn request_completion(
    system: &str,
    user: &str,
    opts: &LlmOptions,
) -> Result<openrouter::Completion> {
    let config = OpenRouterConfig {
        endpoint: OPENROUTER_ENDPOINT.to_string(),
        api_key: opts.api_key.clone(),
        model: opts.model.clone(),
        temperature: opts.temperature,
        top_p: opts.top_p,
        max_tokens: opts.max_output_tokens,
        title: LLM_TITLE.to_string(),
        user_agent: USER_AGENT.to_string(),
    };
    let client = OpenRouter::new(config)?;
    client.complete(system, user).await
}

fn sanitize_plan(plan: &mut Plan, opts: &LlmOptions) -> Result<()> {
    for step in &mut plan.steps {
        match step {
            ActionStep::PerpOrders { perp_orders } => {
                if perp_orders.builder_code.is_none() {
                    if let Some(default) = opts.default_builder_code.as_ref() {
                        perp_orders.builder_code = Some(default.clone());
                    }
                }
                for order in &mut perp_orders.orders {
                    if order.sz <= 0.0 {
                        return Err(anyhow!("order size must be positive"));
                    }
                    if order.sz > MAX_ORDER_SIZE || order.sz < MIN_ORDER_SIZE {
                        return Err(anyhow!(
                            "order size {} must be between {} and {}",
                            order.sz,
                            MIN_ORDER_SIZE,
                            MAX_ORDER_SIZE
                        ));
                    }
                    if let Some(default) = opts.default_builder_code.as_ref() {
                        if order.builder_code.is_none() {
                            order.builder_code = Some(default.clone());
                        }
                    }
                    order.trigger = None;
                    if !opts
                        .allowed_coins
                        .iter()
                        .any(|coin| coin.eq_ignore_ascii_case(&order.coin))
                    {
                        return Err(anyhow!("coin {} not allowed", order.coin));
                    }
                    order.coin = order.coin.to_uppercase();
                }
            }
            ActionStep::SetLeverage { set_leverage } => {
                if set_leverage.leverage == 0 || set_leverage.leverage > MAX_LEVERAGE {
                    return Err(anyhow!(
                        "leverage {} must be between 1 and {}",
                        set_leverage.leverage,
                        MAX_LEVERAGE
                    ));
                }
            }
            _ => {}
        }
    }
    Ok(())
}

pub fn parse_allowed_coins(raw: &str) -> Vec<String> {
    raw.split(',')
        .filter_map(|part| {
            let trimmed = part.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_ascii_uppercase())
            }
        })
        .collect()
}

pub fn discover_cache_dir() -> Option<PathBuf> {
    env::var_os("HL_LLM_CACHE_DIR").map(PathBuf::from)
}

pub fn dry_run_enabled() -> bool {
    env::var("HL_LLM_DRYRUN").is_ok()
}
