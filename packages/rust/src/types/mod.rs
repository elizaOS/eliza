//! Core types for elizaOS
//!
//! This module contains all the fundamental types used throughout the elizaOS system.
//! All types are designed to serialize/deserialize to JSON in a format identical to
//! the TypeScript implementation.
//!
//! ## Proto-generated Types
//!
//! The `generated` submodule contains types generated from Protocol Buffer schemas.
//! These are the single source of truth for cross-language interoperability.
//! For new code, prefer using types from `generated` for better compatibility.

//! Core types for elizaOS
//!
//! Import directly from submodules:
//! - agent for Agent, Character, etc.
//! - components for Action, Provider, Evaluator types
//! - database for database types
//! - environment for Channel, Entity, Room types
//! - events for event types
//! - knowledge for knowledge types
//! - memory for Memory types
//! - messaging for messaging types
//! - model for model types
//! - plugin for Plugin types
//! - primitives for UUID, Content, Media types
//! - service for Service types
//! - settings for Settings types
//! - state for State types
//! - streaming for streaming types
//! - task for Task types
//! - tee for TEE types
//! - testing for test types

// Proto-generated types (single source of truth)
pub mod generated;

// Type modules - import directly from these
pub mod agent;
pub mod components;
pub mod database;
pub mod environment;
pub mod events;
pub mod knowledge;
pub mod memory;
pub mod messaging;
pub mod model;
pub mod plugin;
pub mod primitives;
pub mod service;
pub mod service_interfaces;
pub mod settings;
pub mod state;
pub mod streaming;
pub mod task;
pub mod tee;
pub mod testing;
