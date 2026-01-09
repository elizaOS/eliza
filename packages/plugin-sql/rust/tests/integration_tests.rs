//! Integration tests for elizaOS Plugin SQL
//!
//! These tests verify database operations work correctly.

#[cfg(feature = "native")]
mod native_tests {
    use elizaos_core::{Bio, Character, Content, Memory, UUID};
    use elizaos_plugin_sql::{DatabaseAdapter, PostgresAdapter};

    /// Test creating and retrieving an agent
    #[tokio::test]
    #[ignore] // Requires PostgreSQL
    async fn test_agent_crud() {
        let connection_string = std::env::var("DATABASE_URL")
            .unwrap_or_else(|_| "postgres://localhost/eliza_test".to_string());

        let agent_id = UUID::new_v4();
        let adapter = PostgresAdapter::new(&connection_string, &agent_id)
            .await
            .expect("Failed to create adapter");

        adapter.init().await.expect("Failed to init");

        // Create character
        let character = Character {
            id: Some(agent_id.clone()),
            name: "TestAgent".to_string(),
            bio: Bio::Single("A test agent".to_string()),
            ..Default::default()
        };

        let agent = elizaos_core::Agent::from_character(character);

        // Create agent
        let created = adapter
            .create_agent(&agent)
            .await
            .expect("Failed to create agent");
        assert!(created);

        // Get agent
        let retrieved = adapter
            .get_agent(&agent_id)
            .await
            .expect("Failed to get agent");
        assert!(retrieved.is_some());

        let retrieved = retrieved.unwrap();
        assert_eq!(retrieved.character.name, "TestAgent");

        // Delete agent
        let deleted = adapter
            .delete_agent(&agent_id)
            .await
            .expect("Failed to delete agent");
        assert!(deleted);

        // Verify deleted
        let retrieved = adapter
            .get_agent(&agent_id)
            .await
            .expect("Failed to get agent");
        assert!(retrieved.is_none());
    }

    /// Test memory CRUD operations
    #[tokio::test]
    #[ignore] // Requires PostgreSQL
    async fn test_memory_crud() {
        let connection_string = std::env::var("DATABASE_URL")
            .unwrap_or_else(|_| "postgres://localhost/eliza_test".to_string());

        let agent_id = UUID::new_v4();
        let adapter = PostgresAdapter::new(&connection_string, &agent_id)
            .await
            .expect("Failed to create adapter");

        adapter.init().await.expect("Failed to init");

        // Create test data
        let entity_id = UUID::new_v4();
        let room_id = UUID::new_v4();

        let memory = Memory {
            id: None,
            entity_id: entity_id.clone(),
            agent_id: Some(agent_id.clone()),
            created_at: None,
            content: Content {
                text: Some("Test message".to_string()),
                ..Default::default()
            },
            embedding: None,
            room_id: room_id.clone(),
            world_id: None,
            unique: Some(true),
            similarity: None,
            metadata: None,
        };

        // Create memory
        let memory_id = adapter
            .create_memory(&memory, "messages", true)
            .await
            .expect("Failed to create memory");

        // Get memory
        let retrieved = adapter
            .get_memory_by_id(&memory_id)
            .await
            .expect("Failed to get memory");
        assert!(retrieved.is_some());

        let retrieved = retrieved.unwrap();
        assert_eq!(retrieved.content.text, Some("Test message".to_string()));

        // Delete memory
        adapter
            .delete_memory(&memory_id)
            .await
            .expect("Failed to delete memory");

        // Verify deleted
        let retrieved = adapter
            .get_memory_by_id(&memory_id)
            .await
            .expect("Failed to get memory");
        assert!(retrieved.is_none());
    }

    /// Test counting memories
    #[tokio::test]
    #[ignore] // Requires PostgreSQL
    async fn test_count_memories() {
        let connection_string = std::env::var("DATABASE_URL")
            .unwrap_or_else(|_| "postgres://localhost/eliza_test".to_string());

        let agent_id = UUID::new_v4();
        let adapter = PostgresAdapter::new(&connection_string, &agent_id)
            .await
            .expect("Failed to create adapter");

        adapter.init().await.expect("Failed to init");

        let room_id = UUID::new_v4();

        // Count should be 0 initially
        let count = adapter
            .count_memories(&room_id, false, Some("messages"))
            .await
            .expect("Failed to count memories");
        assert_eq!(count, 0);

        // Create some memories
        for i in 0..5 {
            let memory = Memory {
                id: None,
                entity_id: UUID::new_v4(),
                agent_id: Some(agent_id.clone()),
                created_at: None,
                content: Content {
                    text: Some(format!("Test message {}", i)),
                    ..Default::default()
                },
                embedding: None,
                room_id: room_id.clone(),
                world_id: None,
                unique: Some(true),
                similarity: None,
                metadata: None,
            };

            adapter
                .create_memory(&memory, "messages", true)
                .await
                .expect("Failed to create memory");
        }

        // Count should be 5 now
        let count = adapter
            .count_memories(&room_id, false, Some("messages"))
            .await
            .expect("Failed to count memories");
        assert_eq!(count, 5);

        // Delete all
        adapter
            .delete_all_memories(&room_id, "messages")
            .await
            .expect("Failed to delete all memories");

        // Count should be 0 again
        let count = adapter
            .count_memories(&room_id, false, Some("messages"))
            .await
            .expect("Failed to count memories");
        assert_eq!(count, 0);
    }

    /// Test cache operations
    #[tokio::test]
    #[ignore] // Requires PostgreSQL
    async fn test_cache() {
        let connection_string = std::env::var("DATABASE_URL")
            .unwrap_or_else(|_| "postgres://localhost/eliza_test".to_string());

        let agent_id = UUID::new_v4();
        let adapter = PostgresAdapter::new(&connection_string, &agent_id)
            .await
            .expect("Failed to create adapter");

        adapter.init().await.expect("Failed to init");

        // Set cache
        let data = serde_json::json!({
            "key": "value",
            "number": 42
        });

        adapter
            .set_cache("test_key", &data)
            .await
            .expect("Failed to set cache");

        // Get cache
        let retrieved: Option<serde_json::Value> = adapter
            .get_cache("test_key")
            .await
            .expect("Failed to get cache");

        assert!(retrieved.is_some());
        assert_eq!(retrieved.unwrap(), data);

        // Delete cache
        adapter
            .delete_cache("test_key")
            .await
            .expect("Failed to delete cache");

        // Verify deleted
        let retrieved: Option<serde_json::Value> = adapter
            .get_cache("test_key")
            .await
            .expect("Failed to get cache");
        assert!(retrieved.is_none());
    }
}
