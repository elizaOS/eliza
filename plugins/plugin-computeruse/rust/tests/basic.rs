use elizaos_computeruse::{create_computeruse_plugin, ComputerUseConfig, ComputerUseMode};

#[tokio::test]
async fn init_disabled_is_noop() {
    let cfg = ComputerUseConfig {
        enabled: false,
        mode: ComputerUseMode::Auto,
        ..Default::default()
    };
    let mut plugin = create_computeruse_plugin(Some(cfg));
    plugin.init().await.unwrap();
    assert!(plugin.backend().is_none());
}

#[tokio::test]
async fn local_mode_init() {
    let cfg = ComputerUseConfig {
        enabled: true,
        mode: ComputerUseMode::Local,
        ..Default::default()
    };
    let mut plugin = create_computeruse_plugin(Some(cfg));

    // All platforms support local mode now
    // May succeed or fail depending on platform capabilities (GUI session, permissions, etc.)
    let _ = plugin.init().await;
}
