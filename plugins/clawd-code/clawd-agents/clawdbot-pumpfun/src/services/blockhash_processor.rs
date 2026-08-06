use anchor_client::solana_sdk::hash::Hash;

pub struct BlockhashProcessor;

impl BlockhashProcessor {
    pub async fn get_latest_blockhash() -> Option<Hash> {
        let config = crate::common::config::Config::get().await;
        config.app_state.rpc_client.get_latest_blockhash().ok()
    }
}
