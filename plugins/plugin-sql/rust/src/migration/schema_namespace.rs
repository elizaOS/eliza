#![allow(missing_docs)]
//! Schema namespace utilities for plugin isolation.

use anyhow::{Context, Result};
use regex::Regex;
use sqlx::postgres::PgPool;
use std::sync::Arc;
use tracing::debug;

/// Reserved schema names that plugins cannot use.
const RESERVED_SCHEMAS: &[&str] = &["public", "pg_catalog", "information_schema", "migrations"];

/// Derive a database schema name from a plugin name.
///
/// This matches the TypeScript implementation:
/// - @elizaos/plugin-sql uses 'public' schema (core tables)
/// - Other plugins: remove npm scope, remove plugin- prefix, normalize
///
/// # Arguments
/// * `plugin_name` - Plugin identifier (e.g., '@your-org/plugin-name')
///
/// # Returns
/// Database schema name (e.g., 'name' for '@your-org/plugin-name')
pub fn derive_schema_name(plugin_name: &str) -> String {
    // Core plugin uses public schema
    if plugin_name == "@elizaos/plugin-sql" {
        return "public".to_string();
    }

    // Remove npm scope like @elizaos/ or @your-org/
    let scope_re = Regex::new(r"^@[^/]+/").unwrap();
    let schema_name = scope_re.replace(plugin_name, "").to_string();

    // Remove plugin- prefix
    let prefix_re = Regex::new(r"^plugin-").unwrap();
    let schema_name = prefix_re.replace(&schema_name, "").to_string();

    // Convert to lowercase
    let schema_name = schema_name.to_lowercase();

    // Normalize: replace non-alphanumeric with underscores
    let mut schema_name = normalize_schema_name(&schema_name);

    // Check for reserved names
    if schema_name.is_empty() || RESERVED_SCHEMAS.contains(&schema_name.as_str()) {
        // Fallback to using the full plugin name with safe characters
        schema_name = format!(
            "plugin_{}",
            normalize_schema_name(&plugin_name.to_lowercase())
        );
    }

    // Ensure it starts with a letter (PostgreSQL requirement)
    if schema_name.is_empty()
        || !schema_name
            .chars()
            .next()
            .is_some_and(|c| c.is_alphabetic())
    {
        schema_name = format!("p_{}", schema_name);
    }

    // Truncate if too long (PostgreSQL identifier limit is 63 chars)
    if schema_name.len() > 63 {
        schema_name.truncate(63);
    }

    schema_name
}

/// Normalize a string to be a valid PostgreSQL identifier.
/// Avoids polynomial regex by using string manipulation instead.
fn normalize_schema_name(input: &str) -> String {
    let mut chars: Vec<char> = Vec::new();
    let mut prev_was_underscore = false;

    for c in input.chars() {
        if c.is_alphanumeric() {
            chars.push(c);
            prev_was_underscore = false;
        } else if !prev_was_underscore {
            chars.push('_');
            prev_was_underscore = true;
        }
        // Skip consecutive non-alphanumeric characters
    }

    let result: String = chars.into_iter().collect();

    // Trim underscores from start and end
    result.trim_matches('_').to_string()
}

/// Schema namespace manager for plugin isolation.
pub struct SchemaNamespaceManager {
    pool: Arc<PgPool>,
}

impl SchemaNamespaceManager {
    /// Create a new schema namespace manager.
    pub fn new(pool: Arc<PgPool>) -> Self {
        Self { pool }
    }

    /// Ensure a database schema exists.
    ///
    /// # Arguments
    /// * `schema_name` - Schema name to create (must be a valid identifier)
    ///
    /// # Errors
    /// Returns error if schema name is invalid or creation fails
    pub async fn ensure_schema_exists(&self, schema_name: &str) -> Result<()> {
        if schema_name == "public" {
            return Ok(()); // public schema always exists
        }

        // Validate schema name to prevent SQL injection
        // Only allow alphanumeric and underscore
        if !schema_name.chars().all(|c| c.is_alphanumeric() || c == '_') {
            anyhow::bail!("Invalid schema name: {}", schema_name);
        }

        // Use quoted identifier for safety
        let query = format!(r#"CREATE SCHEMA IF NOT EXISTS "{}""#, schema_name);
        sqlx::query(&query)
            .execute(self.pool.as_ref())
            .await
            .context(format!("Failed to create schema {}", schema_name))?;

        debug!(schema_name, "Ensured schema exists");
        Ok(())
    }

    /// Get the expected schema name for a plugin.
    pub fn get_expected_schema_name(&self, plugin_name: &str) -> String {
        derive_schema_name(plugin_name)
    }

    /// Ensure the schema for a plugin exists.
    pub async fn ensure_plugin_schema(&self, plugin_name: &str) -> Result<String> {
        let schema_name = derive_schema_name(plugin_name);
        self.ensure_schema_exists(&schema_name).await?;
        Ok(schema_name)
    }

    /// Check if a schema exists.
    pub async fn schema_exists(&self, schema_name: &str) -> Result<bool> {
        let row = sqlx::query_scalar::<_, bool>(
            r#"
            SELECT EXISTS (
                SELECT 1 FROM information_schema.schemata
                WHERE schema_name = $1
            )
            "#,
        )
        .bind(schema_name)
        .fetch_one(self.pool.as_ref())
        .await
        .context("Failed to check schema existence")?;

        Ok(row)
    }

    /// List all plugin schemas (excluding system schemas).
    pub async fn list_plugin_schemas(&self) -> Result<Vec<String>> {
        let rows = sqlx::query_scalar::<_, String>(
            r#"
            SELECT schema_name 
            FROM information_schema.schemata
            WHERE schema_name NOT IN ('public', 'information_schema', 'pg_catalog', 'pg_toast', 'migrations')
            AND schema_name NOT LIKE 'pg_%'
            ORDER BY schema_name
            "#,
        )
        .fetch_all(self.pool.as_ref())
        .await
        .context("Failed to list schemas")?;

        Ok(rows)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_core_plugin_uses_public() {
        assert_eq!(derive_schema_name("@elizaos/plugin-sql"), "public");
    }

    #[test]
    fn test_scope_and_prefix_removed() {
        // npm scope and plugin- prefix are removed
        assert_eq!(derive_schema_name("@your-org/plugin-name"), "name");
        assert_eq!(derive_schema_name("@elizaos/plugin-bootstrap"), "bootstrap");
    }

    #[test]
    fn test_simple_names() {
        // Simple names without scope keep the structure
        assert_eq!(derive_schema_name("my-plugin"), "my_plugin");
        assert_eq!(derive_schema_name("plugin-test"), "test");
    }

    #[test]
    fn test_special_characters_normalized() {
        // Special characters get normalized
        assert_eq!(derive_schema_name("@org/plugin.name!"), "plugin_name");
        // Names starting with non-alpha get prefixed
        assert_eq!(derive_schema_name("123plugin"), "p_123plugin");
    }

    #[test]
    fn test_lowercase_conversion() {
        assert_eq!(derive_schema_name("@MyOrg/MyPlugin"), "myplugin");
        assert_eq!(derive_schema_name("@MyOrg/plugin-MyPlugin"), "myplugin");
    }

    #[test]
    fn test_reserved_names_handled() {
        // "public" alone would be reserved, so it gets prefixed
        assert_eq!(
            derive_schema_name("@org/plugin-public"),
            "plugin_org_plugin_public"
        );
    }

    #[test]
    fn test_empty_after_strip() {
        // Edge case: name is empty after stripping prefix
        assert_eq!(derive_schema_name("@org/plugin-"), "plugin_org_plugin");
    }
}
