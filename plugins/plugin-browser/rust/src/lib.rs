pub mod types;
pub mod utils;
pub mod services;
pub mod actions;
pub mod providers;
pub mod plugin;

pub use types::*;
pub use utils::captcha::{detect_captcha_type, generate_captcha_injection_script};
pub use services::{BrowserService, BrowserWebSocketClient};
pub use actions::*;
pub use providers::*;
pub use plugin::{BrowserPlugin, create_browser_plugin};
