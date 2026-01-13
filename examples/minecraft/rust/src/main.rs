use elizaos_plugin_minecraft::{create_minecraft_plugin, MinecraftConfig};
use tokio::time::{sleep, Duration};

#[tokio::main]
async fn main() -> Result<(), String> {
    let mut plugin = create_minecraft_plugin(Some(MinecraftConfig { server_port: 3457 }));
    plugin.init().await?;

    plugin.handle_action("MC_CONNECT", "{}").await?;
    plugin.handle_action("MC_CHAT", "Hello from Rust!").await?;

    loop {
        let state = plugin.get_provider("MC_WORLD_STATE").await?;
        println!("{}", state);
        plugin.handle_action("MC_CONTROL", "forward true 750").await?;
        sleep(Duration::from_secs(1)).await;
    }
}

