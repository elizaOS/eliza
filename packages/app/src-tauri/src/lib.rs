use std::net::TcpStream;
use std::process::{Child, Command};
use std::sync::{Arc, Mutex};
use tauri::Manager;

static SERVER_PROCESS: once_cell::sync::Lazy<Arc<Mutex<Option<Child>>>> = 
    once_cell::sync::Lazy::new(|| Arc::new(Mutex::new(None)));

fn is_server_running() -> bool {
    TcpStream::connect("127.0.0.1:3000").is_ok()
}

fn shutdown_server() {
    println!("Shutting down Eliza server...");
    let mut guard = SERVER_PROCESS.lock().expect("SERVER_PROCESS mutex should not be poisoned");
    if let Some(ref mut child) = *guard {
        child.kill().expect("Failed to kill Eliza server process");
        println!("Eliza server shut down successfully");
    }
    *guard = None;
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            if !is_server_running() {
                println!("Starting Eliza server...");
                let child = Command::new("elizaos")
                    .arg("start")
                    .spawn()
                    .expect("Failed to start Eliza server");
                let mut server_guard = SERVER_PROCESS.lock().expect("SERVER_PROCESS mutex should not be poisoned");
                *server_guard = Some(child);
                println!("Eliza server process started");
            } else {
                println!("Eliza server is already running");
            }
            
            #[cfg(desktop)]
            {
                if let Some(main_window) = app.get_webview_window("main") {
                    main_window.on_window_event(move |event| {
                        if let tauri::WindowEvent::CloseRequested { .. } = event {
                            shutdown_server();
                        }
                    });
                }
            }
            
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Failed to build Tauri application");
        
    app.run(|_, event| {
        if let tauri::RunEvent::Exit = event {
            shutdown_server();
        }
    });
}
