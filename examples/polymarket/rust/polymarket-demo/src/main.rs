use anyhow::Result;
use elizaos_plugin_evm::providers::wallet::{WalletProvider, WalletProviderConfig};
use elizaos_plugin_evm::types::SupportedChain;
use elizaos_plugin_polymarket::client::ClobClient;
use elizaos_plugin_polymarket::types::OrderBook;
use rust_decimal::prelude::FromPrimitive;
use rust_decimal::Decimal;
use serde::Deserialize;
use serde_json::Value;

use polymarket_demo::load_env_config;

const GAMMA_PAGE_LIMIT: usize = 100;

#[derive(Debug, Clone)]
struct Options {
    command: String,
    network: bool,
    execute: bool,
    iterations: u64,
    interval_ms: u64,
    order_size: f64,
    max_pages: u64,
    private_key: Option<String>,
    clob_api_url: Option<String>,
}

fn parse_args() -> Options {
    let mut args = std::env::args().skip(1);
    let command = args.next().unwrap_or_else(|| "help".to_string());

    let mut network = false;
    let mut execute = false;
    let mut iterations = 10u64;
    let mut interval_ms = 30_000u64;
    let mut order_size = 1.0f64;
    let mut max_pages = 1u64;
    let mut private_key: Option<String> = None;
    let mut clob_api_url: Option<String> = None;

    let rest: Vec<String> = args.collect();
    let mut i = 0usize;
    while i < rest.len() {
        match rest[i].as_str() {
            "--network" => network = true,
            "--execute" => execute = true,
            "--iterations" => {
                if let Some(v) = rest.get(i + 1).and_then(|s| s.parse::<u64>().ok()) {
                    iterations = v.max(1);
                    i += 1;
                }
            }
            "--interval-ms" => {
                if let Some(v) = rest.get(i + 1).and_then(|s| s.parse::<u64>().ok()) {
                    interval_ms = v.max(1);
                    i += 1;
                }
            }
            "--order-size" => {
                if let Some(v) = rest.get(i + 1).and_then(|s| s.parse::<f64>().ok()) {
                    if v > 0.0 {
                        order_size = v;
                    }
                    i += 1;
                }
            }
            "--max-pages" => {
                if let Some(v) = rest.get(i + 1).and_then(|s| s.parse::<u64>().ok()) {
                    max_pages = v.max(1);
                    i += 1;
                }
            }
            "--private-key" => {
                if let Some(v) = rest.get(i + 1).map(|s| s.trim()).filter(|s| !s.is_empty()) {
                    private_key = Some(v.to_string());
                    i += 1;
                }
            }
            "--clob-api-url" => {
                if let Some(v) = rest.get(i + 1).map(|s| s.trim()).filter(|s| !s.is_empty()) {
                    clob_api_url = Some(v.to_string());
                    i += 1;
                }
            }
            _ => {}
        }
        i += 1;
    }

    Options {
        command,
        network,
        execute,
        iterations,
        interval_ms,
        order_size,
        max_pages,
        private_key,
        clob_api_url,
    }
}

fn apply_cli_overrides(opts: &Options) {
    if let Some(key) = &opts.private_key {
        std::env::set_var("EVM_PRIVATE_KEY", key);
        std::env::set_var("POLYMARKET_PRIVATE_KEY", key);
    }
    if let Some(url) = &opts.clob_api_url {
        std::env::set_var("CLOB_API_URL", url);
    }
}

fn usage() {
    println!(
        "{}",
        [
            "polymarket-demo (Rust)",
            "",
            "Commands:",
            "  verify                 Validate config and wallet derivation (offline unless --network)",
            "  once --network         One market tick (dry-run unless --execute)",
            "  run --network          Loop market ticks",
            "",
            "Flags:",
            "  --network              Perform network calls (CLOB API)",
            "  --execute              Place orders (requires CLOB API creds)",
            "  --interval-ms <n>      Loop delay for `run` (default 30000)",
            "  --iterations <n>       Loop count for `run` (default 10)",
            "  --order-size <n>       Order size in shares (default 1)",
            "  --max-pages <n>        Pages to scan for an active market (default 1)",
            "  --private-key <hex>    Private key (overrides env vars; accepts with/without 0x)",
            "  --clob-api-url <url>   CLOB API URL (overrides env var)",
            "",
            "Env:",
            "  EVM_PRIVATE_KEY (or POLYMARKET_PRIVATE_KEY)",
            "  CLOB_API_URL (optional; default https://clob.polymarket.com)",
            "  GAMMA_API_URL (optional; default https://gamma-api.polymarket.com)",
            "  CLOB_API_KEY/CLOB_API_SECRET/CLOB_API_PASSPHRASE (required for --execute)",
        ]
        .join("\n")
    );
}

async fn verify(opts: &Options) -> Result<()> {
    apply_cli_overrides(opts);
    let cfg = load_env_config(opts.execute)?;
    std::env::set_var("EVM_PRIVATE_KEY", &cfg.private_key);
    std::env::set_var("POLYMARKET_PRIVATE_KEY", &cfg.private_key);
    std::env::set_var("CLOB_API_URL", &cfg.clob_api_url);

    let wallet = WalletProvider::new(
        WalletProviderConfig::new(cfg.private_key.clone()).with_chain(SupportedChain::Polygon, None),
    )
    .await?;

    let poly_client = ClobClient::new(Some(&cfg.clob_api_url), &cfg.private_key).await?;

    println!("✅ wallet address (plugin-evm):       {}", wallet.address());
    println!("✅ wallet address (plugin-polymarket): {}", poly_client.address());
    println!("✅ clob api url: {}", cfg.clob_api_url);
    println!("✅ gamma api url: {}", cfg.gamma_api_url);
    println!("✅ execute enabled: {}", opts.execute);
    println!("✅ creds present: {}", cfg.creds.is_some());

    if opts.network {
        let resp = poly_client.get_markets(None).await?;
        println!("🌐 network ok: fetched markets = {}", resp.data.len());
    }

    Ok(())
}

#[derive(Debug, Deserialize)]
struct GammaMarket {
    #[serde(default)]
    id: String,
    #[serde(default)]
    question: Option<String>,
    #[serde(default)]
    slug: Option<String>,
    #[serde(default, rename = "conditionId")]
    condition_id: Option<String>,
    #[serde(default, rename = "clobTokenIds")]
    clob_token_ids: Option<Value>,
    #[serde(default, rename = "orderPriceMinTickSize")]
    order_price_min_tick_size: Option<Value>,
}

fn gamma_market_label(market: &GammaMarket) -> String {
    if let Some(q) = market.question.as_deref().filter(|v| !v.trim().is_empty()) {
        return q.to_string();
    }
    if let Some(slug) = market.slug.as_deref().filter(|v| !v.trim().is_empty()) {
        return slug.to_string();
    }
    if let Some(condition_id) = market.condition_id.as_deref().filter(|v| !v.trim().is_empty()) {
        return condition_id.to_string();
    }
    market.id.clone()
}

fn parse_gamma_tick(value: &Option<Value>) -> f64 {
    let Some(value) = value else {
        return 0.001;
    };
    let parsed = if let Some(v) = value.as_f64() {
        Some(v)
    } else if let Some(v) = value.as_str() {
        v.parse::<f64>().ok()
    } else {
        None
    };
    parsed.filter(|v| *v > 0.0).unwrap_or(0.001)
}

fn normalize_gamma_token_ids(raw: &Option<Value>) -> Vec<String> {
    let Some(raw) = raw else {
        return Vec::new();
    };
    if let Some(items) = raw.as_array() {
        return items.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect();
    }
    if let Some(s) = raw.as_str() {
        let parsed: Value = match serde_json::from_str(s) {
            Ok(v) => v,
            Err(_) => return Vec::new(),
        };
        if let Some(items) = parsed.as_array() {
            return items
                .iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect();
        }
    }
    Vec::new()
}

async fn pick_from_gamma_markets(
    client: &ClobClient,
    gamma_api_url: &str,
    max_pages: u64,
) -> Result<Option<(String, String, f64, OrderBook)>> {
    let http = reqwest::Client::new();
    for page in 0..max_pages {
        let offset = page.saturating_mul(GAMMA_PAGE_LIMIT as u64);
        let url = format!(
            "{}/markets?active=true&closed=false&enableOrderBook=true&acceptingOrders=true&limit={}&offset={}",
            gamma_api_url.trim_end_matches('/'),
            GAMMA_PAGE_LIMIT,
            offset
        );
        let resp = match http.get(&url).send().await {
            Ok(resp) => resp,
            Err(_) => continue,
        };
        if !resp.status().is_success() {
            continue;
        }
        let markets: Vec<GammaMarket> = match resp.json().await {
            Ok(markets) => markets,
            Err(_) => continue,
        };
        if markets.is_empty() {
            return Ok(None);
        }

        for market in &markets {
            let label = gamma_market_label(market);
            let tick = parse_gamma_tick(&market.order_price_min_tick_size);
            for token_id in normalize_gamma_token_ids(&market.clob_token_ids) {
                if token_id.trim().is_empty() {
                    continue;
                }
                let book = match client.get_order_book(&token_id).await {
                    Ok(book) => book,
                    Err(_) => continue,
                };
                if !book.bids.is_empty() && !book.asks.is_empty() {
                    return Ok(Some((token_id, label, tick, book)));
                }
            }
        }

        if markets.len() < GAMMA_PAGE_LIMIT {
            return Ok(None);
        }
    }
    Ok(None)
}

async fn pick_first_tradable_market_with_order_book(
    client: &ClobClient,
    gamma_api_url: &str,
    max_pages: u64,
) -> Result<(String, String, f64, OrderBook)> {
    let mut cursor: Option<String> = None;
    for _ in 0..max_pages {
        let resp = client.get_markets(cursor.as_deref()).await?;
        let next_cursor = resp.next_cursor.clone();
        for m in resp.data {
            if !m.active || m.closed {
                continue;
            }
            let label = if !m.question.trim().is_empty() {
                m.question.clone()
            } else {
                m.condition_id.clone()
            };
            let tick = m
                .minimum_tick_size
                .parse::<f64>()
                .ok()
                .filter(|v| *v > 0.0)
                .unwrap_or(0.001);
            for tok in m.tokens {
                if tok.token_id.trim().is_empty() {
                    continue;
                }
                let book = match client.get_order_book(&tok.token_id).await {
                    Ok(book) => book,
                    Err(_) => continue,
                };
                if !book.bids.is_empty() && !book.asks.is_empty() {
                    return Ok((tok.token_id, label, tick, book));
                }
            }
        }
        cursor = if next_cursor.trim().is_empty() {
            None
        } else {
            Some(next_cursor)
        };
    }

    if let Some(result) = pick_from_gamma_markets(client, gamma_api_url, max_pages).await? {
        return Ok(result);
    }
    anyhow::bail!("No tradable market with order book found (try increasing --max-pages or check API).");
}

async fn once(opts: &Options) -> Result<()> {
    if !opts.network {
        anyhow::bail!("The 'once' command requires --network (it fetches markets + order book).");
    }

    apply_cli_overrides(opts);
    let cfg = load_env_config(opts.execute)?;
    std::env::set_var("EVM_PRIVATE_KEY", &cfg.private_key);
    std::env::set_var("POLYMARKET_PRIVATE_KEY", &cfg.private_key);
    std::env::set_var("CLOB_API_URL", &cfg.clob_api_url);

    let public = ClobClient::new(Some(&cfg.clob_api_url), &cfg.private_key).await?;
    let (token_id, label, tick, book) =
        pick_first_tradable_market_with_order_book(&public, &cfg.gamma_api_url, opts.max_pages).await?;
    let best_bid = book.bids.first().and_then(|b| b.price.parse::<f64>().ok());
    let best_ask = book.asks.first().and_then(|a| a.price.parse::<f64>().ok());

    let (Some(best_bid), Some(best_ask)) = (best_bid, best_ask) else {
        println!("No usable bid/ask; skipping: {}", token_id);
        return Ok(());
    };

    let spread = best_ask - best_bid;
    let midpoint = (best_ask + best_bid) / 2.0;
    let price = (midpoint - tick).clamp(0.01, 0.99);

    println!("🎯 market: {}", label);
    println!("🔑 token: {}", token_id);
    println!("📈 bestBid: {:.4} bestAsk: {:.4}", best_bid, best_ask);
    println!("📏 spread: {:.4} midpoint: {:.4}", spread, midpoint);
    println!("🧪 decision: BUY {} at {:.4}", opts.order_size, price);

    if !opts.execute {
        println!("🧊 dry-run: not placing order (pass --execute to place)");
        return Ok(());
    }

    // Rust order placement isn't implemented (EIP-712 + L2 auth missing).
    let _ = Decimal::from_f64(price);
    let _ = Decimal::from_f64(opts.order_size);
    anyhow::bail!("Order placement is not supported in Rust yet. Use the TypeScript or Python demo for --execute.");
}

async fn real_main() -> Result<()> {
    let _ = dotenvy::dotenv();
    let opts = parse_args();

    match opts.command.as_str() {
        "help" => {
            usage();
            Ok(())
        }
        "verify" => verify(&opts).await,
        "once" => once(&opts).await,
        "run" => {
            for i in 0..opts.iterations {
                once(&opts).await?;
                if i + 1 < opts.iterations {
                    tokio::time::sleep(std::time::Duration::from_millis(opts.interval_ms)).await;
                }
            }
            Ok(())
        }
        _ => {
            usage();
            Ok(())
        }
    }
}

#[tokio::main]
async fn main() {
    if let Err(e) = real_main().await {
        eprintln!("{e}");
        std::process::exit(1);
    }
}

