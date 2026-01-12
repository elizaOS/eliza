#![allow(missing_docs)]

pub mod base;
#[cfg(feature = "native")]
pub mod migration;
pub mod schema;

#[cfg(feature = "native")]
pub mod postgres;

#[cfg(feature = "wasm")]
pub mod pglite;

#[cfg(feature = "wasm")]
pub mod wasm;

pub fn plugin() -> elizaos::Plugin {
    elizaos::Plugin::new(
        "sql",
        "SQL database plugin with PostgreSQL and PGLite support",
    )
}
