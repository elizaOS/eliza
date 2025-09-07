// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use std::net::TcpStream;
use std::process::{Child, Command};
use std::sync::{Arc, Mutex};
use tauri::Manager;

// Store the server process so we can kill it when the app closes
static SERVER_PROCESS: once_cell::sync::Lazy<Arc<Mutex<Option<Child>>>> = 
    once_cell::sync::Lazy::new(|| Arc::new(Mutex::new(None)));

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

// Check if the server is running by attempting to connect to the port
fn is_server_running() -> bool {
    match TcpStream::connect("127.0.0.1:3000") {
        Ok(_) => true,
        Err(_) => false,
    }
}

// Shutdown server when app exits
fn shutdown_server() {
    println!("Shutting down Eliza server...");
    let mut guard = SERVER_PROCESS.lock().unwrap();
    if let Some(ref mut child) = *guard {
        if let Err(e) = child.kill() {
            eprintln!("Failed to kill Eliza server: {}", e);
        } else {
            println!("Eliza server shut down successfully");
        }
    }
    *guard = None;
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Register cleanup for when app exits
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![greet])
        .setup(|app| {
            // Start the server if it's not already running
            if !is_server_running() {
                println!("Starting Eliza server...");
                match Command::new("elizaos")
                    .arg("start")
                    .spawn() {
                        Ok(child) => {
                            // Store the process so we can kill it when the app closes
                            let mut server_guard = SERVER_PROCESS.lock().unwrap();
                            *server_guard = Some(child);
                            println!("Eliza server process started");
                        },
                        Err(e) => {
                            eprintln!("Failed to start Eliza server: {}", e);
                        }
                    };
            } else {
                println!("Eliza server is already running");
            }
            
            // Add event listener for app exit
            let _app_handle = app.handle();
            
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
        .expect("error while building tauri application");
        
    app.run(|_app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            shutdown_server();
        }
    });
}
