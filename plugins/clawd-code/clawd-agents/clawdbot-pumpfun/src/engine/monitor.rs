use anchor_client::solana_sdk::pubkey::Pubkey;
use std::{collections::HashSet, time::Instant};

#[derive(Clone, Debug, PartialEq, Eq, Copy)]
pub enum InstructionType {
    PumpMint,
    PumpBuy,
    PumpSell,
    PumpSwapBuy,
    PumpSwapSell
}

#[derive(Clone, Debug)]
pub struct BondingCurveInfo {
    pub bonding_curve: Pubkey,
    pub new_virtual_sol_reserve: u64,
    pub new_virtual_token_reserve: u64,
}

#[derive(Clone, Debug)]
pub struct PoolInfo {
    pub pool_id: Pubkey,
    pub base_mint: Pubkey,
    pub quote_mint: Pubkey,
    pub base_reserve: u64,
    pub quote_reserve: u64,
    pub coin_creator: Pubkey,
}


#[derive(Debug, Clone, Copy)]
pub struct RetracementLevel {
    pub percentage: u64,
    pub threshold: u64,
    pub sell_amount: u64,
}

#[derive(Clone, Debug)]
pub struct TokenTrackingInfo {
    pub top_pnl: f64,
    pub last_sell_time: Instant,
    pub completed_intervals: HashSet<String>,
}