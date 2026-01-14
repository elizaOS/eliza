pub mod click;
pub mod extract;
pub mod navigate;
pub mod screenshot;
pub mod select;
pub mod type_text;

pub use click::browser_click;
pub use extract::browser_extract;
pub use navigate::browser_navigate;
pub use screenshot::browser_screenshot;
pub use select::browser_select;
pub use type_text::browser_type;
