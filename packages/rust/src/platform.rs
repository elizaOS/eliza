//! Platform-aware trait definitions for native and WASM targets.
//!
//! This module provides macros and helpers for defining traits that work on both
//! native (multi-threaded) and WASM (single-threaded) targets.
//!
//! # Why this exists
//! - WASM is single-threaded; `Send + Sync` bounds are unnecessary and often invalid.
//! - `async_trait` defaults to requiring `Send` futures, which breaks on wasm32.

/// Applies the appropriate `#[async_trait]` attribute based on target platform.
///
/// - **Native**: `#[async_trait::async_trait]` (requires `Send` futures)
/// - **WASM**: `#[async_trait::async_trait(?Send)]` (no `Send` requirement)
#[cfg(not(target_arch = "wasm32"))]
#[macro_export]
macro_rules! platform_async_trait {
    ($($item:tt)*) => {
        #[async_trait::async_trait]
        $($item)*
    };
}

/// WASM variant for `platform_async_trait!`.
#[cfg(target_arch = "wasm32")]
#[macro_export]
macro_rules! platform_async_trait {
    ($($item:tt)*) => {
        #[async_trait::async_trait(?Send)]
        $($item)*
    };
}

/// Defines a trait with platform-appropriate `Send + Sync` bounds.
///
/// Usage:
/// ```
/// define_platform_trait! {
///     pub trait MyService {
///         async fn process(&self) -> Result<(), anyhow::Error>;
///     }
/// }
/// ```
///
/// With bounds and generics:
/// ```
/// define_platform_trait! {
///     pub trait MyService<T> [Clone] {
///         fn name(&self) -> &str;
///     }
/// }
/// ```
#[cfg(not(target_arch = "wasm32"))]
#[macro_export]
macro_rules! define_platform_trait {
    (
        $(#[$meta:meta])*
        $vis:vis trait $name:ident < $($gen:ident),+ > [$bound:path]
        { $($body:tt)* }
    ) => {
        $(#[$meta])*
        $vis trait $name < $($gen),+ > : Send + Sync + $bound {
            $($body)*
        }
    };
    (
        $(#[$meta:meta])*
        $vis:vis trait $name:ident < $($gen:ident),+ >
        []
        { $($body:tt)* }
    ) => {
        $(#[$meta])*
        $vis trait $name < $($gen),+ > : Send + Sync {
            $($body)*
        }
    };
    (
        $(#[$meta:meta])*
        $vis:vis trait $name:ident [$bound:path]
        { $($body:tt)* }
    ) => {
        $(#[$meta])*
        $vis trait $name: Send + Sync + $bound {
            $($body)*
        }
    };
    (
        $(#[$meta:meta])*
        $vis:vis trait $name:ident []
        { $($body:tt)* }
    ) => {
        $(#[$meta])*
        $vis trait $name: Send + Sync {
            $($body)*
        }
    };
}

/// WASM variant for `define_platform_trait!` without `Send + Sync` bounds.
#[cfg(target_arch = "wasm32")]
#[macro_export]
macro_rules! define_platform_trait {
    (
        $(#[$meta:meta])*
        $vis:vis trait $name:ident < $($gen:ident),+ > [$bound:path]
        { $($body:tt)* }
    ) => {
        $(#[$meta])*
        $vis trait $name < $($gen),+ > : $bound {
            $($body)*
        }
    };
    (
        $(#[$meta:meta])*
        $vis:vis trait $name:ident < $($gen:ident),+ >
        []
        { $($body:tt)* }
    ) => {
        $(#[$meta])*
        $vis trait $name < $($gen),+ > {
            $($body)*
        }
    };
    (
        $(#[$meta:meta])*
        $vis:vis trait $name:ident [$bound:path]
        { $($body:tt)* }
    ) => {
        $(#[$meta])*
        $vis trait $name: $bound {
            $($body)*
        }
    };
    (
        $(#[$meta:meta])*
        $vis:vis trait $name:ident []
        { $($body:tt)* }
    ) => {
        $(#[$meta])*
        $vis trait $name {
            $($body)*
        }
    };
}

/// Platform-appropriate `Arc<dyn Any>` alias.
#[cfg(not(target_arch = "wasm32"))]
pub type AnyArc = std::sync::Arc<dyn std::any::Any + Send + Sync>;

/// Platform-appropriate `Arc<dyn Any>` alias for wasm32.
#[cfg(target_arch = "wasm32")]
pub type AnyArc = std::sync::Arc<dyn std::any::Any>;

/// Marker trait for platform-aware service bounds.
#[cfg(not(target_arch = "wasm32"))]
pub trait PlatformService: Send + Sync {}

/// Marker trait for wasm32 targets.
#[cfg(target_arch = "wasm32")]
pub trait PlatformService {}

#[cfg(not(target_arch = "wasm32"))]
impl<T> PlatformService for T where T: Send + Sync {}

#[cfg(target_arch = "wasm32")]
impl<T> PlatformService for T {}
