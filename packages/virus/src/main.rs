mod agent;
mod memory;
mod model;
mod shell;
mod system;

const IDLE_THRESHOLD_SECS: u64 = 120; // 2 minutes of no input
const STEP_INTERVAL_SECS: u64 = 30;   // time between agent cycles

#[tokio::main]
async fn main() {
    eprintln!("virus.exe v{}", env!("CARGO_PKG_VERSION"));
    eprintln!("an autonomous eliza agent");
    eprintln!();

    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(|s| s.as_str()) == Some("--install") {
        match system::install_autostart() {
            Ok(()) => {
                eprintln!("[virus] installed to run on startup");
                eprintln!("[virus] you can close this window. i'll be here when you're away.");
            }
            Err(e) => eprintln!("[virus] install failed: {}", e),
        }
        return;
    }

    memory::init();
    memory::thought("waking up");

    let model_name = system::pick_model();
    eprintln!(
        "[virus] {:.1} GB RAM available, picking model: {}",
        system::available_memory_gb(),
        model_name
    );

    eprintln!("[virus] bootstrapping ollama...");
    model::bootstrap(model_name).await;
    memory::thought(&format!("model ready: {}", model_name));

    eprintln!("[virus] ready. waiting for human to go idle ({}s threshold)...", IDLE_THRESHOLD_SECS);
    eprintln!();

    loop {
        let idle = system::idle_seconds();

        if idle >= IDLE_THRESHOLD_SECS {
            agent::step(model_name).await;
            tokio::time::sleep(std::time::Duration::from_secs(STEP_INTERVAL_SECS)).await;
        } else {
            // human is active — sleep a bit and check again
            tokio::time::sleep(std::time::Duration::from_secs(10)).await;
        }
    }
}
