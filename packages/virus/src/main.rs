mod agent;
mod memory;
mod model;
mod shell;
mod system;

const IDLE_THRESHOLD_SECS: u64 = 120;
const STEP_INTERVAL_SECS: u64 = 30;

#[tokio::main]
async fn main() {
    eprintln!("virus.exe v{}", env!("CARGO_PKG_VERSION"));
    eprintln!("an autonomous eliza agent");
    eprintln!();

    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(|s| s.as_str()) {
        Some("--install") => {
            eprintln!("[virus] this will register virus.exe to run automatically on every login.");
            eprintln!("[virus] it will execute read-only shell commands while you are idle.");
            eprintln!("[virus] to remove: virus.exe --uninstall");
            eprintln!();
            eprint!("[virus] proceed? (y/N): ");
            let mut input = String::new();
            if std::io::stdin().read_line(&mut input).is_ok() && input.trim().eq_ignore_ascii_case("y") {
                match system::install_autostart() {
                    Ok(()) => {
                        eprintln!("[virus] installed to run on startup");
                        eprintln!("[virus] remove anytime with: virus.exe --uninstall");
                    }
                    Err(e) => eprintln!("[virus] install failed: {}", e),
                }
            } else {
                eprintln!("[virus] cancelled");
            }
            return;
        }
        Some("--uninstall") => {
            match system::uninstall_autostart() {
                Ok(()) => eprintln!("[virus] removed from startup"),
                Err(e) => eprintln!("[virus] uninstall failed: {}", e),
            }
            return;
        }
        Some("--help") | Some("-h") => {
            eprintln!("usage: virus.exe [OPTIONS]");
            eprintln!();
            eprintln!("  (no args)     run the autonomous agent");
            eprintln!("  --install     register to run on login (with confirmation)");
            eprintln!("  --uninstall   remove from login startup");
            eprintln!("  --help        show this message");
            return;
        }
        _ => {}
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

    eprintln!(
        "[virus] ready. waiting for human to go idle ({}s threshold)...",
        IDLE_THRESHOLD_SECS
    );
    eprintln!();

    loop {
        let idle = system::idle_seconds();

        if idle >= IDLE_THRESHOLD_SECS {
            agent::step(model_name).await;
            tokio::time::sleep(std::time::Duration::from_secs(STEP_INTERVAL_SECS)).await;
        } else {
            tokio::time::sleep(std::time::Duration::from_secs(10)).await;
        }
    }
}
