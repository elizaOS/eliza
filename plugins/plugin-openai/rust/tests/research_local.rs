//! Local server test for deep research (no mocks, no external API).

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use elizaos_plugin_openai::{OpenAIClient, OpenAIConfig, ResearchParams};

fn handle_connection(mut stream: TcpStream, last_body: Arc<Mutex<Option<String>>>) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let mut buffer = Vec::new();
    let _ = stream.read_to_end(&mut buffer);

    let request = String::from_utf8_lossy(&buffer);
    let mut body = String::new();
    if let Some(split) = request.split("\r\n\r\n").nth(1) {
        body = split.to_string();
    }
    *last_body.lock().expect("lock poisoned") = Some(body);

    let response_body = r#"{
  "id": "resp_local",
  "output_text": "Local research response.",
  "output": [
    {
      "type": "message",
      "content": [
        {
          "type": "output_text",
          "text": "Local research response.",
          "annotations": [
            {
              "url": "https://example.com",
              "title": "Example Source",
              "start_index": 0,
              "end_index": 24
            }
          ]
        }
      ]
    }
  ]
}"#;

    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
        response_body.len(),
        response_body
    );
    let _ = stream.write_all(response.as_bytes());
}

#[tokio::test]
async fn test_deep_research_local_server() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let addr = listener.local_addr().expect("addr");
    let last_body: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));

    let last_body_clone = Arc::clone(&last_body);
    thread::spawn(move || {
        if let Ok((stream, _)) = listener.accept() {
            handle_connection(stream, last_body_clone);
        }
    });

    let config = OpenAIConfig::new("sk-test-key-1234567890")
        .base_url(&format!("http://{}", addr));
    let client = OpenAIClient::new(config).expect("client");

    let params = ResearchParams::new("Test research question");
    let result = client
        .deep_research(&params)
        .await
        .expect("research");

    assert_eq!(result.text, "Local research response.");
    assert_eq!(result.annotations.len(), 1);

    let body = last_body.lock().expect("lock poisoned").clone().unwrap_or_default();
    assert!(body.contains("\"tools\""));
    assert!(body.contains("web_search_preview"));
}
