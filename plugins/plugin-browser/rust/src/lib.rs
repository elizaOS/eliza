pub mod actions;
pub mod plugin;
pub mod providers;
pub mod services;
pub mod types;
pub mod utils;

pub use actions::*;
pub use plugin::{create_browser_plugin, BrowserPlugin};
pub use providers::*;
pub use services::{BrowserService, BrowserWebSocketClient};
pub use types::*;
pub use utils::captcha::{detect_captcha_type, generate_captcha_injection_script};
