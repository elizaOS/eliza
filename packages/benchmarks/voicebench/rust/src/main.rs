use anyhow::{Context, Result};
use base64::engine::general_purpose::{STANDARD as BASE64_STANDARD, URL_SAFE as BASE64_URL_SAFE};
use base64::Engine as _;
use elizaos::runtime::{AgentRuntime, RuntimeOptions};
use elizaos::services::IMessageService;
use elizaos::types::agent::{Character, CharacterSettings};
use elizaos::types::components::HandlerCallback;
use elizaos::types::memory::{Memory, MemoryMetadata};
use elizaos::types::primitives::{as_uuid, Content, UUID};
use elizaos_plugin_elevenlabs::create_elevenlabs_elizaos_plugin;
use elizaos_plugin_groq::create_groq_elizaos_plugin;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Instant;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct VoicebenchMode {
    id: String,
    description: String,
    benchmark_context: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct VoicebenchConfig {
    benchmark_name: String,
    default_iterations: u32,
    response_prompt: String,
    response_max_chars: Option<usize>,
    modes: Vec<VoicebenchMode>,
}

#[derive(Debug, Clone)]
struct DatasetSample {
    id: String,
    audio_path: PathBuf,
    expected_text: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ContextIn {
    transcript: String,
    benchmark_context: String,
    prompt: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ContextOut {
    response: String,
    state_excerpt: String,
    actions: Vec<String>,
    providers: Vec<String>,
    model_input: String,
    model_output_raw: String,
    model_output_clean: String,
    model_output_has_thinking_tag: bool,
    model_output_has_xml: bool,
    model_output_thought_tag_count: usize,
    model_output_xml_tag_count: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ResponseSegmentation {
    first_sentence: String,
    remainder: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TrajectoryData {
    llm_call_count: usize,
    provider_access_count: usize,
    llm_calls: Vec<HashMap<String, Value>>,
    provider_accesses: Vec<HashMap<String, Value>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct IterationResult {
    mode: String,
    sample_id: String,
    sample_audio_path: String,
    iteration: u32,
    profile: String,
    expected_transcript: Option<String>,
    transcription_exact_match: Option<bool>,
    transcription_normalized_match: Option<bool>,
    transcription_ms: f64,
    response_ttft_ms: f64,
    response_total_ms: f64,
    speech_to_response_start_ms: f64,
    speech_to_voice_start_uncached_ms: f64,
    speech_to_voice_start_cached_ms: f64,
    voice_generation_ms: f64,
    voice_first_token_uncached_ms: f64,
    voice_first_token_cached_ms: f64,
    tts_first_sentence_cache_hit: bool,
    tts_remainder_ms: f64,
    tts_cached_pipeline_ms: f64,
    end_to_end_ms: f64,
    in_context: ContextIn,
    out_context: ContextOut,
    trajectory: TrajectoryData,
    tts_output_bytes: usize,
    tts_first_sentence_uncached_bytes: usize,
    tts_first_sentence_cached_bytes: usize,
    tts_remainder_bytes: usize,
    tts_cached_pipeline_bytes: usize,
    response_char_count: usize,
    response_was_capped: bool,
    response_segmentation: ResponseSegmentation,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ModeSummary {
    runs: usize,
    avg_transcription_ms: f64,
    avg_response_ttft_ms: f64,
    avg_response_total_ms: f64,
    avg_speech_to_response_start_ms: f64,
    avg_speech_to_voice_start_uncached_ms: f64,
    avg_speech_to_voice_start_cached_ms: f64,
    avg_voice_generation_ms: f64,
    avg_voice_first_token_uncached_ms: f64,
    avg_voice_first_token_cached_ms: f64,
    avg_tts_cached_pipeline_ms: f64,
    p95_transcription_ms: f64,
    p99_transcription_ms: f64,
    p95_response_ttft_ms: f64,
    p99_response_ttft_ms: f64,
    p95_response_total_ms: f64,
    p99_response_total_ms: f64,
    p95_speech_to_response_start_ms: f64,
    p99_speech_to_response_start_ms: f64,
    p95_speech_to_voice_start_uncached_ms: f64,
    p99_speech_to_voice_start_uncached_ms: f64,
    p95_speech_to_voice_start_cached_ms: f64,
    p99_speech_to_voice_start_cached_ms: f64,
    p95_voice_generation_ms: f64,
    p99_voice_generation_ms: f64,
    p95_voice_first_token_uncached_ms: f64,
    p99_voice_first_token_uncached_ms: f64,
    p95_voice_first_token_cached_ms: f64,
    p99_voice_first_token_cached_ms: f64,
    p95_tts_cached_pipeline_ms: f64,
    p99_tts_cached_pipeline_ms: f64,
    first_sentence_cache_hit_rate: f64,
    transcription_normalized_accuracy: f64,
    avg_end_to_end_ms: f64,
    p95_end_to_end_ms: f64,
    p99_end_to_end_ms: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BenchmarkOutput {
    benchmark: String,
    runtime: String,
    profile: String,
    timestamp: String,
    iterations: u32,
    dataset_name: String,
    dataset_path: Option<String>,
    sample_count: usize,
    modes: Vec<VoicebenchMode>,
    results: Vec<IterationResult>,
    summary: HashMap<String, ModeSummary>,
}

fn shared_dir() -> PathBuf {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    manifest.join("..").join("shared")
}

fn parse_arg(key: &str) -> Option<String> {
    let prefix = format!("--{}=", key);
    std::env::args()
        .skip(1)
        .find(|arg| arg.starts_with(&prefix))
        .map(|arg| arg[prefix.len()..].to_string())
}

fn truncate(text: &str, max_len: usize) -> String {
    if text.chars().count() <= max_len {
        text.to_string()
    } else if max_len <= 3 {
        ".".repeat(max_len)
    } else {
        let mut out = String::with_capacity(max_len);
        for ch in text.chars().take(max_len - 3) {
            out.push(ch);
        }
        out.push_str("...");
        out
    }
}

fn round_ms(value: f64) -> f64 {
    (value * 1000.0).round() / 1000.0
}

fn average(values: &[f64]) -> f64 {
    if values.is_empty() {
        0.0
    } else {
        values.iter().sum::<f64>() / values.len() as f64
    }
}

fn normalize_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut last_was_space = false;

    for ch in text.chars().flat_map(|c| c.to_lowercase()) {
        let mapped = if ch.is_ascii_alphanumeric() || ch.is_ascii_whitespace() {
            ch
        } else {
            ' '
        };
        if mapped.is_ascii_whitespace() {
            if !last_was_space {
                out.push(' ');
                last_was_space = true;
            }
        } else {
            out.push(mapped);
            last_was_space = false;
        }
    }

    out.trim().to_string()
}

fn normalize_cache_key_text(text: &str) -> String {
    let mut compact = String::new();
    let mut last_was_space = false;

    for ch in text.chars().flat_map(|c| c.to_lowercase()) {
        if ch.is_whitespace() {
            if !last_was_space {
                compact.push(' ');
                last_was_space = true;
            }
        } else {
            compact.push(ch);
            last_was_space = false;
        }
    }

    let compact = compact.trim();
    let mut out = String::with_capacity(compact.len());
    let mut chars = compact.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == ' ' {
            if let Some(next) = chars.peek() {
                if matches!(next, '.' | ',' | '!' | '?' | ';' | ':') {
                    continue;
                }
            }
        }
        out.push(ch);
    }
    out
}

fn enforce_response_budget(text: &str, max_chars: usize) -> (String, bool) {
    let compact = text
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string();

    if max_chars == 0 || compact.chars().count() <= max_chars {
        return (compact, false);
    }

    let head: String = compact.chars().take(max_chars).collect();
    let boundary = [". ", "! ", "? ", ", ", "; ", ": ", " "]
        .iter()
        .filter_map(|needle| head.rfind(needle))
        .max()
        .unwrap_or(0);
    let min_boundary = ((max_chars as f64) * 0.6).floor() as usize;
    let mut bounded = if boundary >= min_boundary {
        head[..boundary].trim().to_string()
    } else {
        head.trim().to_string()
    };
    if !bounded.ends_with('.') && !bounded.ends_with('!') && !bounded.ends_with('?') {
        bounded.push('.');
    }
    (bounded, true)
}

fn percentile(values: &[f64], p: f64) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let rank = ((p / 100.0) * sorted.len() as f64).ceil() as usize;
    let index = rank.saturating_sub(1).min(sorted.len().saturating_sub(1));
    sorted[index]
}

fn split_first_sentence(text: &str) -> (String, String) {
    let stripped = text.trim();
    if stripped.is_empty() {
        return (String::new(), String::new());
    }

    for (idx, ch) in stripped.char_indices() {
        if !matches!(ch, '.' | '!' | '?') {
            continue;
        }

        let mut end = idx + ch.len_utf8();
        while end < stripped.len() {
            let maybe_quote = stripped[end..].chars().next();
            let Some(next_ch) = maybe_quote else {
                break;
            };
            if matches!(next_ch, '"' | '\'' | ')' | ']') {
                end += next_ch.len_utf8();
                continue;
            }
            break;
        }

        if end < stripped.len() {
            let maybe_sep = stripped[end..].chars().next();
            if let Some(sep) = maybe_sep {
                if sep.is_whitespace() {
                    let first = stripped[..end].trim();
                    let remainder = stripped[end..].trim();
                    if first.is_empty() {
                        return (stripped.to_string(), String::new());
                    }
                    return (first.to_string(), remainder.to_string());
                }
            }
        }
    }

    (stripped.to_string(), String::new())
}

#[derive(Debug, Clone)]
struct ModelOutputInspection {
    cleaned: String,
    has_thinking_tag: bool,
    has_xml_tag: bool,
    thought_tag_count: usize,
    xml_tag_count: usize,
}

fn inspect_model_output(raw: &str) -> ModelOutputInspection {
    let lower = raw.to_lowercase();
    let thought_open_count = ["<think", "<thinking", "<thought"]
        .iter()
        .map(|needle| lower.match_indices(needle).count())
        .sum::<usize>();
    let thought_close_count = ["</think", "</thinking", "</thought"]
        .iter()
        .map(|needle| lower.match_indices(needle).count())
        .sum::<usize>();
    let thought_tag_count = thought_open_count + thought_close_count;

    let mut xml_tag_count = 0usize;
    let mut cleaned = String::with_capacity(raw.len());
    let mut in_tag = false;
    for ch in raw.chars() {
        if ch == '<' {
            in_tag = true;
            xml_tag_count += 1;
            cleaned.push(' ');
            continue;
        }
        if in_tag {
            if ch == '>' {
                in_tag = false;
            }
            continue;
        }
        cleaned.push(ch);
    }
    let cleaned = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");

    ModelOutputInspection {
        cleaned,
        has_thinking_tag: thought_tag_count > 0,
        has_xml_tag: xml_tag_count > 0,
        thought_tag_count,
        xml_tag_count,
    }
}

fn maybe_decode_base64_audio(raw: &str) -> Option<Vec<u8>> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Some(Vec::new());
    }

    let payload = if trimmed.starts_with("data:") && trimmed.contains(',') {
        trimmed
            .split_once(',')
            .map(|(_, right)| right)
            .unwrap_or(trimmed)
    } else {
        trimmed
    };

    let compact: String = payload
        .chars()
        .filter(|ch| !ch.is_ascii_whitespace())
        .collect();
    if compact.len() < 16 {
        return None;
    }
    if !compact
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '+' | '/' | '=' | '-' | '_'))
    {
        return None;
    }

    let mut padded = compact.clone();
    let rem = padded.len() % 4;
    if rem != 0 {
        padded.push_str(&"=".repeat(4 - rem));
    }

    BASE64_STANDARD
        .decode(padded.as_bytes())
        .or_else(|_| BASE64_URL_SAFE.decode(padded.as_bytes()))
        .ok()
}

fn decode_audio_output_bytes(raw: &str) -> Vec<u8> {
    maybe_decode_base64_audio(raw).unwrap_or_else(|| raw.as_bytes().to_vec())
}

fn load_config() -> Result<VoicebenchConfig> {
    let path = shared_dir().join("config.json");
    let raw = fs::read_to_string(&path)
        .with_context(|| format!("Failed to read config: {}", path.display()))?;
    let config = serde_json::from_str::<VoicebenchConfig>(&raw)
        .with_context(|| "Failed to parse voicebench config")?;
    Ok(config)
}

fn load_dataset_samples(dataset_path: &Path) -> Result<(String, Vec<DatasetSample>)> {
    let raw = fs::read_to_string(dataset_path).with_context(|| {
        format!(
            "Failed to read dataset manifest: {}",
            dataset_path.display()
        )
    })?;
    let parsed = serde_json::from_str::<Value>(&raw).with_context(|| {
        format!(
            "Failed to parse dataset manifest: {}",
            dataset_path.display()
        )
    })?;

    let dataset_name = parsed
        .get("datasetName")
        .and_then(Value::as_str)
        .or_else(|| parsed.get("name").and_then(Value::as_str))
        .map(ToString::to_string)
        .unwrap_or_else(|| {
            dataset_path
                .file_stem()
                .and_then(|v| v.to_str())
                .unwrap_or("voicebench-dataset")
                .to_string()
        });

    let raw_samples = parsed
        .get("samples")
        .and_then(Value::as_array)
        .with_context(|| format!("Dataset has no samples: {}", dataset_path.display()))?;
    if raw_samples.is_empty() {
        return Err(anyhow::anyhow!(
            "Dataset has no samples: {}",
            dataset_path.display()
        ));
    }

    let mut samples = Vec::with_capacity(raw_samples.len());
    let dataset_parent = dataset_path.parent().unwrap_or_else(|| Path::new("."));
    for (idx, entry) in raw_samples.iter().enumerate() {
        let sample = entry
            .as_object()
            .with_context(|| format!("Dataset sample {} is not an object", idx + 1))?;
        let id = sample
            .get("id")
            .and_then(Value::as_str)
            .map(ToString::to_string)
            .unwrap_or_else(|| format!("sample-{}", idx + 1));

        let audio_path_raw = sample
            .get("audioPath")
            .and_then(Value::as_str)
            .or_else(|| sample.get("audio_path").and_then(Value::as_str))
            .with_context(|| format!("Dataset sample {} missing audioPath", id))?;

        let resolved_audio_path = {
            let candidate = PathBuf::from(audio_path_raw);
            if candidate.is_absolute() {
                candidate
            } else {
                dataset_parent.join(candidate)
            }
        };

        let expected_text = sample
            .get("text")
            .and_then(Value::as_str)
            .or_else(|| sample.get("expectedText").and_then(Value::as_str))
            .or_else(|| sample.get("label").and_then(Value::as_str))
            .map(ToString::to_string);

        samples.push(DatasetSample {
            id,
            audio_path: resolved_audio_path,
            expected_text,
        });
    }

    if samples.is_empty() {
        return Err(anyhow::anyhow!(
            "Dataset had no valid samples: {}",
            dataset_path.display()
        ));
    }

    Ok((dataset_name, samples))
}

fn load_character() -> Result<Character> {
    let path = shared_dir().join("character.json");
    let raw = fs::read_to_string(&path)
        .with_context(|| format!("Failed to read character: {}", path.display()))?;
    let mut character = elizaos::parse_character(&raw).with_context(|| "Invalid character JSON")?;

    if character.settings.is_none() {
        character.settings = Some(CharacterSettings::default());
    }

    if let Some(settings) = character.settings.as_mut() {
        settings
            .values
            .insert("ALLOW_NO_DATABASE".to_string(), json!("true"));
        settings
            .values
            .insert("USE_MULTI_STEP".to_string(), json!("false"));
        settings
            .values
            .insert("CHECK_SHOULD_RESPOND".to_string(), json!("false"));
        settings
            .values
            .insert("VALIDATION_LEVEL".to_string(), json!("trusted"));
    }

    Ok(character)
}

async fn create_runtime(
    profile: &str,
    character: &Character,
    agent_id: UUID,
) -> Result<Arc<AgentRuntime>> {
    let mut plugins = vec![create_groq_elizaos_plugin()?];
    if profile == "elevenlabs" {
        plugins.push(create_elevenlabs_elizaos_plugin()?);
    }

    let runtime = AgentRuntime::new(RuntimeOptions {
        character: Some(character.clone()),
        agent_id: Some(agent_id),
        plugins,
        check_should_respond: Some(false),
        ..Default::default()
    })
    .await?;

    runtime.initialize().await?;
    Ok(runtime)
}

#[tokio::main]
async fn main() -> Result<()> {
    let profile = parse_arg("profile").context("--profile is required")?;
    let audio_path = parse_arg("audio").context("--audio is required")?;
    let output_path = parse_arg("output").context("--output is required")?;
    let dataset_arg = parse_arg("dataset");
    let timestamp = parse_arg("timestamp").unwrap_or_else(|| format!("{}", chrono_like_now_ms()));

    let config = load_config()?;
    let character = load_character()?;

    let iterations = match parse_arg("iterations") {
        Some(v) => v
            .parse::<u32>()
            .with_context(|| "--iterations must be a positive integer")?,
        None => config.default_iterations,
    };

    if iterations == 0 {
        return Err(anyhow::anyhow!("iterations must be > 0"));
    }
    let response_max_chars = config.response_max_chars.unwrap_or(140);
    if response_max_chars == 0 {
        return Err(anyhow::anyhow!("responseMaxChars must be > 0"));
    }

    let (dataset_name, dataset_path, samples) = if let Some(dataset_raw) = dataset_arg {
        let dataset_path = PathBuf::from(dataset_raw);
        let (name, loaded_samples) = load_dataset_samples(&dataset_path)?;
        (
            name,
            Some(dataset_path.to_string_lossy().to_string()),
            loaded_samples,
        )
    } else {
        (
            "single-audio".to_string(),
            None,
            vec![DatasetSample {
                id: "single-audio".to_string(),
                audio_path: PathBuf::from(audio_path),
                expected_text: None,
            }],
        )
    };

    let tts_provider = if profile == "elevenlabs" {
        "elevenLabs"
    } else {
        "groq"
    };

    let agent_id = as_uuid("00000000-0000-0000-0000-000000000301")?;
    let user_entity_id = as_uuid("00000000-0000-0000-0000-000000000302")?;
    let room_id = as_uuid("00000000-0000-0000-0000-000000000303")?;

    let mut results: Vec<IterationResult> = Vec::new();
    let mut first_sentence_cache: HashMap<String, Vec<u8>> = HashMap::new();
    let runtime = create_runtime(&profile, &character, agent_id.clone()).await?;

    for mode in &config.modes {
        for sample in &samples {
            let sample_audio = fs::read(&sample.audio_path).with_context(|| {
                format!(
                    "Failed to read sample audio file: {}",
                    sample.audio_path.display()
                )
            })?;
            let sample_audio_b64 = BASE64_STANDARD.encode(&sample_audio);

            for iteration in 1..=iterations {
                let step_id = format!(
                    "voicebench-rs-{}-{}-{}-{}",
                    timestamp, mode.id, sample.id, iteration
                );

                let started = Instant::now();

                let transcription_start = Instant::now();
                let transcription = runtime
                    .use_model("TRANSCRIPTION", Value::String(sample_audio_b64.clone()))
                    .await
                    .with_context(|| "TRANSCRIPTION failed")?;
                let transcription_ms = transcription_start.elapsed().as_secs_f64() * 1000.0;

                let transcript_text = transcription.trim().to_string();
                let prompt = format!("{}\n\n{}", transcript_text, config.response_prompt);

                let transcription_exact_match = sample
                    .expected_text
                    .as_ref()
                    .map(|expected| transcript_text == *expected);
                let transcription_normalized_match = sample
                    .expected_text
                    .as_ref()
                    .map(|expected| normalize_text(&transcript_text) == normalize_text(expected));

                let mut message = Memory::message(user_entity_id.clone(), room_id.clone(), &prompt);
                message.agent_id = Some(agent_id.clone());
                message.content.source = Some("voicebench".to_string());
                message.content.channel_type = Some("VOICE_DM".to_string());
                message.metadata = Some(MemoryMetadata::Custom(json!({
                    "trajectoryStepId": step_id,
                    "benchmarkContext": mode.benchmark_context,
                    "entityName": "VoicebenchUser"
                })));

                let first_response_ms: Arc<Mutex<Option<f64>>> = Arc::new(Mutex::new(None));
                let callback_text: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
                let response_clock = Arc::new(Instant::now());

                let first_response_ms_clone = Arc::clone(&first_response_ms);
                let callback_text_clone = Arc::clone(&callback_text);
                let response_clock_clone = Arc::clone(&response_clock);

                let callback: HandlerCallback = Box::new(move |content: Content| {
                    let first_response_ms = Arc::clone(&first_response_ms_clone);
                    let callback_text = Arc::clone(&callback_text_clone);
                    let response_clock = Arc::clone(&response_clock_clone);

                    Box::pin(async move {
                        {
                            let mut first = first_response_ms.lock().expect("lock poisoned");
                            if first.is_none() {
                                *first = Some(response_clock.elapsed().as_secs_f64() * 1000.0);
                            }
                        }

                        if let Some(text) = content.text {
                            let mut out = callback_text.lock().expect("lock poisoned");
                            *out = text;
                        }

                        Vec::new()
                    })
                });

                let response_result = runtime
                    .message_service()
                    .handle_message(&runtime, &mut message, Some(callback), None)
                    .await
                    .with_context(|| "Message handling failed")?;

                let response_total_ms = response_clock.elapsed().as_secs_f64() * 1000.0;
                let response_ttft_ms = first_response_ms
                    .lock()
                    .expect("lock poisoned")
                    .unwrap_or(response_total_ms);
                let speech_to_response_start_ms = transcription_ms + response_ttft_ms;

                let response_text_raw = {
                    let from_callback = callback_text.lock().expect("lock poisoned").clone();
                    if !from_callback.is_empty() {
                        from_callback
                    } else {
                        response_result
                            .response_content
                            .as_ref()
                            .and_then(|c| c.text.clone())
                            .unwrap_or_else(|| "Voicebench fallback response.".to_string())
                    }
                };
                let (mut response_text, response_was_capped) =
                    enforce_response_budget(&response_text_raw, response_max_chars);
                if response_text.is_empty() {
                    response_text = "Voicebench fallback response.".to_string();
                }

                let (first_sentence, remainder) = split_first_sentence(&response_text);
                let first_sentence_text = if first_sentence.is_empty() {
                    response_text.clone()
                } else {
                    first_sentence.clone()
                };
                let first_sentence_key = format!(
                    "{}|{}|{}",
                    profile,
                    tts_provider,
                    normalize_cache_key_text(&first_sentence_text)
                );

                let uncached_first_sentence_start = Instant::now();
                let uncached_first_sentence_output = runtime
                    .use_model(
                        "TEXT_TO_SPEECH",
                        json!({ "text": first_sentence_text.clone() }),
                    )
                    .await
                    .with_context(|| "TEXT_TO_SPEECH first sentence uncached failed")?;
                let voice_first_token_uncached_ms =
                    uncached_first_sentence_start.elapsed().as_secs_f64() * 1000.0;
                let speech_to_voice_start_uncached_ms =
                    transcription_ms + response_total_ms + voice_first_token_uncached_ms;
                let tts_first_sentence_uncached_bytes =
                    decode_audio_output_bytes(&uncached_first_sentence_output).len();

                let cached_pipeline_start = Instant::now();
                let tts_first_sentence_cache_hit =
                    first_sentence_cache.contains_key(&first_sentence_key);
                let remainder_job = if !remainder.is_empty() {
                    let runtime_remainder = Arc::clone(&runtime);
                    let remainder_text = remainder.clone();
                    Some((
                        Instant::now(),
                        tokio::spawn(async move {
                            runtime_remainder
                                .use_model("TEXT_TO_SPEECH", json!({ "text": remainder_text }))
                                .await
                        }),
                    ))
                } else {
                    None
                };

                let (cached_audio_bytes, voice_first_token_cached_ms) =
                    if tts_first_sentence_cache_hit {
                        (
                            first_sentence_cache
                                .get(&first_sentence_key)
                                .cloned()
                                .unwrap_or_default(),
                            cached_pipeline_start.elapsed().as_secs_f64() * 1000.0,
                        )
                    } else {
                        let cached_first_sentence_start = Instant::now();
                        let cached_output = runtime
                            .use_model(
                                "TEXT_TO_SPEECH",
                                json!({ "text": first_sentence_text.clone() }),
                            )
                            .await
                            .with_context(|| "TEXT_TO_SPEECH first sentence cache fill failed")?;
                        let decoded = decode_audio_output_bytes(&cached_output);
                        first_sentence_cache.insert(first_sentence_key.clone(), decoded.clone());
                        (
                            decoded,
                            cached_first_sentence_start.elapsed().as_secs_f64() * 1000.0,
                        )
                    };
                let tts_first_sentence_cached_bytes = cached_audio_bytes.len();
                let speech_to_voice_start_cached_ms =
                    transcription_ms + response_total_ms + voice_first_token_cached_ms;

                let mut tts_remainder_ms = 0.0;
                let mut tts_remainder_bytes = 0usize;
                if let Some((remainder_start, remainder_handle)) = remainder_job {
                    let remainder_output = remainder_handle
                        .await
                        .map_err(|error| {
                            anyhow::anyhow!("TEXT_TO_SPEECH remainder join failed: {}", error)
                        })?
                        .with_context(|| "TEXT_TO_SPEECH remainder failed")?;
                    tts_remainder_ms = remainder_start.elapsed().as_secs_f64() * 1000.0;
                    tts_remainder_bytes = decode_audio_output_bytes(&remainder_output).len();
                }
                let tts_cached_pipeline_ms = cached_pipeline_start.elapsed().as_secs_f64() * 1000.0;
                let tts_cached_pipeline_bytes =
                    tts_first_sentence_cached_bytes + tts_remainder_bytes;

                let tts_start = Instant::now();
                let tts_value = runtime
                    .use_model("TEXT_TO_SPEECH", json!({ "text": response_text.clone() }))
                    .await
                    .with_context(|| "TEXT_TO_SPEECH failed")?;
                let voice_generation_ms = tts_start.elapsed().as_secs_f64() * 1000.0;
                let tts_output_bytes = decode_audio_output_bytes(&tts_value).len();

                let end_to_end_ms = started.elapsed().as_secs_f64() * 1000.0;

                let trajectory_logs = runtime.get_trajectory_logs();
                let llm_calls: Vec<HashMap<String, Value>> = trajectory_logs
                    .llm_calls
                    .iter()
                    .filter(|entry| entry.step_id == step_id)
                    .map(|entry| {
                        HashMap::from([
                            ("model".to_string(), Value::String(entry.model.clone())),
                            ("purpose".to_string(), Value::String(entry.purpose.clone())),
                            (
                                "latencyMs".to_string(),
                                Value::Number(serde_json::Number::from(entry.latency_ms.max(0))),
                            ),
                        ])
                    })
                    .collect();

                let provider_accesses: Vec<HashMap<String, Value>> = trajectory_logs
                    .provider_access
                    .iter()
                    .filter(|entry| entry.step_id == step_id)
                    .map(|entry| {
                        HashMap::from([
                            (
                                "providerName".to_string(),
                                Value::String(entry.provider_name.clone()),
                            ),
                            ("purpose".to_string(), Value::String(entry.purpose.clone())),
                        ])
                    })
                    .collect();

                let primary_llm = trajectory_logs
                    .llm_calls
                    .iter()
                    .find(|entry| entry.step_id == step_id);
                let model_input_raw = primary_llm
                    .map(|entry| entry.user_prompt.clone())
                    .unwrap_or_default();
                let model_output_raw = primary_llm
                    .map(|entry| entry.response.clone())
                    .filter(|value| !value.is_empty())
                    .unwrap_or_else(|| response_text_raw.clone());
                let model_output_inspection = inspect_model_output(&model_output_raw);

                let actions = response_result
                    .response_content
                    .as_ref()
                    .and_then(|c| c.actions.clone())
                    .unwrap_or_default();

                let providers = response_result
                    .response_content
                    .as_ref()
                    .and_then(|c| c.providers.clone())
                    .unwrap_or_default();

                let state_excerpt = truncate(&response_result.state.text, 280);

                let row = IterationResult {
                    mode: mode.id.clone(),
                    sample_id: sample.id.clone(),
                    sample_audio_path: sample.audio_path.to_string_lossy().to_string(),
                    iteration,
                    profile: profile.clone(),
                    expected_transcript: sample.expected_text.clone(),
                    transcription_exact_match,
                    transcription_normalized_match,
                    transcription_ms: round_ms(transcription_ms),
                    response_ttft_ms: round_ms(response_ttft_ms),
                    response_total_ms: round_ms(response_total_ms),
                    speech_to_response_start_ms: round_ms(speech_to_response_start_ms),
                    speech_to_voice_start_uncached_ms: round_ms(speech_to_voice_start_uncached_ms),
                    speech_to_voice_start_cached_ms: round_ms(speech_to_voice_start_cached_ms),
                    voice_generation_ms: round_ms(voice_generation_ms),
                    voice_first_token_uncached_ms: round_ms(voice_first_token_uncached_ms),
                    voice_first_token_cached_ms: round_ms(voice_first_token_cached_ms),
                    tts_first_sentence_cache_hit,
                    tts_remainder_ms: round_ms(tts_remainder_ms),
                    tts_cached_pipeline_ms: round_ms(tts_cached_pipeline_ms),
                    end_to_end_ms: round_ms(end_to_end_ms),
                    in_context: ContextIn {
                        transcript: truncate(&transcript_text, 280),
                        benchmark_context: truncate(&mode.benchmark_context, 280),
                        prompt: truncate(&prompt, 280),
                    },
                    out_context: ContextOut {
                        response: truncate(&response_text, 280),
                        state_excerpt,
                        actions,
                        providers,
                        model_input: truncate(&model_input_raw, 900),
                        model_output_raw: truncate(&model_output_raw, 900),
                        model_output_clean: truncate(&model_output_inspection.cleaned, 900),
                        model_output_has_thinking_tag: model_output_inspection.has_thinking_tag,
                        model_output_has_xml: model_output_inspection.has_xml_tag,
                        model_output_thought_tag_count: model_output_inspection.thought_tag_count,
                        model_output_xml_tag_count: model_output_inspection.xml_tag_count,
                    },
                    trajectory: TrajectoryData {
                        llm_call_count: llm_calls.len(),
                        provider_access_count: provider_accesses.len(),
                        llm_calls,
                        provider_accesses,
                    },
                    tts_output_bytes,
                    tts_first_sentence_uncached_bytes,
                    tts_first_sentence_cached_bytes,
                    tts_remainder_bytes,
                    tts_cached_pipeline_bytes,
                    response_char_count: response_text.chars().count(),
                    response_was_capped,
                    response_segmentation: ResponseSegmentation {
                        first_sentence: truncate(&first_sentence, 280),
                        remainder: truncate(&remainder, 280),
                    },
                };

                println!(
                    "[voicebench][rust] mode={} sample={} iter={}/{} transcription={}ms ttft={}ms response={}ms tts={}ms voice-ttft-uncached={}ms voice-ttft-cached={}ms cache-hit={} e2e={}ms",
                    row.mode,
                    row.sample_id,
                    row.iteration,
                    iterations,
                    row.transcription_ms,
                    row.response_ttft_ms,
                    row.response_total_ms,
                    row.voice_generation_ms,
                    row.voice_first_token_uncached_ms,
                    row.voice_first_token_cached_ms,
                    row.tts_first_sentence_cache_hit,
                    row.end_to_end_ms
                );
                println!("[voicebench][rust] in-context: {}", row.in_context.prompt);
                println!(
                    "[voicebench][rust] out-context: {}",
                    row.out_context.response
                );

                results.push(row);
            }
        }
    }
    runtime.stop().await?;

    let mut summary: HashMap<String, ModeSummary> = HashMap::new();
    for mode in &config.modes {
        let mode_rows: Vec<&IterationResult> = results
            .iter()
            .filter(|entry| entry.mode == mode.id)
            .collect();
        let scored_rows: Vec<&IterationResult> = mode_rows
            .iter()
            .copied()
            .filter(|entry| entry.transcription_normalized_match.is_some())
            .collect();
        let transcription_vals = mode_rows
            .iter()
            .map(|entry| entry.transcription_ms)
            .collect::<Vec<_>>();
        let response_ttft_vals = mode_rows
            .iter()
            .map(|entry| entry.response_ttft_ms)
            .collect::<Vec<_>>();
        let response_total_vals = mode_rows
            .iter()
            .map(|entry| entry.response_total_ms)
            .collect::<Vec<_>>();
        let speech_to_response_start_vals = mode_rows
            .iter()
            .map(|entry| entry.speech_to_response_start_ms)
            .collect::<Vec<_>>();
        let speech_to_voice_uncached_vals = mode_rows
            .iter()
            .map(|entry| entry.speech_to_voice_start_uncached_ms)
            .collect::<Vec<_>>();
        let speech_to_voice_cached_vals = mode_rows
            .iter()
            .map(|entry| entry.speech_to_voice_start_cached_ms)
            .collect::<Vec<_>>();
        let voice_generation_vals = mode_rows
            .iter()
            .map(|entry| entry.voice_generation_ms)
            .collect::<Vec<_>>();
        let voice_first_uncached_vals = mode_rows
            .iter()
            .map(|entry| entry.voice_first_token_uncached_ms)
            .collect::<Vec<_>>();
        let voice_first_cached_vals = mode_rows
            .iter()
            .map(|entry| entry.voice_first_token_cached_ms)
            .collect::<Vec<_>>();
        let tts_cached_pipeline_vals = mode_rows
            .iter()
            .map(|entry| entry.tts_cached_pipeline_ms)
            .collect::<Vec<_>>();
        let end_to_end_vals = mode_rows
            .iter()
            .map(|entry| entry.end_to_end_ms)
            .collect::<Vec<_>>();

        summary.insert(
            mode.id.clone(),
            ModeSummary {
                runs: mode_rows.len(),
                avg_transcription_ms: round_ms(average(&transcription_vals)),
                avg_response_ttft_ms: round_ms(average(&response_ttft_vals)),
                avg_response_total_ms: round_ms(average(&response_total_vals)),
                avg_speech_to_response_start_ms: round_ms(average(&speech_to_response_start_vals)),
                avg_speech_to_voice_start_uncached_ms: round_ms(average(
                    &speech_to_voice_uncached_vals,
                )),
                avg_speech_to_voice_start_cached_ms: round_ms(average(
                    &speech_to_voice_cached_vals,
                )),
                avg_voice_generation_ms: round_ms(average(&voice_generation_vals)),
                avg_voice_first_token_uncached_ms: round_ms(average(&voice_first_uncached_vals)),
                avg_voice_first_token_cached_ms: round_ms(average(&voice_first_cached_vals)),
                avg_tts_cached_pipeline_ms: round_ms(average(&tts_cached_pipeline_vals)),
                p95_transcription_ms: round_ms(percentile(&transcription_vals, 95.0)),
                p99_transcription_ms: round_ms(percentile(&transcription_vals, 99.0)),
                p95_response_ttft_ms: round_ms(percentile(&response_ttft_vals, 95.0)),
                p99_response_ttft_ms: round_ms(percentile(&response_ttft_vals, 99.0)),
                p95_response_total_ms: round_ms(percentile(&response_total_vals, 95.0)),
                p99_response_total_ms: round_ms(percentile(&response_total_vals, 99.0)),
                p95_speech_to_response_start_ms: round_ms(percentile(
                    &speech_to_response_start_vals,
                    95.0,
                )),
                p99_speech_to_response_start_ms: round_ms(percentile(
                    &speech_to_response_start_vals,
                    99.0,
                )),
                p95_speech_to_voice_start_uncached_ms: round_ms(percentile(
                    &speech_to_voice_uncached_vals,
                    95.0,
                )),
                p99_speech_to_voice_start_uncached_ms: round_ms(percentile(
                    &speech_to_voice_uncached_vals,
                    99.0,
                )),
                p95_speech_to_voice_start_cached_ms: round_ms(percentile(
                    &speech_to_voice_cached_vals,
                    95.0,
                )),
                p99_speech_to_voice_start_cached_ms: round_ms(percentile(
                    &speech_to_voice_cached_vals,
                    99.0,
                )),
                p95_voice_generation_ms: round_ms(percentile(&voice_generation_vals, 95.0)),
                p99_voice_generation_ms: round_ms(percentile(&voice_generation_vals, 99.0)),
                p95_voice_first_token_uncached_ms: round_ms(percentile(
                    &voice_first_uncached_vals,
                    95.0,
                )),
                p99_voice_first_token_uncached_ms: round_ms(percentile(
                    &voice_first_uncached_vals,
                    99.0,
                )),
                p95_voice_first_token_cached_ms: round_ms(percentile(
                    &voice_first_cached_vals,
                    95.0,
                )),
                p99_voice_first_token_cached_ms: round_ms(percentile(
                    &voice_first_cached_vals,
                    99.0,
                )),
                p95_tts_cached_pipeline_ms: round_ms(percentile(&tts_cached_pipeline_vals, 95.0)),
                p99_tts_cached_pipeline_ms: round_ms(percentile(&tts_cached_pipeline_vals, 99.0)),
                first_sentence_cache_hit_rate: round_ms(average(
                    &mode_rows
                        .iter()
                        .map(|entry| {
                            if entry.tts_first_sentence_cache_hit {
                                1.0
                            } else {
                                0.0
                            }
                        })
                        .collect::<Vec<_>>(),
                )),
                transcription_normalized_accuracy: round_ms(average(
                    &scored_rows
                        .iter()
                        .map(|entry| {
                            if entry.transcription_normalized_match.unwrap_or(false) {
                                1.0
                            } else {
                                0.0
                            }
                        })
                        .collect::<Vec<_>>(),
                )),
                avg_end_to_end_ms: round_ms(average(&end_to_end_vals)),
                p95_end_to_end_ms: round_ms(percentile(&end_to_end_vals, 95.0)),
                p99_end_to_end_ms: round_ms(percentile(&end_to_end_vals, 99.0)),
            },
        );
    }

    let output = BenchmarkOutput {
        benchmark: config.benchmark_name,
        runtime: "rust".to_string(),
        profile,
        timestamp,
        iterations,
        dataset_name,
        dataset_path,
        sample_count: samples.len(),
        modes: config.modes,
        results,
        summary,
    };

    let output_json = serde_json::to_string_pretty(&output)?;
    let output_path = PathBuf::from(output_path);
    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(output_path, output_json)?;

    Ok(())
}

fn chrono_like_now_ms() -> i64 {
    let now = std::time::SystemTime::now();
    now.duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
