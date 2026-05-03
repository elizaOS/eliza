#![allow(missing_docs)]

pub mod base;
#[cfg(feature = "native")]
pub mod migration;
pub mod schema;

#[cfg(feature = "native")]
pub mod postgres;

#[cfg(all(feature = "wasm", target_arch = "wasm32"))]
pub mod pglite;

#[cfg(all(feature = "wasm", target_arch = "wasm32"))]
pub mod wasm;

pub fn plugin() -> elizaos::Plugin {
    elizaos::Plugin::new(
        "sql",
        "SQL database plugin with PostgreSQL and PGLite support",
    )
}
