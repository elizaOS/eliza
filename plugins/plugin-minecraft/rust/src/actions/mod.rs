use crate::services::MinecraftService;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;

/// Scan result from the Mineflayer server
#[derive(Debug)]
pub struct ScanResult {
    pub blocks: Vec<Value>,
    pub count: usize,
}

pub async fn mc_connect(service: Arc<MinecraftService>) -> Result<String, String> {
    service.create_bot(HashMap::new()).await
}

pub async fn mc_disconnect(service: Arc<MinecraftService>) -> Result<(), String> {
    let bot_id = match service.current_bot_id().await {
        Some(id) => id,
        None => return Ok(()),
    };
    service.destroy_bot(&bot_id).await
}

pub async fn mc_chat(service: Arc<MinecraftService>, message: &str) -> Result<(), String> {
    let mut data = HashMap::new();
    data.insert("message".to_string(), Value::String(message.to_string()));
    let _ = service.request("chat", data).await?;
    Ok(())
}

pub async fn mc_goto(service: Arc<MinecraftService>, x: f64, y: f64, z: f64) -> Result<(), String> {
    let mut data = HashMap::new();
    data.insert("x".to_string(), Value::Number(serde_json::Number::from_f64(x).ok_or("bad x")?));
    data.insert("y".to_string(), Value::Number(serde_json::Number::from_f64(y).ok_or("bad y")?));
    data.insert("z".to_string(), Value::Number(serde_json::Number::from_f64(z).ok_or("bad z")?));
    let _ = service.request("goto", data).await?;
    Ok(())
}

pub async fn mc_stop(service: Arc<MinecraftService>) -> Result<(), String> {
    let _ = service.request("stop", HashMap::new()).await?;
    Ok(())
}

pub async fn mc_dig(service: Arc<MinecraftService>, x: f64, y: f64, z: f64) -> Result<(), String> {
    let mut data = HashMap::new();
    data.insert("x".to_string(), Value::Number(serde_json::Number::from_f64(x).ok_or("bad x")?));
    data.insert("y".to_string(), Value::Number(serde_json::Number::from_f64(y).ok_or("bad y")?));
    data.insert("z".to_string(), Value::Number(serde_json::Number::from_f64(z).ok_or("bad z")?));
    let _ = service.request("dig", data).await?;
    Ok(())
}

pub async fn mc_place(
    service: Arc<MinecraftService>,
    x: f64,
    y: f64,
    z: f64,
    face: &str,
) -> Result<(), String> {
    let mut data = HashMap::new();
    data.insert("x".to_string(), Value::Number(serde_json::Number::from_f64(x).ok_or("bad x")?));
    data.insert("y".to_string(), Value::Number(serde_json::Number::from_f64(y).ok_or("bad y")?));
    data.insert("z".to_string(), Value::Number(serde_json::Number::from_f64(z).ok_or("bad z")?));
    data.insert("face".to_string(), Value::String(face.to_string()));
    let _ = service.request("place", data).await?;
    Ok(())
}

pub async fn mc_look(service: Arc<MinecraftService>, yaw: f64, pitch: f64) -> Result<(), String> {
    let mut data = HashMap::new();
    data.insert("yaw".to_string(), Value::Number(serde_json::Number::from_f64(yaw).ok_or("bad yaw")?));
    data.insert("pitch".to_string(), Value::Number(serde_json::Number::from_f64(pitch).ok_or("bad pitch")?));
    let _ = service.request("look", data).await?;
    Ok(())
}

pub async fn mc_control(
    service: Arc<MinecraftService>,
    control: &str,
    state: bool,
    duration_ms: Option<u64>,
) -> Result<(), String> {
    let mut data = HashMap::new();
    data.insert("control".to_string(), Value::String(control.to_string()));
    data.insert("state".to_string(), Value::Bool(state));
    if let Some(ms) = duration_ms {
        data.insert("durationMs".to_string(), Value::Number(serde_json::Number::from(ms)));
    }
    let _ = service.request("control", data).await?;
    Ok(())
}

pub async fn mc_attack(service: Arc<MinecraftService>, entity_id: i64) -> Result<(), String> {
    let mut data = HashMap::new();
    data.insert("entityId".to_string(), Value::Number(serde_json::Number::from(entity_id)));
    let _ = service.request("attack", data).await?;
    Ok(())
}

/// Scan for nearby blocks
/// blocks: optional list of block names to filter
/// radius: scan radius (default 16)
/// max_results: maximum results to return (default 32)
pub async fn mc_scan(
    service: Arc<MinecraftService>,
    blocks: Option<Vec<String>>,
    radius: Option<u32>,
    max_results: Option<u32>,
) -> Result<ScanResult, String> {
    let mut data = HashMap::new();
    if let Some(b) = blocks {
        data.insert(
            "blocks".to_string(),
            Value::Array(b.into_iter().map(Value::String).collect()),
        );
    }
    if let Some(r) = radius {
        data.insert("radius".to_string(), Value::Number(r.into()));
    }
    if let Some(m) = max_results {
        data.insert("maxResults".to_string(), Value::Number(m.into()));
    }
    let result = service.request("scan", data).await?;
    let blocks_arr = result
        .get("blocks")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let count = blocks_arr.len();
    Ok(ScanResult {
        blocks: blocks_arr,
        count,
    })
}

