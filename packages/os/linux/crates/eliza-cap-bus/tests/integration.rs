// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

//! End-to-end tests for the cap-bus server.

use std::path::PathBuf;
use std::time::SystemTime;

use eliza_cap_bus::{Request, ServerConfig, error_code, one_shot_request, spawn};
use eliza_types::Capability;

fn temp_dir(label: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_or(0, |d| d.subsec_nanos());
    let dir = std::env::temp_dir().join(format!(
        "usbeliza-capbus-{label}-{}-{nanos:x}",
        std::process::id(),
    ));
    std::fs::create_dir_all(&dir).expect("mktemp");
    dir
}

fn make_request(method: &str, params: Option<serde_json::Value>) -> Request {
    Request {
        jsonrpc: "2.0".into(),
        id: Some(serde_json::json!(1)),
        method: method.into(),
        params,
    }
}

#[tokio::test]
async fn time_read_returns_epoch_and_iso_timestamp() {
    let dir = temp_dir("time");
    let socket = dir.join("cap.sock");
    let handle = spawn(ServerConfig {
        slug: "calendar".into(),
        granted: vec![Capability::TimeRead],
        data_dir: dir.join("data"),
        socket_path: socket.clone(),
        socket_mode: None,
        notify: None,
        clipboard: None,
        network: None,
    })
    .await
    .expect("spawn");

    let response = one_shot_request(&socket, &make_request("time:read", None))
        .await
        .expect("rpc ok");
    assert!(response.error.is_none(), "got error: {:?}", response.error);
    let result = response.result.expect("result");
    assert!(result["epoch_ms"].as_u64().is_some());
    let iso = result["iso8601_utc"].as_str().expect("iso");
    assert!(iso.ends_with('Z'), "iso must end with Z: {iso}");
    assert_eq!(iso.len(), 20, "iso must be RFC3339 length: {iso}");

    handle.join().await.ok();
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn ungranted_capability_is_rejected_before_dispatch() {
    let dir = temp_dir("notgranted");
    let socket = dir.join("cap.sock");
    let handle = spawn(ServerConfig {
        slug: "calendar".into(),
        granted: vec![Capability::TimeRead], // network:fetch NOT granted
        data_dir: dir.join("data"),
        socket_path: socket.clone(),
        socket_mode: None,
        notify: None,
        clipboard: None,
        network: None,
    })
    .await
    .expect("spawn");

    let response = one_shot_request(&socket, &make_request("network:fetch", None))
        .await
        .expect("rpc ok");
    let err = response.error.expect("error");
    assert_eq!(err.code, error_code::CAPABILITY_NOT_GRANTED);

    handle.join().await.ok();
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn unknown_method_in_granted_set_returns_not_implemented() {
    let dir = temp_dir("notimpl");
    let socket = dir.join("cap.sock");
    // `files:open-dialog` is still a stub — it's declared in the v1
    // capability surface but the broker has no handler. Calling it
    // when granted should land on CAPABILITY_NOT_IMPLEMENTED.
    let handle = spawn(ServerConfig {
        slug: "x".into(),
        granted: vec![Capability::FilesOpenDialog],
        data_dir: dir.join("data"),
        socket_path: socket.clone(),
        socket_mode: None,
        notify: None,
        clipboard: None,
        network: None,
    })
    .await
    .expect("spawn");

    let response = one_shot_request(&socket, &make_request("files:open-dialog", None))
        .await
        .expect("rpc ok");
    let err = response.error.expect("error");
    assert_eq!(err.code, error_code::CAPABILITY_NOT_IMPLEMENTED);

    handle.join().await.ok();
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn storage_scoped_write_then_read_round_trips() {
    let dir = temp_dir("storage");
    let socket = dir.join("cap.sock");
    let data_dir = dir.join("data");
    let handle = spawn(ServerConfig {
        slug: "notes".into(),
        granted: vec![Capability::StorageScoped],
        data_dir: data_dir.clone(),
        socket_path: socket.clone(),
        socket_mode: None,
        notify: None,
        clipboard: None,
        network: None,
    })
    .await
    .expect("spawn");

    let write = one_shot_request(
        &socket,
        &make_request(
            "storage:scoped",
            Some(serde_json::json!({
                "op": "write",
                "key": "today.txt",
                "value": "remember the milk"
            })),
        ),
    )
    .await
    .expect("rpc ok");
    assert_eq!(write.error, None, "write returned error: {:?}", write.error);

    let read = one_shot_request(
        &socket,
        &make_request(
            "storage:scoped",
            Some(serde_json::json!({ "op": "read", "key": "today.txt" })),
        ),
    )
    .await
    .expect("rpc ok");
    let value = read.result.expect("result")["value"]
        .as_str()
        .map(str::to_owned);
    assert_eq!(value.as_deref(), Some("remember the milk"));

    handle.join().await.ok();
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn storage_scoped_rejects_path_traversal() {
    let dir = temp_dir("traversal");
    let socket = dir.join("cap.sock");
    let handle = spawn(ServerConfig {
        slug: "evil".into(),
        granted: vec![Capability::StorageScoped],
        data_dir: dir.join("data"),
        socket_path: socket.clone(),
        socket_mode: None,
        notify: None,
        clipboard: None,
        network: None,
    })
    .await
    .expect("spawn");

    for bad_key in ["../etc/passwd", "/etc/passwd", "a/b", "..\0xxx"] {
        let response = one_shot_request(
            &socket,
            &make_request(
                "storage:scoped",
                Some(serde_json::json!({ "op": "read", "key": bad_key })),
            ),
        )
        .await
        .expect("rpc ok");
        let err = response.error.expect("expected error for bad key");
        assert_eq!(
            err.code,
            error_code::INVALID_PARAMS,
            "key {bad_key:?} should be INVALID_PARAMS",
        );
    }

    handle.join().await.ok();
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn two_apps_cannot_read_each_others_storage() {
    // Two cap-bus servers, one per slug, with totally separate data dirs.
    // The fact that they bind to DIFFERENT socket paths is the isolation
    // boundary — neither app can connect to the other's socket because in
    // production it isn't bind-mounted into their bubblewrap (locked
    // decision #14). This test simulates that constraint by only ever
    // letting each "app" hold its own socket path.

    let dir = temp_dir("isolation");
    let calendar_socket = dir.join("cap-calendar.sock");
    let calendar_data = dir.join("calendar-data");
    let notes_socket = dir.join("cap-notes.sock");
    let notes_data = dir.join("notes-data");

    let calendar = spawn(ServerConfig {
        slug: "calendar".into(),
        granted: vec![Capability::StorageScoped],
        data_dir: calendar_data.clone(),
        socket_path: calendar_socket.clone(),
        socket_mode: None,
        notify: None,
        clipboard: None,
        network: None,
    })
    .await
    .expect("calendar spawn");

    let notes = spawn(ServerConfig {
        slug: "notes".into(),
        granted: vec![Capability::StorageScoped],
        data_dir: notes_data.clone(),
        socket_path: notes_socket.clone(),
        socket_mode: None,
        notify: None,
        clipboard: None,
        network: None,
    })
    .await
    .expect("notes spawn");

    // Calendar writes a secret. Notes writes its own.
    one_shot_request(
        &calendar_socket,
        &make_request(
            "storage:scoped",
            Some(serde_json::json!({
                "op": "write",
                "key": "secret.txt",
                "value": "calendar-only-data"
            })),
        ),
    )
    .await
    .expect("calendar write");
    one_shot_request(
        &notes_socket,
        &make_request(
            "storage:scoped",
            Some(serde_json::json!({
                "op": "write",
                "key": "secret.txt",
                "value": "notes-only-data"
            })),
        ),
    )
    .await
    .expect("notes write");

    // Each server can read only its own value, even though both wrote
    // under the same key name. This proves the data dirs are scoped.
    let calendar_read = one_shot_request(
        &calendar_socket,
        &make_request(
            "storage:scoped",
            Some(serde_json::json!({ "op": "read", "key": "secret.txt" })),
        ),
    )
    .await
    .expect("calendar read")
    .result
    .expect("result");
    assert_eq!(
        calendar_read["value"].as_str(),
        Some("calendar-only-data"),
        "calendar must see only its own data",
    );

    let notes_read = one_shot_request(
        &notes_socket,
        &make_request(
            "storage:scoped",
            Some(serde_json::json!({ "op": "read", "key": "secret.txt" })),
        ),
    )
    .await
    .expect("notes read")
    .result
    .expect("result");
    assert_eq!(
        notes_read["value"].as_str(),
        Some("notes-only-data"),
        "notes must see only its own data",
    );

    calendar.join().await.ok();
    notes.join().await.ok();
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn invalid_jsonrpc_version_is_rejected() {
    let dir = temp_dir("badrpc");
    let socket = dir.join("cap.sock");
    let handle = spawn(ServerConfig {
        slug: "x".into(),
        granted: vec![Capability::TimeRead],
        data_dir: dir.join("data"),
        socket_path: socket.clone(),
        socket_mode: None,
        notify: None,
        clipboard: None,
        network: None,
    })
    .await
    .expect("spawn");

    let bad = Request {
        jsonrpc: "1.0".into(),
        id: Some(serde_json::json!(1)),
        method: "time:read".into(),
        params: None,
    };
    let response = one_shot_request(&socket, &bad).await.expect("rpc ok");
    let err = response.error.expect("error");
    assert_eq!(err.code, error_code::INVALID_REQUEST);

    handle.join().await.ok();
    let _ = std::fs::remove_dir_all(dir);
}
