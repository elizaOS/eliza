use elizaos_plugin_minecraft::{create_minecraft_plugin, MinecraftConfig};
use tokio::time::{sleep, Duration};

#[tokio::main]
async fn main() -> Result<(), String> {
    let mut plugin = create_minecraft_plugin(Some(MinecraftConfig { server_port: 3457 }));
    plugin.init().await?;

    plugin.handle_action("MC_CONNECT", "{}").await?;
    plugin.handle_action("MC_CHAT", "Hello from Rust!").await?;

    // Demonstrate all providers
    println!("=== World State ===");
    let world_state = plugin.get_provider("MC_WORLD_STATE").await?;
    println!("{}", serde_json::to_string_pretty(&world_state).unwrap_or_default());

    println!("\n=== Vision ===");
    let vision = plugin.get_provider("MC_VISION").await?;
    println!("{}", vision.get("text").and_then(|v| v.as_str()).unwrap_or(""));

    println!("\n=== Scan (stone, logs) ===");
    let scan_result = plugin.handle_action("MC_SCAN", r#"{"blocks": ["stone", "oak_log"], "radius": 16}"#).await?;
    println!("{}", serde_json::to_string_pretty(&scan_result).unwrap_or_default());

    // Waypoints demo
    println!("\n=== Set Waypoint 'spawn' ===");
    let wp_set = plugin.handle_action("MC_WAYPOINT_SET", "spawn").await?;
    println!("{}", serde_json::to_string_pretty(&wp_set).unwrap_or_default());

    println!("\n=== Waypoints Provider ===");
    let waypoints = plugin.get_provider("MC_WAYPOINTS").await?;
    println!("{}", waypoints.get("text").and_then(|v| v.as_str()).unwrap_or(""));

    println!("\n=== List Waypoints (action) ===");
    let wp_list = plugin.handle_action("MC_WAYPOINT_LIST", "").await?;
    println!("{}", serde_json::to_string_pretty(&wp_list).unwrap_or_default());

    // Minimal autonomous loop: keep walking forward
    let mut i = 0;
    loop {
        // Show vision context each iteration
        let vision = plugin.get_provider("MC_VISION").await?;
        let vision_text = vision.get("text").and_then(|v| v.as_str()).unwrap_or("");
        println!("\n[{}] {}", i, vision_text);

        plugin.handle_action("MC_CONTROL", "forward true 750").await?;
        if i % 4 == 0 {
            plugin.handle_action("MC_CONTROL", "jump true 250").await?;
        }
        i += 1;
        sleep(Duration::from_secs(1)).await;
    }
}

