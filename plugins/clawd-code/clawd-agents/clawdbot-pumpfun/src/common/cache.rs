use std::collections::{HashMap, HashSet};
use std::sync::RwLock;
use std::time::{Duration, Instant};
use anchor_client::solana_sdk::pubkey::Pubkey;
use spl_token_2022::state::{Account, Mint};
use spl_token_2022::extension::StateWithExtensionsOwned;
use lazy_static::lazy_static;

/// TTL Cache entry that stores a value with an expiration time
pub struct CacheEntry<T> {
    pub value: T,
    pub expires_at: Instant,
}

impl<T> CacheEntry<T> {
    pub fn new(value: T, ttl_seconds: u64) -> Self {
        Self {
            value,
            expires_at: Instant::now() + Duration::from_secs(ttl_seconds),
        }
    }
    
    pub fn is_expired(&self) -> bool {
        Instant::now() > self.expires_at
    }
}

/// Token account cache
pub struct TokenAccountCache {
    accounts: RwLock<HashMap<Pubkey, CacheEntry<StateWithExtensionsOwned<Account>>>>,
    default_ttl: u64,
}

impl TokenAccountCache {
    pub fn new(default_ttl: u64) -> Self {
        Self {
            accounts: RwLock::new(HashMap::new()),
            default_ttl,
        }
    }
    
    pub fn get(&self, key: &Pubkey) -> Option<StateWithExtensionsOwned<Account>> {
        let accounts = self.accounts.read().unwrap();
        if let Some(entry) = accounts.get(key) {
            if !entry.is_expired() {
                return Some(entry.value.clone());
            }
        }
        None
    }
    
    pub fn insert(&self, key: Pubkey, value: StateWithExtensionsOwned<Account>, ttl: Option<u64>) {
        let ttl = ttl.unwrap_or(self.default_ttl);
        let mut accounts = self.accounts.write().unwrap();
        accounts.insert(key, CacheEntry::new(value, ttl));
    }
    
    pub fn remove(&self, key: &Pubkey) {
        let mut accounts = self.accounts.write().unwrap();
        accounts.remove(key);
    }
    
    pub fn clear_expired(&self) {
        let mut accounts = self.accounts.write().unwrap();
        accounts.retain(|_, entry| !entry.is_expired());
    }
    
    // Get the current size of the cache
    pub fn size(&self) -> usize {
        let accounts = self.accounts.read().unwrap();
        accounts.len()
    }
}

/// Token mint cache
pub struct TokenMintCache {
    mints: RwLock<HashMap<Pubkey, CacheEntry<StateWithExtensionsOwned<Mint>>>>,
    default_ttl: u64,
}

impl TokenMintCache {
    pub fn new(default_ttl: u64) -> Self {
        Self {
            mints: RwLock::new(HashMap::new()),
            default_ttl,
        }
    }
    
    pub fn get(&self, key: &Pubkey) -> Option<StateWithExtensionsOwned<Mint>> {
        let mints = self.mints.read().unwrap();
        if let Some(entry) = mints.get(key) {
            if !entry.is_expired() {
                return Some(entry.value.clone());
            }
        }
        None
    }
    
    pub fn insert(&self, key: Pubkey, value: StateWithExtensionsOwned<Mint>, ttl: Option<u64>) {
        let ttl = ttl.unwrap_or(self.default_ttl);
        let mut mints = self.mints.write().unwrap();
        mints.insert(key, CacheEntry::new(value, ttl));
    }
    
    pub fn remove(&self, key: &Pubkey) {
        let mut mints = self.mints.write().unwrap();
        mints.remove(key);
    }
    
    pub fn clear_expired(&self) {
        let mut mints = self.mints.write().unwrap();
        mints.retain(|_, entry| !entry.is_expired());
    }
    
    // Get the current size of the cache
    pub fn size(&self) -> usize {
        let mints = self.mints.read().unwrap();
        mints.len()
    }
}

/// Simple wallet token account tracker
pub struct WalletTokenAccounts {
    accounts: RwLock<HashSet<Pubkey>>,
}

impl WalletTokenAccounts {
    pub fn new() -> Self {
        Self {
            accounts: RwLock::new(HashSet::new()),
        }
    }
    
    pub fn contains(&self, account: &Pubkey) -> bool {
        let accounts = self.accounts.read().unwrap();
        accounts.contains(account)
    }
    
    pub fn insert(&self, account: Pubkey) -> bool {
        let mut accounts = self.accounts.write().unwrap();
        accounts.insert(account)
    }
    
    pub fn remove(&self, account: &Pubkey) -> bool {
        let mut accounts = self.accounts.write().unwrap();
        accounts.remove(account)
    }
    
    pub fn get_all(&self) -> HashSet<Pubkey> {
        let accounts = self.accounts.read().unwrap();
        accounts.clone()
    }
    
    pub fn clear(&self) {
        let mut accounts = self.accounts.write().unwrap();
        accounts.clear();
    }
    
    pub fn size(&self) -> usize {
        let accounts = self.accounts.read().unwrap();
        accounts.len()
    }
}

/// Target wallet token list tracker
pub struct TargetWalletTokens {
    tokens: RwLock<HashSet<String>>,
}

impl TargetWalletTokens {
    pub fn new() -> Self {
        Self {
            tokens: RwLock::new(HashSet::new()),
        }
    }
    
    pub fn contains(&self, token_mint: &str) -> bool {
        let tokens = self.tokens.read().unwrap();
        tokens.contains(token_mint)
    }
    
    pub fn insert(&self, token_mint: String) -> bool {
        let mut tokens = self.tokens.write().unwrap();
        tokens.insert(token_mint)
    }
    
    pub fn remove(&self, token_mint: &str) -> bool {
        let mut tokens = self.tokens.write().unwrap();
        tokens.remove(token_mint)
    }
    
    pub fn get_all(&self) -> HashSet<String> {
        let tokens = self.tokens.read().unwrap();
        tokens.clone()
    }
    
    pub fn clear(&self) {
        let mut tokens = self.tokens.write().unwrap();
        tokens.clear();
    }
    
    pub fn size(&self) -> usize {
        let tokens = self.tokens.read().unwrap();
        tokens.len()
    }
}

/// Bought token tracking information
#[derive(Clone, Debug)]
pub struct BoughtTokenInfo {
    pub mint: String,
    pub token_account: Pubkey,
    pub amount: f64,
    pub buy_time: Instant,
    pub buy_signature: String,
    pub protocol: String,
    // New fields for balance caching
    pub cached_balance_raw: u64,
    pub cached_balance_decimal: f64,
    pub cached_decimals: u8,
    pub balance_cache_time: Instant,
    pub balance_verified: bool,
}

/// Token balance cache entry
#[derive(Clone, Debug)]
pub struct TokenBalanceInfo {
    pub balance_raw: u64,
    pub balance_decimal: f64,
    pub decimals: u8,
    pub cached_at: Instant,
    pub verified: bool,
}

impl TokenBalanceInfo {
    pub fn new(balance_raw: u64, balance_decimal: f64, decimals: u8, verified: bool) -> Self {
        Self {
            balance_raw,
            balance_decimal,
            decimals,
            cached_at: Instant::now(),
            verified,
        }
    }

    pub fn is_stale(&self, max_age_seconds: u64) -> bool {
        Instant::now().duration_since(self.cached_at).as_secs() > max_age_seconds
    }
}

/// Dedicated token balance cache for fast selling
pub struct TokenBalanceCache {
    balances: RwLock<HashMap<String, TokenBalanceInfo>>, // mint -> balance info
    default_ttl: u64,
}

impl TokenBalanceCache {
    pub fn new(default_ttl: u64) -> Self {
        Self {
            balances: RwLock::new(HashMap::new()),
            default_ttl,
        }
    }

    pub fn get_balance(&self, mint: &str) -> Option<TokenBalanceInfo> {
        let balances = self.balances.read().unwrap();
        if let Some(balance_info) = balances.get(mint) {
            if !balance_info.is_stale(self.default_ttl) {
                return Some(balance_info.clone());
            }
        }
        None
    }

    pub fn cache_balance(&self, mint: String, balance_raw: u64, balance_decimal: f64, decimals: u8, verified: bool) {
        let mut balances = self.balances.write().unwrap();
        balances.insert(mint, TokenBalanceInfo::new(balance_raw, balance_decimal, decimals, verified));
    }

    pub fn update_balance_verification(&self, mint: &str, verified: bool) {
        let mut balances = self.balances.write().unwrap();
        if let Some(balance_info) = balances.get_mut(mint) {
            balance_info.verified = verified;
        }
    }

    pub fn remove_balance(&self, mint: &str) {
        let mut balances = self.balances.write().unwrap();
        balances.remove(mint);
    }

    pub fn clear_stale(&self) {
        let mut balances = self.balances.write().unwrap();
        balances.retain(|_, balance_info| !balance_info.is_stale(self.default_ttl));
    }

    pub fn size(&self) -> usize {
        let balances = self.balances.read().unwrap();
        balances.len()
    }
}

/// Bought tokens tracker
pub struct BoughtTokensTracker {
    tokens: RwLock<HashMap<String, BoughtTokenInfo>>,
}

impl BoughtTokensTracker {
    pub fn new() -> Self {
        Self {
            tokens: RwLock::new(HashMap::new()),
        }
    }
    
    pub fn add_bought_token(&self, mint: String, token_account: Pubkey, amount: f64, buy_signature: String, protocol: String) {
        let mut tokens = self.tokens.write().unwrap();
        tokens.insert(mint.clone(), BoughtTokenInfo {
            mint,
            token_account,
            amount,
            buy_time: Instant::now(),
            buy_signature,
            protocol,
            // New fields for balance caching
            cached_balance_raw: 0,
            cached_balance_decimal: 0.0,
            cached_decimals: 0,
            balance_cache_time: Instant::now(),
            balance_verified: false,
        });
    }
    
    pub fn has_token(&self, mint: &str) -> bool {
        let tokens = self.tokens.read().unwrap();
        tokens.contains_key(mint)
    }
    
    pub fn get_token_info(&self, mint: &str) -> Option<BoughtTokenInfo> {
        let tokens = self.tokens.read().unwrap();
        tokens.get(mint).cloned()
    }
    
    pub fn remove_token(&self, mint: &str) -> bool {
        let mut tokens = self.tokens.write().unwrap();
        tokens.remove(mint).is_some()
    }
    
    pub fn get_all_tokens(&self) -> Vec<BoughtTokenInfo> {
        let tokens = self.tokens.read().unwrap();
        tokens.values().cloned().collect()
    }
    
    pub fn clear(&self) {
        let mut tokens = self.tokens.write().unwrap();
        tokens.clear();
    }
    
    pub fn size(&self) -> usize {
        let tokens = self.tokens.read().unwrap();
        tokens.len()
    }
    
    pub fn update_token_balance(&self, mint: &str, new_amount: f64) {
        let mut tokens = self.tokens.write().unwrap();
        if let Some(token_info) = tokens.get_mut(mint) {
            token_info.amount = new_amount;
        }
    }

    /// Cache verified balance after successful buy transaction
    pub fn cache_verified_balance(&self, mint: &str, balance_raw: u64, balance_decimal: f64, decimals: u8) {
        let mut tokens = self.tokens.write().unwrap();
        if let Some(token_info) = tokens.get_mut(mint) {
            token_info.cached_balance_raw = balance_raw;
            token_info.cached_balance_decimal = balance_decimal;
            token_info.cached_decimals = decimals;
            token_info.balance_cache_time = Instant::now();
            token_info.balance_verified = true;
        }
    }

    /// Get cached balance if available and not too old
    pub fn get_cached_balance(&self, mint: &str, max_age_seconds: u64) -> Option<(u64, f64, u8)> {
        let tokens = self.tokens.read().unwrap();
        if let Some(token_info) = tokens.get(mint) {
            if token_info.balance_verified && 
               Instant::now().duration_since(token_info.balance_cache_time).as_secs() <= max_age_seconds {
                return Some((
                    token_info.cached_balance_raw,
                    token_info.cached_balance_decimal,
                    token_info.cached_decimals
                ));
            }
        }
        None
    }

    /// Mark balance as potentially stale (e.g., after failed transaction)
    pub fn invalidate_balance_cache(&self, mint: &str) {
        let mut tokens = self.tokens.write().unwrap();
        if let Some(token_info) = tokens.get_mut(mint) {
            token_info.balance_verified = false;
        }
    }
}

// Global cache instances with reasonable TTL values
lazy_static! {
    pub static ref TOKEN_ACCOUNT_CACHE: TokenAccountCache = TokenAccountCache::new(60); // 60 seconds TTL
    pub static ref TOKEN_MINT_CACHE: TokenMintCache = TokenMintCache::new(300); // 5 minutes TTL
    pub static ref WALLET_TOKEN_ACCOUNTS: WalletTokenAccounts = WalletTokenAccounts::new();
    pub static ref TARGET_WALLET_TOKENS: TargetWalletTokens = TargetWalletTokens::new();
    pub static ref BOUGHT_TOKENS: BoughtTokensTracker = BoughtTokensTracker::new();
    pub static ref TOKEN_BALANCE_CACHE: TokenBalanceCache = TokenBalanceCache::new(300); // 5 minutes TTL
} 