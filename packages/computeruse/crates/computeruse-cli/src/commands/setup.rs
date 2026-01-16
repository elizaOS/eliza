use anyhow::Result;
use clap::Args;
use colored::*;
use std::path::PathBuf;
use std::process::Command as ProcessCommand;
use tracing::debug;

#[derive(Debug, Args)]
pub struct SetupCommand {
    /// Skip Chrome extension installation
    #[arg(long)]
    skip_chrome: bool,

    /// Skip Visual C++ Redistributables check (Windows only)
    #[arg(long)]
    skip_vcredist: bool,

    /// Skip SDK setup (Node.js, Bun, computeruse.js)
    #[arg(long)]
    skip_sdk: bool,

    /// Verbose output
    #[arg(short, long)]
    verbose: bool,
}

impl SetupCommand {
    pub async fn execute(&self) -> Result<()> {
        println!("{}", "🚀 ComputerUse Setup Wizard".bold().cyan());
        println!("{}", "==========================".cyan());
        println!();

        let mut results = Vec::new();

        // Step 1: Check prerequisites
        println!("{}", "📋 Checking prerequisites...".bold());
        results.push(self.check_prerequisites().await);

        // Step 2: VC++ Redistributables (Windows only)
        #[cfg(windows)]
        if !self.skip_vcredist {
            results.push(self.setup_vcredist().await);
        }

        // Step 3: SDK Setup
        if !self.skip_sdk {
            results.push(self.setup_sdks().await);
        }

        // Step 4: Chrome Extension - Always use automation by default
        if !self.skip_chrome {
            results.push(self.auto_install_chrome_extension().await);
        }

        // Step 5: Verify installation
        results.push(self.verify_installation().await);

        // Print summary
        self.print_summary(&results);

        Ok(())
    }

    async fn check_prerequisites(&self) -> (&'static str, Result<String>) {
        debug!("Checking system prerequisites");

        let mut checks = Vec::new();

        // Check OS
        #[cfg(windows)]
        checks.push(("Windows", true));
        #[cfg(target_os = "macos")]
        checks.push(("macOS", true));
        #[cfg(target_os = "linux")]
        checks.push(("Linux", true));

        // Check Chrome/Chromium
        let chrome_installed = self.check_chrome_installed();
        checks.push(("Chrome/Chromium", chrome_installed));

        // Check Node.js
        let node_installed = ProcessCommand::new("node")
            .arg("--version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        checks.push(("Node.js", node_installed));

        let all_ok = checks.iter().all(|(_, ok)| *ok);
        let summary = checks
            .iter()
            .map(|(name, ok)| format!("{}: {}", name, if *ok { "✓" } else { "✗" }))
            .collect::<Vec<_>>()
            .join(", ");

        if all_ok {
            ("Prerequisites", Ok(summary))
        } else {
            (
                "Prerequisites",
                Err(anyhow::anyhow!("Missing: {}", summary)),
            )
        }
    }

    #[cfg(windows)]
    async fn setup_vcredist(&self) -> (&'static str, Result<String>) {
        println!("{}", "📦 Setting up Visual C++ Redistributables...".bold());

        // Check if already installed
        let check = ProcessCommand::new("reg")
            .args([
                "query",
                "HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64",
                "/v",
                "Version",
            ])
            .output();

        if check.map(|o| o.status.success()).unwrap_or(false) {
            println!("  {} Already installed", "✓".green());
            return ("VC++ Redistributables", Ok("Already installed".to_string()));
        }

        // Check with winget
        println!("  Checking winget availability...");
        let winget_check = ProcessCommand::new("winget").arg("--version").output();

        if winget_check.map(|o| o.status.success()).unwrap_or(false) {
            println!();
            println!("  📦 Installing via winget...");
            println!("  Please run this command in an elevated terminal:");
            println!();
            println!(
                "    {}",
                "winget install Microsoft.VCRedist.2015+.x64"
                    .bold()
                    .yellow()
            );
            println!();
            println!("  Press Enter after installation completes...");
            std::io::stdin().read_line(&mut String::new()).ok();
            (
                "VC++ Redistributables",
                Ok("Installed via winget".to_string()),
            )
        } else {
            let url = "https://aka.ms/vs/17/release/vc_redist.x64.exe";
            println!();
            println!("  📥 Please download and install:");
            println!("  {}", url.underline().blue());
            println!();
            println!("  Press Enter to open the download page...");
            std::io::stdin().read_line(&mut String::new()).ok();

            ProcessCommand::new("cmd")
                .args(["/C", "start", url])
                .spawn()
                .ok();

            println!("  Press Enter after installation completes...");
            std::io::stdin().read_line(&mut String::new()).ok();

            (
                "VC++ Redistributables",
                Ok("Manual installation".to_string()),
            )
        }
    }

    #[cfg(not(windows))]
    #[allow(dead_code)]
    async fn setup_vcredist(&self) -> (&'static str, Result<String>) {
        ("VC++ Redistributables", Ok("Not needed".to_string()))
    }

    async fn setup_sdks(&self) -> (&'static str, Result<String>) {
        println!("{}", "🛠️  Setting up SDKs...".bold());

        let mut components = Vec::new();

        // Check Node.js
        print!("  Node.js: ");
        match ProcessCommand::new("node").arg("--version").output() {
            Ok(output) if output.status.success() => {
                let version = String::from_utf8_lossy(&output.stdout);
                println!("{} {}", "✓".green(), version.trim());
                components.push("Node.js");
            }
            _ => {
                println!("{} Not installed", "✗".red());
                println!("    Install from: {}", "https://nodejs.org".underline());
            }
        }

        // Check Bun (optional)
        print!("  Bun (optional): ");
        match ProcessCommand::new("bun").arg("--version").output() {
            Ok(output) if output.status.success() => {
                let version = String::from_utf8_lossy(&output.stdout);
                println!("{} {}", "✓".green(), version.trim());
                components.push("Bun");
            }
            _ => {
                println!("{} Not installed", "○".yellow());
                if self.verbose {
                    println!(
                        "    Install for better TypeScript support: {}",
                        "https://bun.sh".underline()
                    );
                }
            }
        }

        // Pre-install computeruse.js
        println!();
        println!("  Pre-caching computeruse.js...");
        let cache_dir = dirs::cache_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("computeruse")
            .join("mcp-deps");

        if let Err(e) = tokio::fs::create_dir_all(&cache_dir).await {
            println!(
                "    {} Could not create cache directory: {}",
                "⚠️".yellow(),
                e
            );
            return (
                "SDK Setup",
                Err(anyhow::anyhow!("Failed to create cache directory: {}", e)),
            );
        }

        // Run npm install in cache directory
        let npm_result = ProcessCommand::new("npm")
            .current_dir(&cache_dir)
            .args(["install", "computeruse.js", "--save"])
            .output();

        match npm_result {
            Ok(output) if output.status.success() => {
                println!("    {} computeruse.js cached", "✓".green());
                components.push("computeruse.js");
            }
            _ => {
                println!(
                    "    {} Could not pre-cache (will install on demand)",
                    "○".yellow()
                );
            }
        }

        let summary = components.join(", ");
        ("SDK Setup", Ok(summary))
    }

    async fn auto_install_chrome_extension(&self) -> (&'static str, Result<String>) {
        println!(
            "{}",
            "🌐 Installing Chrome Extension automatically...".bold()
        );
        println!(
            "  {} This will control your browser to install the extension",
            "ℹ️".blue()
        );
        println!();

        // First try to find a local workflow file (for developers)
        let local_workflow =
            PathBuf::from("crates/computeruse/browser-extension/install_chrome_extension_ui.yml");

        let workflow_source = if local_workflow.exists() {
            // Use local file if available (developer mode)
            println!("  Using local workflow file...");
            local_workflow.to_str().unwrap().to_string()
        } else {
            // Download workflow to temp directory for safety
            println!("  {} Downloading workflow from GitHub...", "📥".cyan());

            let temp_dir = std::env::temp_dir();
            let workflow_path = temp_dir.join("computeruse-chrome-extension-install.yml");

            let github_url = "https://raw.githubusercontent.com/mediar-ai/computeruse/main/crates/computeruse/browser-extension/install_chrome_extension_ui.yml";

            // Download workflow file
            match self.download_workflow(github_url, &workflow_path).await {
                Ok(_) => {
                    println!("  {} Workflow downloaded successfully", "✓".green());
                    workflow_path.to_str().unwrap().to_string()
                }
                Err(e) => {
                    println!("  {} Failed to download workflow: {}", "❌".red(), e);
                    self.show_manual_fallback();
                    return (
                        "Chrome Extension",
                        Err(anyhow::anyhow!("Failed to download workflow: {}", e)),
                    );
                }
            }
        };

        println!();
        println!("  This will:");
        println!("    1. Download the Chrome extension");
        println!("    2. Open Chrome and navigate to extensions page");
        println!("    3. Enable Developer mode");
        println!("    4. Load the unpacked extension");
        println!();

        let spawn_result = ProcessCommand::new("computeruse")
            .args([
                "mcp",
                "run",
                &workflow_source,
                "--command",
                "npx -y computeruse-mcp-agent",
            ])
            .spawn();

        match spawn_result {
            Ok(mut child) => match child.wait() {
                Ok(status) if status.success() => {
                    println!();
                    println!(
                        "  {} Chrome extension installed successfully!",
                        "✅".green()
                    );
                    (
                        "Chrome Extension",
                        Ok("Installed automatically".to_string()),
                    )
                }
                Ok(_) => {
                    println!();
                    println!(
                        "  {} Automation failed. Falling back to manual installation...",
                        "⚠️".yellow()
                    );
                    self.show_manual_fallback();
                    (
                        "Chrome Extension",
                        Err(anyhow::anyhow!(
                            "Automation failed, manual instructions provided"
                        )),
                    )
                }
                Err(e) => {
                    println!();
                    println!("  {} Installation workflow error: {}", "❌".red(), e);
                    self.show_manual_fallback();
                    (
                        "Chrome Extension",
                        Err(anyhow::anyhow!("Workflow error: {}", e)),
                    )
                }
            },
            Err(e) => {
                println!();
                println!("  {} Could not start automation: {}", "❌".red(), e);
                println!("  Make sure Chrome is installed and computeruse-mcp-agent is available");
                self.show_manual_fallback();
                (
                    "Chrome Extension",
                    Err(anyhow::anyhow!("Could not start automation: {}", e)),
                )
            }
        }
    }

    async fn download_workflow(&self, url: &str, dest_path: &PathBuf) -> Result<()> {
        use tokio::io::AsyncWriteExt;

        // Use reqwest to download the file
        let client = reqwest::Client::builder()
            .user_agent("computeruse-cli")
            .build()?;

        let response = client.get(url).send().await?;

        if !response.status().is_success() {
            return Err(anyhow::anyhow!(
                "Failed to download workflow: HTTP {}",
                response.status()
            ));
        }

        let content = response.bytes().await?;

        // Write to temp file
        let mut file = tokio::fs::File::create(dest_path).await?;
        file.write_all(&content).await?;
        file.flush().await?;

        Ok(())
    }

    fn show_manual_fallback(&self) {
        println!();
        println!("  {} Manual installation steps:", "📝".cyan());
        println!(
            "  1. Download: {}",
            "https://github.com/mediar-ai/computeruse/releases/latest/download/computeruse-browser-extension.zip".underline()
        );
        println!("  2. Extract the zip file to a folder (e.g., C:\\temp\\computeruse-bridge)");
        println!(
            "  3. Open Chrome and go to: {}",
            "chrome://extensions".bold()
        );
        println!(
            "  4. Enable {} mode (toggle in top right)",
            "Developer".bold()
        );
        println!("  5. Click {} (button in top left)", "Load unpacked".bold());
        println!("  6. Select the extracted folder containing manifest.json");
        println!();
        println!(
            "  {} This also works with Chromium-based browsers (Brave, Edge, Vivaldi)",
            "ℹ️".blue()
        );
    }

    async fn verify_installation(&self) -> (&'static str, Result<String>) {
        println!("{}", "✅ Verifying installation...".bold());

        // Test MCP agent
        print!("  MCP Agent: ");
        let mcp_test = ProcessCommand::new("npx")
            .args(["-y", "computeruse-mcp-agent", "--version"])
            .output();

        match mcp_test {
            Ok(output) if output.status.success() => {
                println!("{} Ready", "✓".green());
                ("Verification", Ok("All systems ready".to_string()))
            }
            _ => {
                println!("{} Will install on first use", "○".yellow());
                (
                    "Verification",
                    Ok("Ready (MCP will install on demand)".to_string()),
                )
            }
        }
    }

    fn check_chrome_installed(&self) -> bool {
        #[cfg(windows)]
        let chrome_paths = [
            "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
            "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        ];

        #[cfg(target_os = "macos")]
        let chrome_paths = vec![
            "/Applications/Google Chrome.app",
            "/Applications/Chromium.app",
        ];

        #[cfg(target_os = "linux")]
        let chrome_paths = vec!["/usr/bin/google-chrome", "/usr/bin/chromium"];

        chrome_paths
            .iter()
            .any(|path| std::path::Path::new(path).exists())
    }

    fn print_summary(&self, results: &[(&'static str, Result<String>)]) {
        println!();
        println!("{}", "📊 Setup Summary".bold().green());
        println!("{}", "================".green());

        let mut has_errors = false;

        for (step, result) in results {
            match result {
                Ok(msg) => println!("  {} {}: {}", "✅".green(), step.bold(), msg),
                Err(err) => {
                    println!("  {} {}: {}", "❌".red(), step.bold(), err);
                    has_errors = true;
                }
            }
        }

        println!();
        if has_errors {
            println!(
                "{}",
                "⚠️  Some steps need attention. See above for details.".yellow()
            );
        } else {
            println!("{}", "🎉 Setup complete!".bold().green());
            println!();
            println!("Next steps:");
            println!(
                "  1. Test with: {}",
                "computeruse mcp chat --command \"npx -y computeruse-mcp-agent\"".cyan()
            );
            println!(
                "  2. Run examples: {}",
                "computeruse mcp run examples/notepad.py".cyan()
            );
        }
    }
}
