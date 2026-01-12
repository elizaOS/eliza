//! Platform-aware trait definitions for native and WASM targets.
//!
//! This module provides macros for defining traits that work correctly on both
//! native (multi-threaded with tokio) and WASM (single-threaded) platforms.
//!
//! # The Problem
//!
//! WASM is single-threaded, so `Send + Sync` bounds are:
//! 1. Meaningless (no threads to send between)
//! 2. Often impossible to satisfy (e.g., `Rc`, `RefCell` are common in WASM)
//!
//! The `async_trait` crate defaults to requiring `Send` on returned futures,
//! which breaks WASM compilation.
//!
//! # The Solution
//!
//! Platform-aware macros that:
//! - Add `Send + Sync` bounds on native builds (for thread safety)
//! - Omit those bounds on WASM builds (single-threaded)
//! - Use `#[async_trait]` on native, `#[async_trait(?Send)]` on WASM
//!
//! # Example
//!
//! ```rust,ignore
//! use crate::platform::{platform_async_trait, define_platform_trait};
//!
//! // Define a trait with platform-appropriate bounds
//! define_platform_trait! {
//!     /// My async service trait.
//!     pub trait MyService {
//!         async fn process(&self, input: &str) -> String;
//!     }
//! }
//!
//! // Implement with platform-appropriate async_trait
//! struct MyServiceImpl;
//!
//! platform_async_trait! {
//!     impl MyService for MyServiceImpl {
//!         async fn process(&self, input: &str) -> String {
//!             format!("processed: {}", input)
//!         }
//!     }
//! }
//! ```

/// Applies the appropriate `#[async_trait]` attribute based on target platform.
///
/// - **Native**: `#[async_trait::async_trait]` (requires `Send` on futures)
/// - **WASM**: `#[async_trait::async_trait(?Send)]` (no `Send` requirement)
///
/// # Usage
///
/// ```rust,ignore
/// platform_async_trait! {
///     impl SomeTrait for SomeStruct {
///         async fn some_method(&self) -> Result<(), Error> {
///             // implementation
///         }
///     }
/// }
/// ```
#[cfg(not(target_arch = "wasm32"))]
#[macro_export]
macro_rules! platform_async_trait {
    ($($item:tt)*) => {
        #[async_trait::async_trait]
        $($item)*
    };
}

/// WASM version - no Send requirement.
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
/// - **Native**: Adds `: Send + Sync` to the trait bounds
/// - **WASM**: No additional bounds (single-threaded)
///
/// The macro supports:
/// - Doc comments
/// - Visibility modifiers (`pub`, `pub(crate)`, etc.)
/// - Existing trait bounds (e.g., `trait Foo: Clone`)
/// - Async methods (use with `#[async_trait]` attribute)
///
/// # Usage
///
/// ```rust,ignore
/// define_platform_trait! {
///     /// Documentation for the trait.
///     pub trait MyHandler [Clone] {
///         /// Get the name.
///         fn name(&self) -> &str;
///
///         /// Process something asynchronously.
///         async fn process(&self, input: &str) -> Result<String, Error>;
///     }
/// }
/// ```
///
/// Note: Use `[Bounds]` syntax for additional bounds beyond Send + Sync.
/// Use `[]` or omit entirely for no additional bounds.
///
/// # Important
///
/// When the trait has async methods, you must ALSO apply `#[async_trait]`
/// at the trait definition level. This macro only handles the `Send + Sync`
/// bounds, not the async transformation.
#[cfg(not(target_arch = "wasm32"))]
#[macro_export]
macro_rules! define_platform_trait {
    // Case 1: Trait with existing bounds in brackets
    (
        $(#[$meta:meta])*
        $vis:vis trait $name:ident [$($bounds:tt)+]
        { $($body:tt)* }
    ) => {
        $(#[$meta])*
        $vis trait $name: Send + Sync + $($bounds)+ {
            $($body)*
        }
    };

    // Case 2: Trait with empty brackets (no extra bounds)
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

    // Case 3: Trait without brackets (no extra bounds)
    (
        $(#[$meta:meta])*
        $vis:vis trait $name:ident
        { $($body:tt)* }
    ) => {
        $(#[$meta])*
        $vis trait $name: Send + Sync {
            $($body)*
        }
    };
}

/// WASM version - no Send + Sync bounds.
#[cfg(target_arch = "wasm32")]
#[macro_export]
macro_rules! define_platform_trait {
    // Case 1: Trait with existing bounds in brackets
    (
        $(#[$meta:meta])*
        $vis:vis trait $name:ident [$($bounds:tt)+]
        { $($body:tt)* }
    ) => {
        $(#[$meta])*
        $vis trait $name: $($bounds)+ {
            $($body)*
        }
    };

    // Case 2: Trait with empty brackets (no extra bounds)
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

    // Case 3: Trait without brackets (no extra bounds)
    (
        $(#[$meta:meta])*
        $vis:vis trait $name:ident
        { $($body:tt)* }
    ) => {
        $(#[$meta])*
        $vis trait $name {
            $($body)*
        }
    };
}

/// Type alias for platform-appropriate `Arc<dyn Any>` storage.
///
/// - **Native**: `Arc<dyn Any + Send + Sync>` for thread-safe sharing
/// - **WASM**: `Arc<dyn Any>` (no thread safety needed)
#[cfg(not(target_arch = "wasm32"))]
pub type AnyArc = std::sync::Arc<dyn std::any::Any + Send + Sync>;

/// WASM version - no Send + Sync bounds.
#[cfg(target_arch = "wasm32")]
pub type AnyArc = std::sync::Arc<dyn std::any::Any>;

/// Helper trait bound alias for platform-appropriate service traits.
///
/// Use this in generic contexts where you need platform-aware bounds.
///
/// ```rust,ignore
/// fn register_service<T: PlatformService + 'static>(service: T) { ... }
/// ```
#[cfg(not(target_arch = "wasm32"))]
pub trait PlatformService: Send + Sync {}

#[cfg(not(target_arch = "wasm32"))]
impl<T: Send + Sync> PlatformService for T {}

/// WASM version - no bounds required (single-threaded).
#[cfg(target_arch = "wasm32")]
pub trait PlatformService {}

#[cfg(target_arch = "wasm32")]
impl<T> PlatformService for T {}

#[cfg(test)]
mod tests {
    use super::*;

    // Test that the macros compile correctly

    define_platform_trait! {
        /// A test trait without bounds.
        pub trait TestTraitNoBounds {
            fn get_value(&self) -> i32;
        }
    }

    // Test platform_async_trait! macro with native traits
    // This demonstrates the typical usage pattern for ElizaOS
    #[cfg(not(target_arch = "wasm32"))]
    mod async_tests {
        #[async_trait::async_trait]
        pub trait AsyncService: Send + Sync {
            async fn process(&self, input: &str) -> String;
        }

        struct AsyncServiceImpl;

        crate::platform_async_trait! {
            impl AsyncService for AsyncServiceImpl {
                async fn process(&self, input: &str) -> String {
                    format!("processed: {}", input)
                }
            }
        }

        #[tokio::test]
        async fn test_async_service() {
            let svc = AsyncServiceImpl;
            let result = svc.process("hello").await;
            assert_eq!(result, "processed: hello");
        }
    }

    define_platform_trait! {
        /// A test trait with empty brackets.
        pub trait TestTraitEmptyBrackets [] {
            fn get_id(&self) -> u32;
        }
    }

    define_platform_trait! {
        /// A test trait with Clone bound.
        pub trait TestTraitWithBounds [Clone] {
            fn get_name(&self) -> &str;
        }
    }

    #[derive(Clone)]
    struct TestImpl {
        value: i32,
        id: u32,
        name: String,
    }

    impl TestTraitNoBounds for TestImpl {
        fn get_value(&self) -> i32 {
            self.value
        }
    }

    impl TestTraitEmptyBrackets for TestImpl {
        fn get_id(&self) -> u32 {
            self.id
        }
    }

    impl TestTraitWithBounds for TestImpl {
        fn get_name(&self) -> &str {
            &self.name
        }
    }

    #[test]
    fn test_trait_without_bounds() {
        let t = TestImpl {
            value: 42,
            id: 1,
            name: "test".to_string(),
        };
        assert_eq!(t.get_value(), 42);
    }

    #[test]
    fn test_trait_empty_brackets() {
        let t = TestImpl {
            value: 42,
            id: 99,
            name: "test".to_string(),
        };
        assert_eq!(t.get_id(), 99);
    }

    #[test]
    fn test_trait_with_bounds() {
        let t = TestImpl {
            value: 42,
            id: 1,
            name: "hello".to_string(),
        };
        assert_eq!(t.get_name(), "hello");
    }

    #[test]
    #[cfg(not(target_arch = "wasm32"))]
    fn test_any_arc_type_native() {
        // On native, AnyArc is Arc<dyn Any + Send + Sync> which has downcast
        let value: AnyArc = std::sync::Arc::new(42i32);
        let downcast = value.downcast::<i32>().unwrap();
        assert_eq!(*downcast, 42);
    }

    #[test]
    #[cfg(target_arch = "wasm32")]
    fn test_any_arc_type_wasm() {
        // On WASM, AnyArc is Arc<dyn Any> - downcast via downcast_ref
        let value: AnyArc = std::sync::Arc::new(42i32);
        let downcast_ref = value.downcast_ref::<i32>().unwrap();
        assert_eq!(*downcast_ref, 42);
    }

    #[test]
    fn test_platform_service_bound() {
        fn accepts_platform_service<T: PlatformService>(_: &T) {}

        let value = 42i32;
        accepts_platform_service(&value);
    }
}

