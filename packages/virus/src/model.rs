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

/// Install ollama if not present (Windows: winget, otherwise curl).
pub fn install_ollama() {
    eprintln!("[virus] ollama not found, installing...");
    if cfg!(windows) {
        shell::exec("winget install Ollama.Ollama --accept-package-agreements --accept-source-agreements");
    } else {
        shell::exec("curl -fsSL https://ollama.com/install.sh | sh");
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
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        }
        start_ollama();
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;

        for _ in 0..10 {
            if is_running().await {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        }
    }

    ensure_model(model).await;
}
