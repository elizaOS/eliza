use anyhow::Result;
use elizaos::runtime::{AgentRuntime, RuntimeOptions};
use elizaos_plugin_xai::{create_xai_elizaos_plugin, start_x_service};
use std::sync::Arc;

#[tokio::test]
async fn smoke_startup_without_network() -> Result<()> {
    // Ensure the X service starts in "all disabled" mode (no network calls).
    std::env::set_var("XAI_API_KEY", "test");
    std::env::set_var("X_ENABLE_REPLIES", "false");
    std::env::remove_var("X_ENABLE_POST");
    std::env::remove_var("X_ENABLE_ACTIONS");
    std::env::remove_var("X_ENABLE_DISCOVERY");

    let runtime = Arc::new(
        AgentRuntime::new(RuntimeOptions {
            check_should_respond: Some(false),
            plugins: vec![create_xai_elizaos_plugin()?],
            ..Default::default()
        })
        .await?,
    );
    runtime.initialize().await?;

    let _svc = start_x_service(Arc::clone(&runtime)).await?;
    assert!(runtime.get_service("x").await.is_some());

    runtime.stop().await?;
    Ok(())
}

