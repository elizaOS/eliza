//! Browser actions

pub mod navigate;
pub mod click;
pub mod type_text;
pub mod select;
pub mod extract;
pub mod screenshot;

pub use navigate::browser_navigate;
pub use click::browser_click;
pub use type_text::browser_type;
pub use select::browser_select;
pub use extract::browser_extract;
pub use screenshot::browser_screenshot;


