//! Nostr service implementation for elizaOS.

use crate::types::*;
use dashmap::DashMap;
use futures_util::{SinkExt, StreamExt};
use secp256k1::{PublicKey, Secp256k1, SecretKey};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::RwLock;
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tracing::{debug, info, warn};

/// Nostr messaging service for elizaOS agents
pub struct NostrService {
    settings: Arc<RwLock<Option<NostrSettings>>>,
    private_key: Arc<RwLock<Option<[u8; 32]>>>,
    connected: Arc<RwLock<bool>>,
    seen_event_ids: Arc<DashMap<String, ()>>,
    secp: Secp256k1<secp256k1::All>,
}

impl NostrService {
    /// Create a new Nostr service
    pub fn new() -> Self {
        Self {
            settings: Arc::new(RwLock::new(None)),
            private_key: Arc::new(RwLock::new(None)),
            connected: Arc::new(RwLock::new(false)),
            seen_event_ids: Arc::new(DashMap::new()),
            secp: Secp256k1::new(),
        }
    }

    /// Start the service
    pub async fn start(&self, config: &NostrServiceConfig) -> Result<(), NostrPluginError> {
        info!("Starting Nostr service...");

        // Load settings
        let settings = self.load_settings(config)?;
        self.validate_settings(&settings)?;

        // Initialize private key
        let sk_bytes = validate_private_key(&settings.private_key)?;
        *self.private_key.write().await = Some(sk_bytes);

        // Store settings
        *self.settings.write().await = Some(settings.clone());

        // Mark as connected (relay connections handled separately)
        *self.connected.write().await = true;

        info!(
            "Nostr service started (pubkey: {}...)",
            &settings.public_key[..16]
        );

        Ok(())
    }

    /// Stop the service
    pub async fn stop(&self) {
        info!("Stopping Nostr service...");
        *self.connected.write().await = false;
        *self.settings.write().await = None;
        *self.private_key.write().await = None;
        self.seen_event_ids.clear();
        info!("Nostr service stopped");
    }

    /// Check if the service is connected
    pub async fn is_connected(&self) -> bool {
        *self.connected.read().await
    }

    /// Get the public key in hex format
    pub async fn get_public_key(&self) -> Option<String> {
        let settings = self.settings.read().await;
        settings.as_ref().map(|s| s.public_key.clone())
    }

    /// Get the public key in npub format
    pub async fn get_npub(&self) -> Option<String> {
        let pk = self.get_public_key().await?;
        pubkey_to_npub(&pk).ok()
    }

    /// Get connected relays
    pub async fn get_relays(&self) -> Vec<String> {
        let settings = self.settings.read().await;
        settings.as_ref().map(|s| s.relays.clone()).unwrap_or_default()
    }

    /// Send a DM
    pub async fn send_dm(&self, options: NostrDmSendOptions) -> NostrSendResult {
        let settings_guard = self.settings.read().await;
        let settings = match settings_guard.as_ref() {
            Some(s) => s,
            None => return NostrSendResult::failure("Service not initialized"),
        };

        let private_key_guard = self.private_key.read().await;
        let sk_bytes = match private_key_guard.as_ref() {
            Some(k) => k,
            None => return NostrSendResult::failure("Private key not initialized"),
        };

        // Normalize target pubkey
        let to_pubkey = match normalize_pubkey(&options.to_pubkey) {
            Ok(pk) => pk,
            Err(e) => return NostrSendResult::failure(format!("Invalid target pubkey: {}", e)),
        };

        // Create secret key
        let secret_key = match SecretKey::from_slice(sk_bytes) {
            Ok(sk) => sk,
            Err(e) => return NostrSendResult::failure(format!("Invalid secret key: {}", e)),
        };

        // Encrypt content (NIP-04)
        let encrypted = match self.encrypt_nip04(&secret_key, &to_pubkey, &options.text) {
            Ok(e) => e,
            Err(e) => return NostrSendResult::failure(format!("Encryption failed: {}", e)),
        };

        // Create event
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;

        let tags = vec![vec!["p".to_string(), to_pubkey.clone()]];
        let event_id = self.compute_event_id(&settings.public_key, timestamp, 4, &tags, &encrypted);

        // Sign event
        let sig = match self.sign_event(&secret_key, &event_id) {
            Ok(s) => s,
            Err(e) => return NostrSendResult::failure(format!("Signing failed: {}", e)),
        };

        // Create event JSON
        let event = serde_json::json!({
            "id": event_id,
            "pubkey": settings.public_key,
            "created_at": timestamp,
            "kind": 4,
            "tags": tags,
            "content": encrypted,
            "sig": sig
        });

        // Publish to relays
        let mut successful_relays = Vec::new();
        for relay in &settings.relays {
            match self.publish_event_to_relay(relay, &event).await {
                Ok(_) => {
                    debug!("Published DM to {}", relay);
                    successful_relays.push(relay.clone());
                }
                Err(e) => {
                    warn!("Failed to publish to {}: {}", relay, e);
                }
            }
        }

        if successful_relays.is_empty() {
            return NostrSendResult::failure("Failed to publish to any relay");
        }

        NostrSendResult::success(event_id, successful_relays)
    }

    /// Publish profile
    pub async fn publish_profile(&self, profile: NostrProfile) -> NostrSendResult {
        let settings_guard = self.settings.read().await;
        let settings = match settings_guard.as_ref() {
            Some(s) => s,
            None => return NostrSendResult::failure("Service not initialized"),
        };

        let private_key_guard = self.private_key.read().await;
        let sk_bytes = match private_key_guard.as_ref() {
            Some(k) => k,
            None => return NostrSendResult::failure("Private key not initialized"),
        };

        let secret_key = match SecretKey::from_slice(sk_bytes) {
            Ok(sk) => sk,
            Err(e) => return NostrSendResult::failure(format!("Invalid secret key: {}", e)),
        };

        // Serialize profile
        let content = match serde_json::to_string(&profile) {
            Ok(c) => c,
            Err(e) => return NostrSendResult::failure(format!("Failed to serialize profile: {}", e)),
        };

        // Create event
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;

        let tags: Vec<Vec<String>> = Vec::new();
        let event_id = self.compute_event_id(&settings.public_key, timestamp, 0, &tags, &content);

        // Sign event
        let sig = match self.sign_event(&secret_key, &event_id) {
            Ok(s) => s,
            Err(e) => return NostrSendResult::failure(format!("Signing failed: {}", e)),
        };

        // Create event JSON
        let event = serde_json::json!({
            "id": event_id,
            "pubkey": settings.public_key,
            "created_at": timestamp,
            "kind": 0,
            "tags": tags,
            "content": content,
            "sig": sig
        });

        // Publish to relays
        let mut successful_relays = Vec::new();
        for relay in &settings.relays {
            match self.publish_event_to_relay(relay, &event).await {
                Ok(_) => {
                    debug!("Published profile to {}", relay);
                    successful_relays.push(relay.clone());
                }
                Err(e) => {
                    warn!("Failed to publish profile to {}: {}", relay, e);
                }
            }
        }

        if successful_relays.is_empty() {
            return NostrSendResult::failure("Failed to publish to any relay");
        }

        NostrSendResult::success(event_id, successful_relays)
    }

    // Private methods

    fn load_settings(&self, config: &NostrServiceConfig) -> Result<NostrSettings, NostrPluginError> {
        let private_key = config.private_key.clone();

        let relays = if config.relays.is_empty() {
            DEFAULT_NOSTR_RELAYS.iter().map(|s| s.to_string()).collect()
        } else {
            config.relays.clone()
        };

        // Derive public key
        let sk_bytes = validate_private_key(&private_key)?;
        let secret_key = SecretKey::from_slice(&sk_bytes)
            .map_err(|e| NostrPluginError::crypto(format!("Invalid private key: {}", e)))?;
        let public_key = PublicKey::from_secret_key(&self.secp, &secret_key);
        let pk_hex = hex::encode(&public_key.serialize()[1..33]); // x-only pubkey

        Ok(NostrSettings {
            private_key,
            public_key: pk_hex,
            relays,
            dm_policy: config.dm_policy.clone().unwrap_or_else(|| "pairing".to_string()),
            allow_from: config.allow_from.clone(),
            profile: None,
            enabled: config.enabled,
        })
    }

    fn validate_settings(&self, settings: &NostrSettings) -> Result<(), NostrPluginError> {
        if settings.private_key.is_empty() {
            return Err(NostrPluginError::configuration_with_setting(
                "NOSTR_PRIVATE_KEY is required",
                "NOSTR_PRIVATE_KEY",
            ));
        }

        if settings.relays.is_empty() {
            return Err(NostrPluginError::configuration_with_setting(
                "At least one relay is required",
                "NOSTR_RELAYS",
            ));
        }

        for relay in &settings.relays {
            if !relay.starts_with("wss://") && !relay.starts_with("ws://") {
                return Err(NostrPluginError::configuration_with_setting(
                    format!("Invalid relay URL: {}", relay),
                    "NOSTR_RELAYS",
                ));
            }
        }

        Ok(())
    }

    fn compute_event_id(
        &self,
        pubkey: &str,
        created_at: i64,
        kind: u32,
        tags: &[Vec<String>],
        content: &str,
    ) -> String {
        let serialized = serde_json::to_string(&serde_json::json!([
            0,
            pubkey,
            created_at,
            kind,
            tags,
            content
        ]))
        .unwrap();

        let mut hasher = Sha256::new();
        hasher.update(serialized.as_bytes());
        hex::encode(hasher.finalize())
    }

    fn sign_event(&self, secret_key: &SecretKey, event_id: &str) -> Result<String, NostrPluginError> {
        use secp256k1::Message;

        let msg_bytes = hex::decode(event_id)
            .map_err(|e| NostrPluginError::crypto(format!("Invalid event ID: {}", e)))?;

        let message = Message::from_digest_slice(&msg_bytes)
            .map_err(|e| NostrPluginError::crypto(format!("Failed to create message: {}", e)))?;

        let sig = self.secp.sign_schnorr_no_aux_rand(&message, &secret_key.keypair(&self.secp));
        Ok(hex::encode(sig.as_ref()))
    }

    fn encrypt_nip04(
        &self,
        secret_key: &SecretKey,
        recipient_pubkey: &str,
        plaintext: &str,
    ) -> Result<String, NostrPluginError> {
        use aes::cipher::{BlockEncryptMut, KeyIvInit};
        use rand::RngCore;

        // Parse recipient public key
        let recipient_pk_bytes = hex::decode(recipient_pubkey)
            .map_err(|e| NostrPluginError::crypto(format!("Invalid recipient pubkey: {}", e)))?;

        // Create full public key (prepend 02 for compressed form)
        let mut full_pk = vec![0x02u8];
        full_pk.extend_from_slice(&recipient_pk_bytes);

        let recipient_pk = PublicKey::from_slice(&full_pk)
            .map_err(|e| NostrPluginError::crypto(format!("Invalid public key: {}", e)))?;

        // ECDH shared secret
        let shared = secp256k1::ecdh::shared_secret_point(&recipient_pk, secret_key);
        let shared_key = &shared[1..33]; // x-coordinate only

        // Generate random IV
        let mut iv = [0u8; 16];
        rand::thread_rng().fill_bytes(&mut iv);

        // Pad plaintext to 16-byte boundary (PKCS7)
        let pad_len = 16 - (plaintext.len() % 16);
        let mut padded = plaintext.as_bytes().to_vec();
        padded.extend(std::iter::repeat(pad_len as u8).take(pad_len));

        // Encrypt
        type Aes256CbcEnc = cbc::Encryptor<aes::Aes256>;
        let encryptor = Aes256CbcEnc::new_from_slices(shared_key, &iv)
            .map_err(|e| NostrPluginError::crypto(format!("Failed to create cipher: {}", e)))?;

        let mut buffer = padded;
        let len = buffer.len();
        let ciphertext = encryptor
            .encrypt_padded_mut::<aes::cipher::block_padding::NoPadding>(&mut buffer, len)
            .map_err(|e| NostrPluginError::crypto(format!("Encryption failed: {}", e)))?;

        // Encode as base64
        let ct_b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, ciphertext);
        let iv_b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, iv);

        Ok(format!("{}?iv={}", ct_b64, iv_b64))
    }

    async fn publish_event_to_relay(
        &self,
        relay: &str,
        event: &serde_json::Value,
    ) -> Result<(), NostrPluginError> {
        let (mut ws, _) = connect_async(relay)
            .await
            .map_err(|e| NostrPluginError::relay_with_url(format!("Connection failed: {}", e), relay))?;

        let message = serde_json::to_string(&serde_json::json!(["EVENT", event]))
            .map_err(|e| NostrPluginError::Json(e))?;

        ws.send(Message::Text(message))
            .await
            .map_err(|e| NostrPluginError::WebSocket(e.to_string()))?;

        // Wait for OK response (with timeout)
        let timeout = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while let Some(msg) = ws.next().await {
                if let Ok(Message::Text(text)) = msg {
                    if let Ok(response) = serde_json::from_str::<serde_json::Value>(&text) {
                        if response.get(0).and_then(|v| v.as_str()) == Some("OK") {
                            return Ok(());
                        }
                    }
                }
            }
            Err(NostrPluginError::relay("No OK response received"))
        });

        timeout
            .await
            .map_err(|_| NostrPluginError::relay_with_url("Timeout waiting for OK", relay))?
    }
}

impl Default for NostrService {
    fn default() -> Self {
        Self::new()
    }
}

/// Configuration for the Nostr service
#[derive(Debug, Clone)]
pub struct NostrServiceConfig {
    pub private_key: String,
    pub relays: Vec<String>,
    pub dm_policy: Option<String>,
    pub allow_from: Vec<String>,
    pub enabled: bool,
}

impl Default for NostrServiceConfig {
    fn default() -> Self {
        Self {
            private_key: String::new(),
            relays: Vec::new(),
            dm_policy: Some("pairing".to_string()),
            allow_from: Vec::new(),
            enabled: true,
        }
    }
}
