//! Feature modules (parity with TypeScript `eliza/packages/typescript/src/features/`).

#[cfg(all(
    feature = "basic_capabilities-internal",
    feature = "native",
    not(feature = "wasm")
))]
pub mod advanced_capabilities;
#[cfg(all(feature = "native", not(feature = "wasm")))]
pub mod advanced_memory;
#[cfg(all(feature = "native", not(feature = "wasm")))]
pub mod advanced_planning;
#[cfg(all(feature = "native", not(feature = "wasm")))]
pub mod autonomy;
#[cfg(all(
    feature = "basic_capabilities-internal",
    feature = "native",
    not(feature = "wasm")
))]
pub mod basic_capabilities;
#[cfg(all(
    feature = "basic_capabilities-internal",
    feature = "native",
    not(feature = "wasm")
))]
pub mod core_capabilities;
