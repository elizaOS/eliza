use anyhow::Result;
use elizaos_plugin_computeruse::create_computeruse_plugin;
use serde_json::json;

#[tokio::main]
async fn main() -> Result<()> {
    std::env::set_var("COMPUTERUSE_ENABLED", std::env::var("COMPUTERUSE_ENABLED").unwrap_or("true".to_string()));
    std::env::set_var("COMPUTERUSE_MODE", std::env::var("COMPUTERUSE_MODE").unwrap_or("auto".to_string()));

    let mut plugin = create_computeruse_plugin(None);
    plugin.init().await?;
    println!("ComputerUse backend: {:?}", plugin.backend());

    let apps = plugin.handle_action("COMPUTERUSE_GET_APPLICATIONS", json!({})).await?;
    println!("GET_APPLICATIONS:\n{}", apps);

    // Optional: open calculator (Windows)
    let _ = plugin
        .handle_action("COMPUTERUSE_OPEN_APPLICATION", json!({ "name": "calc" }))
        .await;

    plugin.stop().await;
    Ok(())
}

