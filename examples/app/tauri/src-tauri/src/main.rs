mod runtime_manager;
mod store;
mod types;

use crate::runtime_manager::{get_or_create_runtime, room_id, SharedRuntime};
use crate::store::ChatStore;
use crate::types::{effective_mode, AppConfig, ChatMessage, ProviderMode};
use elizaos::services::IMessageService;
use elizaos::types::memory::Memory;
use elizaos::types::primitives::{string_to_uuid, UUID};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{Manager, State};
use tokio::sync::Mutex;

#[derive(Clone)]
struct AppState {
    worker: tokio::sync::mpsc::UnboundedSender<WorkerRequest>,
    store: Arc<Mutex<ChatStore>>,
    store_path: PathBuf,
}

enum WorkerRequest {
    Send {
        cfg: AppConfig,
        text: String,
        resp: tokio::sync::oneshot::Sender<Result<String, String>>,
    },
}

fn new_id() -> String {
    UUID::new_v4().to_string()
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

#[tauri::command]
async fn chat_get_history(state: State<'_, AppState>) -> Result<Vec<ChatMessage>, String> {
    let guard = state.store.lock().await;
    Ok(guard.messages.clone())
}

#[tauri::command]
async fn chat_reset(config: Option<AppConfig>, state: State<'_, AppState>) -> Result<(), String> {
    let _cfg = config.unwrap_or_default();
    let mut guard = state.store.lock().await;
    guard.messages.clear();
    guard
        .save(&state.store_path)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn chat_get_greeting(config: Option<AppConfig>) -> String {
    let cfg = config.unwrap_or_default();
    match effective_mode(&cfg) {
        ProviderMode::ElizaClassic => elizaos_plugin_eliza_classic::get_greeting(),
        _ => "Hello! What would you like to chat about?".to_string(),
    }
}

#[tauri::command]
async fn chat_send(
    config: Option<AppConfig>,
    text: String,
    state: State<'_, AppState>,
) -> Result<(String, ProviderMode), String> {
    let cfg = config.unwrap_or_default();
    let effective = effective_mode(&cfg);

    let user_text = text.trim().to_string();
    if user_text.is_empty() {
        return Err("Missing text".to_string());
    }

    // Persist user message in our app-level store
    {
        let mut store = state.store.lock().await;
        store.messages.push(ChatMessage {
            id: new_id(),
            role: "user".to_string(),
            text: user_text.clone(),
            timestamp: now_ms(),
        });
        store
            .save(&state.store_path)
            .await
            .map_err(|e| e.to_string())?;
    }

    // Run elizaOS in Rust backend worker (to avoid Send constraints in Tauri commands)
    let (resp_tx, resp_rx) = tokio::sync::oneshot::channel::<Result<String, String>>();
    state
        .worker
        .send(WorkerRequest::Send {
            cfg: cfg.clone(),
            text: user_text.clone(),
            resp: resp_tx,
        })
        .map_err(|_| "Worker unavailable".to_string())?;

    let response_text = resp_rx
        .await
        .map_err(|_| "Worker dropped response".to_string())?
        .map_err(|e| e)?;

    // Persist assistant message
    {
        let mut store = state.store.lock().await;
        store.messages.push(ChatMessage {
            id: new_id(),
            role: "assistant".to_string(),
            text: response_text.clone(),
            timestamp: now_ms(),
        });
        store
            .save(&state.store_path)
            .await
            .map_err(|e| e.to_string())?;
    }

    Ok((response_text, effective))
}

#[tokio::main]
async fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let path = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| app.path().data_dir().unwrap())
                .join("chat_history.json");

            let runtime: SharedRuntime = Arc::new(Mutex::new(None));
            let (worker_tx, mut worker_rx) = tokio::sync::mpsc::unbounded_channel::<WorkerRequest>();

            // Dedicated thread running a current-thread Tokio runtime (supports non-Send futures).
            std::thread::spawn(move || {
                let rt = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .expect("tokio runtime");
                rt.block_on(async move {
                    while let Some(req) = worker_rx.recv().await {
                        match req {
                            WorkerRequest::Send { cfg, text, resp } => {
                                let out: Result<String, String> = async {
                                    let runtime = get_or_create_runtime(&runtime, &cfg)
                                        .await
                                        .map_err(|e| e.to_string())?;

                                    let user_id = string_to_uuid("tauri-example-user");
                                    let mut msg = Memory::message(user_id, room_id(), &text);
                                    let service = runtime.message_service();
                                    let result = service
                                        .handle_message(&runtime, &mut msg, None, None)
                                        .await
                                        .map_err(|e| e.to_string())?;

                                    let response_text = result
                                        .response_content
                                        .and_then(|c| c.text)
                                        .unwrap_or_else(|| {
                                            "I’m not sure how to respond to that.".to_string()
                                        });
                                    Ok(response_text)
                                }
                                .await;

                                let _ = resp.send(out);
                            }
                        }
                    }
                });
            });

            let store = tauri::async_runtime::block_on(ChatStore::load(&path));
            app.manage(AppState {
                worker: worker_tx,
                store: Arc::new(Mutex::new(store)),
                store_path: path,
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            chat_get_history,
            chat_reset,
            chat_get_greeting,
            chat_send
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

