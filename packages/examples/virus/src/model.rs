use crate::shell;
use serde::{Deserialize, Serialize};

const OLLAMA_URL: &str = "http://127.0.0.1:11434";

#[derive(Serialize)]
struct GenerateRequest {
    model: String,
    prompt: String,
    stream: bool,
}

#[derive(Deserialize)]
struct GenerateResponse {
    response: String,
}

/// Check if ollama is running.
pub async fn is_running() -> bool {
    reqwest::get(OLLAMA_URL).await.is_ok()
}

/// Try to start ollama in the background.
pub fn start_ollama() {
    if cfg!(windows) {
        shell::exec("start /B ollama serve");
    } else {
        shell::exec("ollama serve &");
    }
}

/// Install ollama if not present.
/// Windows: uses winget (signed package). Linux/macOS: instructs the user manually
/// rather than piping a remote script to sh (unsafe).
pub fn install_ollama() {
    eprintln!("[virus] ollama not found, installing...");
    if cfg!(windows) {
        shell::exec("winget install Ollama.Ollama --accept-package-agreements --accept-source-agreements");
    } else {
        eprintln!("[virus] please install ollama manually: https://ollama.com/download");
        eprintln!("[virus] then re-run virus");
        std::process::exit(1);
    }
}

/// Pull a model if not already present.
pub async fn ensure_model(model: &str) {
    eprintln!("[virus] ensuring model {} is available...", model);

    let client = reqwest::Client::new();
    let res = client
        .post(format!("{}/api/pull", OLLAMA_URL))
        .json(&serde_json::json!({ "name": model, "stream": false }))
        .send()
        .await;

    match res {
        Ok(r) if r.status().is_success() => {
            eprintln!("[virus] model {} ready", model);
        }
        Ok(r) => {
            eprintln!("[virus] pull response: {}", r.status());
        }
        Err(e) => {
            eprintln!("[virus] failed to pull model: {}", e);
        }
    }
}

/// Send a prompt to the local model and get a response.
pub async fn generate(model: &str, prompt: &str) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|e| e.to_string())?;

    let req = GenerateRequest {
        model: model.to_string(),
        prompt: prompt.to_string(),
        stream: false,
    };

    let res = client
        .post(format!("{}/api/generate", OLLAMA_URL))
        .json(&req)
        .send()
        .await
        .map_err(|e| format!("request failed: {}", e))?;

    if !res.status().is_success() {
        return Err(format!("ollama returned {}", res.status()));
    }

    let body: GenerateResponse = res.json().await.map_err(|e| format!("parse failed: {}", e))?;
    Ok(body.response)
}

/// Bootstrap: make sure ollama is installed, running, and has the model.
pub async fn bootstrap(model: &str) {
    if !is_running().await {
        let check = shell::exec("ollama --version");
        if !check.success {
            install_ollama();
            // Wait for winget to finish (it's async and can take a while)
            for attempt in 0..12 {
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                let recheck = shell::exec("ollama --version");
                if recheck.success {
                    eprintln!("[virus] ollama installed successfully");
                    break;
                }
                if attempt == 11 {
                    eprintln!("[virus] ollama install failed after 60s — please install manually");
                    eprintln!("[virus] https://ollama.com/download");
                    std::process::exit(1);
                }
            }
        }

        start_ollama();
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;

        let mut started = false;
        for _ in 0..10 {
            if is_running().await {
                started = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        }
        if !started {
            eprintln!("[virus] ollama failed to start after 20s");
            eprintln!("[virus] try running 'ollama serve' manually, then re-run virus");
            std::process::exit(1);
        }
    }

    ensure_model(model).await;
}
