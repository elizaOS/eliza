#![allow(missing_docs)]

#[cfg(feature = "wasm")]
mod adapter;
#[cfg(feature = "wasm")]
mod manager;

#[cfg(feature = "wasm")]
pub use adapter::PgLiteAdapter;
#[cfg(feature = "wasm")]
pub use manager::PgLiteManager;
