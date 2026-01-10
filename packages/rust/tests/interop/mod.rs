//! Interoperability tests for elizaOS Core
//!
//! These tests verify that Rust types serialize/deserialize identically to TypeScript.
//! They use JSON fixtures that are generated from the TypeScript implementation
//! to ensure perfect compatibility.

mod serialization_equivalence;
mod type_mapping;
mod uuid_compatibility;

