#![allow(missing_docs)]
//! PGLite connection manager for elizaOS WASM environments

#![cfg(all(feature = "wasm", target_arch = "wasm32"))]

use anyhow::Result;
use js_sys::{Array, Object, Promise, Reflect};
use tracing::{debug, info};
use wasm_bindgen::JsValue;
use wasm_bindgen::JsCast;
use wasm_bindgen_futures::JsFuture;

/// PGLite connection manager for WASM
pub struct PgLiteManager {
    /// The PGLite instance (JavaScript object)
    pglite: JsValue,
    /// Whether the database is initialized
    initialized: bool,
}

// In wasm32 we are single-threaded; JS values are safe to access within the same thread.
// We mark the wrapper as Send/Sync so it can satisfy the `DatabaseAdapter: Send + Sync` bound.
#[cfg(target_arch = "wasm32")]
unsafe impl Send for PgLiteManager {}
#[cfg(target_arch = "wasm32")]
unsafe impl Sync for PgLiteManager {}

impl PgLiteManager {
    /// Create a new PGLite manager
    ///
    /// # Arguments
    /// * `data_dir` - Optional directory for persistent storage
    pub async fn new(data_dir: Option<&str>) -> Result<Self> {
        info!("Creating PGLite instance...");

        let options = Object::new();

        if let Some(dir) = data_dir {
            Reflect::set(
                &options,
                &JsValue::from_str("dataDir"),
                &JsValue::from_str(dir),
            )
            .map_err(|e| anyhow::anyhow!("Failed to set dataDir: {:?}", e))?;
        }

        // In WASM, we'll use the global PGlite from the JavaScript environment
        // The actual instantiation happens via JavaScript interop
        let pglite = JsValue::undefined();

        Ok(PgLiteManager {
            pglite,
            initialized: false,
        })
    }

    /// Initialize the PGLite connection
    pub async fn init(&mut self, pglite_js: JsValue) -> Result<()> {
        self.pglite = pglite_js;
        self.initialized = true;
        info!("PGLite initialized successfully");
        Ok(())
    }

    /// Execute a query and return results
    pub async fn query(&self, sql: &str, params: &[JsValue]) -> Result<JsValue> {
        if !self.initialized {
            anyhow::bail!("PGLite not initialized");
        }

        let params_array = Array::new();
        for param in params {
            params_array.push(param);
        }

        let query_fn: js_sys::Function = Reflect::get(&self.pglite, &JsValue::from_str("query"))
            .map_err(|e| anyhow::anyhow!("Failed to get query method: {:?}", e))?
            .dyn_into()
            .map_err(|e| anyhow::anyhow!("PGlite.query is not a function: {:?}", e))?;

        let promise = query_fn
            .apply(&self.pglite, &Array::of2(&JsValue::from_str(sql), &params_array))
            .map_err(|e| anyhow::anyhow!("Failed to call query: {:?}", e))?;

        let promise = Promise::from(promise);
        JsFuture::from(promise)
            .await
            .map_err(|e| anyhow::anyhow!("Query failed: {:?}", e))
    }

    /// Execute SQL without returning results
    pub async fn exec(&self, sql: &str) -> Result<()> {
        if !self.initialized {
            anyhow::bail!("PGLite not initialized");
        }

        let exec_fn: js_sys::Function = Reflect::get(&self.pglite, &JsValue::from_str("exec"))
            .map_err(|e| anyhow::anyhow!("Failed to get exec method: {:?}", e))?
            .dyn_into()
            .map_err(|e| anyhow::anyhow!("PGlite.exec is not a function: {:?}", e))?;

        let promise = exec_fn
            .apply(&self.pglite, &Array::of1(&JsValue::from_str(sql)))
            .map_err(|e| anyhow::anyhow!("Failed to call exec: {:?}", e))?;

        let promise = Promise::from(promise);
        JsFuture::from(promise)
            .await
            .map_err(|e| anyhow::anyhow!("Exec failed: {:?}", e))?;

        Ok(())
    }

    /// Close the database connection
    pub async fn close(&self) -> Result<()> {
        if !self.initialized {
            return Ok(());
        }

        let close_fn: js_sys::Function = Reflect::get(&self.pglite, &JsValue::from_str("close"))
            .map_err(|e| anyhow::anyhow!("Failed to get close method: {:?}", e))?
            .dyn_into()
            .map_err(|e| anyhow::anyhow!("PGlite.close is not a function: {:?}", e))?;

        let promise = close_fn
            .apply(&self.pglite, &Array::new())
            .map_err(|e| anyhow::anyhow!("Failed to call close: {:?}", e))?;

        let promise = Promise::from(promise);
        JsFuture::from(promise)
            .await
            .map_err(|e| anyhow::anyhow!("Close failed: {:?}", e))?;

        debug!("PGLite connection closed");
        Ok(())
    }

    /// Check if the database is initialized
    pub fn is_initialized(&self) -> bool {
        self.initialized
    }

    /// Run database migrations
    pub async fn run_migrations(&self) -> Result<()> {
        use crate::schema::*;

        // Create vector extension
        self.exec(embedding::ENSURE_VECTOR_EXTENSION).await?;

        let embeddings_table_sql = embedding::create_embeddings_table_sql(embedding::DEFAULT_DIMENSION);

        // Create tables in order (respecting foreign key constraints)
        let migrations = vec![
            agent::CREATE_AGENTS_TABLE,
            agent::CREATE_AGENTS_INDEXES,
            world::CREATE_WORLDS_TABLE,
            world::CREATE_WORLDS_INDEXES,
            entity::CREATE_ENTITIES_TABLE,
            entity::CREATE_ENTITIES_INDEXES,
            room::CREATE_ROOMS_TABLE,
            room::CREATE_ROOMS_INDEXES,
            memory::CREATE_MEMORIES_TABLE,
            memory::CREATE_MEMORIES_INDEXES,
            embeddings_table_sql.as_str(),
            embedding::CREATE_EMBEDDINGS_INDEXES,
            component::CREATE_COMPONENTS_TABLE,
            component::CREATE_COMPONENTS_INDEXES,
            participant::CREATE_PARTICIPANTS_TABLE,
            participant::CREATE_PARTICIPANTS_INDEXES,
            relationship::CREATE_RELATIONSHIPS_TABLE,
            relationship::CREATE_RELATIONSHIPS_INDEXES,
            task::CREATE_TASKS_TABLE,
            task::CREATE_TASKS_INDEXES,
            log::CREATE_LOGS_TABLE,
            log::CREATE_LOGS_INDEXES,
            cache::CREATE_CACHE_TABLE,
            cache::CREATE_CACHE_INDEXES,
        ];

        for migration in migrations {
            self.exec(migration).await?;
        }

        info!("PGLite migrations completed successfully");
        Ok(())
    }
}
