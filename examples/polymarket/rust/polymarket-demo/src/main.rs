use anyhow::Result;
use elizaos_plugin_evm::providers::wallet::{WalletProvider, WalletProviderConfig};
use elizaos_plugin_evm::types::SupportedChain;
use elizaos_plugin_polymarket::client::ClobClient;
use rust_decimal::prelude::FromPrimitive;
use rust_decimal::Decimal;

use polymarket_demo::load_env_config;

#[derive(Debug, Clone)]
struct Options {
    command: String,
    network: bool,
    execute: bool,
    iterations: u64,
    interval_ms: u64,
    order_size: f64,
    max_pages: u64,
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
            "",
            "Env:",
            "  EVM_PRIVATE_KEY (or POLYMARKET_PRIVATE_KEY)",
            "  CLOB_API_URL (optional; default https://clob.polymarket.com)",
            "  CLOB_API_KEY/CLOB_API_SECRET/CLOB_API_PASSPHRASE (required for --execute)",
        ]
        .join("\n")
    );
}

async fn verify(opts: &Options) -> Result<()> {
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
    println!("✅ execute enabled: {}", opts.execute);
    println!("✅ creds present: {}", cfg.creds.is_some());

    if opts.network {
        let resp = poly_client.get_markets(None).await?;
        println!("🌐 network ok: fetched markets = {}", resp.data.len());
    }

    Ok(())
}

async fn pick_first_active_market(
    client: &ClobClient,
    max_pages: u64,
) -> Result<(String, String, f64)> {
    let mut cursor: Option<String> = None;
    for _ in 0..max_pages {
        let resp = client.get_markets(cursor.as_deref()).await?;
        let next_cursor = resp.next_cursor.clone();
        for m in resp.data {
            if !m.active || m.closed {
                continue;
            }
            let token_id = m
                .tokens
                .get(0)
                .map(|t| t.token_id.clone())
                .unwrap_or_default();
            if token_id.trim().is_empty() {
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
            return Ok((token_id, label, tick));
        }
        cursor = if next_cursor.trim().is_empty() {
            None
        } else {
            Some(next_cursor)
        };
    }
    anyhow::bail!("No active market found");
}

async fn once(opts: &Options) -> Result<()> {
    if !opts.network {
        anyhow::bail!("The 'once' command requires --network (it fetches markets + order book).");
    }

    let cfg = load_env_config(opts.execute)?;
    std::env::set_var("EVM_PRIVATE_KEY", &cfg.private_key);
    std::env::set_var("POLYMARKET_PRIVATE_KEY", &cfg.private_key);
    std::env::set_var("CLOB_API_URL", &cfg.clob_api_url);

    let public = ClobClient::new(Some(&cfg.clob_api_url), &cfg.private_key).await?;
    let (token_id, label, tick) = pick_first_active_market(&public, opts.max_pages).await?;

    let book = public.get_order_book(&token_id).await?;
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

