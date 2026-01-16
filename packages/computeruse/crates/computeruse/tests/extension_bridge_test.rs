use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use computeruse::extension_bridge::ExtensionBridge;
use tokio_tungstenite::{connect_async, tungstenite::Message};

#[tokio::test]
#[ignore = "won't work in ci cd"]
async fn extension_bridge_roundtrip() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter("info")
        .with_test_writer()
        .try_init();

    // Ensure bridge server is up
    let bridge = ExtensionBridge::global().await;

    // Connect a fake extension client
    let (mut ws, _) = connect_async("ws://127.0.0.1:17373")
        .await
        .expect("ws connect");
    // Send hello
    ws.send(Message::Text(r#"{"type":"hello","from":"test"}"#.into()))
        .await
        .expect("send hello");

    // Spawn a listener to echo EvalResult for a specific id
    let (mut writer, mut reader) = ws.split();

    // Wait until server has registered this client
    for _ in 0..50 {
        if bridge.is_client_connected().await {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }

    // Prepare an eval request via the bridge (run concurrently)
    let code = "(()=>{return 'ok';})()";
    let bridge_for_task = bridge.clone();
    let eval_handle = tokio::spawn(async move {
        bridge_for_task
            .eval_in_active_tab(code, Duration::from_secs(3))
            .await
    });

    // Read the outgoing request (with timeout) and respond
    let mut captured_id: Option<String> = None;
    for _ in 0..100 {
        if let Ok(Some(Ok(msg))) =
            tokio::time::timeout(Duration::from_millis(100), reader.next()).await
        {
            let txt = msg.into_text().unwrap_or_default();
            tracing::info!("Client saw outgoing: {}", txt);
            if txt.contains("\"action\":\"eval\"") {
                let id = txt
                    .split("\"id\":\"")
                    .nth(1)
                    .and_then(|s| s.split('\"').next())
                    .map(|s| s.to_string());
                if let Some(id) = id {
                    captured_id = Some(id);
                    break;
                }
            }
        }
    }
    let id = captured_id.expect("Did not receive eval request from server");
    let reply = format!(r#"{{"id":"{id}","ok":true,"result":"ok"}}"#);
    tracing::info!("Client sending EvalResult: {}", reply);
    writer
        .send(Message::Text(reply))
        .await
        .expect("send result");

    let res = eval_handle
        .await
        .expect("eval task join")
        .expect("bridge eval");
    tracing::info!(?res, "Bridge eval completed");
    assert_eq!(res, Some("ok".to_string()));
}
