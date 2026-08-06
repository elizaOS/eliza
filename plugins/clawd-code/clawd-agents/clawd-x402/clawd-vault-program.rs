//! ClawdRouter on-chain registry + revenue vault.
//!
//! Responsibilities:
//!   - Register agents (PDA seeded by owner pubkey)
//!   - Accept payments into a per-agent vault ATA
//!   - Distribute vault balance across (owner, buyback, treasury, operator)
//!   - Update agent pricing + split config (owner-only)
//!
//! The split percentages are stored per-agent so holders who register richly-priced
//! agents can tune the economics themselves within caps enforced by the program.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

declare_id!("REPLACE_WITH_PROGRAM_ID_AFTER_ANCHOR_BUILD");

pub const REGISTRY_SEED: &[u8] = b"clawd-registry-v1";
pub const VAULT_SEED: &[u8] = b"clawd-vault-v1";

// Caps (basis points). Protects holders from a footgun where they accidentally send 100% to operator.
pub const MIN_OWNER_BPS: u16 = 5000;   // owner must keep ≥ 50%
pub const MAX_OPERATOR_BPS: u16 = 1000; // operator ≤ 10%

#[program]
pub mod clawd_vault {
    use super::*;

    /// Create a new agent registry entry. The caller becomes the owner.
    pub fn register_agent(
        ctx: Context<RegisterAgent>,
        manifest_cid: [u8; 64],
        endpoint: [u8; 128],
        split: SplitConfig,
        protocols_mask: u8,
        pricing: Vec<PricingEntry>,
    ) -> Result<()> {
        split.validate()?;
        require!(pricing.len() <= 16, VaultError::TooManyPricingEntries);

        let agent = &mut ctx.accounts.agent;
        agent.owner = ctx.accounts.owner.key();
        agent.manifest_cid = manifest_cid;
        agent.endpoint = endpoint;
        agent.split_owner_bps = split.owner_bps;
        agent.split_buyback_bps = split.buyback_bps;
        agent.split_treasury_bps = split.treasury_bps;
        agent.split_operator_bps = split.operator_bps;
        agent.protocols_mask = protocols_mask;
        agent.pricing_count = pricing.len() as u8;

        for (i, entry) in pricing.into_iter().enumerate() {
            agent.pricing[i] = entry;
        }

        emit!(AgentRegistered { agent: agent.key(), owner: agent.owner });
        Ok(())
    }

    /// Owner-only: update pricing and/or split.
    pub fn update_agent(
        ctx: Context<UpdateAgent>,
        new_split: Option<SplitConfig>,
        new_pricing: Option<Vec<PricingEntry>>,
        new_protocols_mask: Option<u8>,
    ) -> Result<()> {
        let agent = &mut ctx.accounts.agent;
        require!(agent.owner == ctx.accounts.owner.key(), VaultError::NotOwner);

        if let Some(s) = new_split {
            s.validate()?;
            agent.split_owner_bps = s.owner_bps;
            agent.split_buyback_bps = s.buyback_bps;
            agent.split_treasury_bps = s.treasury_bps;
            agent.split_operator_bps = s.operator_bps;
        }
        if let Some(p) = new_pricing {
            require!(p.len() <= 16, VaultError::TooManyPricingEntries);
            agent.pricing_count = p.len() as u8;
            for (i, e) in p.into_iter().enumerate() {
                agent.pricing[i] = e;
            }
        }
        if let Some(m) = new_protocols_mask {
            agent.protocols_mask = m;
        }

        Ok(())
    }

    /// Distribute accumulated revenue from the agent's vault ATA.
    /// Anyone can call this — the program enforces the split — but only the
    /// operator named at distribute-time gets the operator share.
    pub fn distribute(ctx: Context<Distribute>, amount: u64) -> Result<()> {
        require!(amount > 0, VaultError::ZeroAmount);
        require!(
            ctx.accounts.vault_ata.amount >= amount,
            VaultError::InsufficientVaultBalance
        );

        let agent = &ctx.accounts.agent;
        let owner_bps = agent.split_owner_bps as u128;
        let buyback_bps = agent.split_buyback_bps as u128;
        let treasury_bps = agent.split_treasury_bps as u128;
        let operator_bps = agent.split_operator_bps as u128;

        let amount_u128 = amount as u128;
        let owner_share = (amount_u128 * owner_bps / 10000) as u64;
        let buyback_share = (amount_u128 * buyback_bps / 10000) as u64;
        let treasury_share = (amount_u128 * treasury_bps / 10000) as u64;
        let operator_share = (amount_u128 * operator_bps / 10000) as u64;

        // Owner absorbs rounding dust so totals never exceed `amount`.
        let distributed = owner_share + buyback_share + treasury_share + operator_share;
        let dust = amount - distributed;
        let owner_share_final = owner_share + dust;

        let agent_key = agent.key();
        let seeds: &[&[u8]] = &[VAULT_SEED, agent_key.as_ref(), &[ctx.bumps.vault_authority]];
        let signer_seeds = &[seeds];

        transfer_from_vault(&ctx, &ctx.accounts.owner_ata, owner_share_final, signer_seeds)?;
        transfer_from_vault(&ctx, &ctx.accounts.buyback_ata, buyback_share, signer_seeds)?;
        transfer_from_vault(&ctx, &ctx.accounts.treasury_ata, treasury_share, signer_seeds)?;
        transfer_from_vault(&ctx, &ctx.accounts.operator_ata, operator_share, signer_seeds)?;

        emit!(Distributed {
            agent: agent_key,
            amount,
            owner: owner_share_final,
            buyback: buyback_share,
            treasury: treasury_share,
            operator: operator_share,
        });
        Ok(())
    }
}

fn transfer_from_vault<'info>(
    ctx: &Context<Distribute>,
    to: &Account<'info, TokenAccount>,
    amount: u64,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let cpi_accounts = Transfer {
        from: ctx.accounts.vault_ata.to_account_info(),
        to: to.to_account_info(),
        authority: ctx.accounts.vault_authority.to_account_info(),
    };
    let cpi_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        cpi_accounts,
        signer_seeds,
    );
    token::transfer(cpi_ctx, amount)
}

/* ——— Accounts & state ——— */

#[account]
pub struct Agent {
    pub owner: Pubkey,
    pub manifest_cid: [u8; 64],
    pub endpoint: [u8; 128],
    pub split_owner_bps: u16,
    pub split_buyback_bps: u16,
    pub split_treasury_bps: u16,
    pub split_operator_bps: u16,
    pub protocols_mask: u8,
    pub pricing_count: u8,
    pub pricing: [PricingEntry; 16],
}

impl Agent {
    pub const LEN: usize = 8      // anchor discriminator
        + 32                      // owner
        + 64                      // manifest_cid
        + 128                     // endpoint
        + 2 + 2 + 2 + 2           // splits
        + 1                       // protocols_mask
        + 1                       // pricing_count
        + (16 * PricingEntry::LEN); // pricing array
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default)]
pub struct PricingEntry {
    pub method_hash: [u8; 8],
    pub amount: u64,
}
impl PricingEntry {
    pub const LEN: usize = 8 + 8;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct SplitConfig {
    pub owner_bps: u16,
    pub buyback_bps: u16,
    pub treasury_bps: u16,
    pub operator_bps: u16,
}
impl SplitConfig {
    pub fn validate(&self) -> Result<()> {
        let total = self.owner_bps + self.buyback_bps + self.treasury_bps + self.operator_bps;
        require!(total == 10000, VaultError::SplitMustSumTo10000);
        require!(self.owner_bps >= MIN_OWNER_BPS, VaultError::OwnerShareTooLow);
        require!(self.operator_bps <= MAX_OPERATOR_BPS, VaultError::OperatorShareTooHigh);
        Ok(())
    }
}

#[derive(Accounts)]
pub struct RegisterAgent<'info> {
    #[account(
        init,
        payer = owner,
        space = Agent::LEN,
        seeds = [REGISTRY_SEED, owner.key().as_ref()],
        bump,
    )]
    pub agent: Account<'info, Agent>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateAgent<'info> {
    #[account(
        mut,
        seeds = [REGISTRY_SEED, owner.key().as_ref()],
        bump,
    )]
    pub agent: Account<'info, Agent>,
    pub owner: Signer<'info>,
}

#[derive(Accounts)]
pub struct Distribute<'info> {
    #[account(
        seeds = [REGISTRY_SEED, agent.owner.as_ref()],
        bump,
    )]
    pub agent: Account<'info, Agent>,

    /// CHECK: PDA authority for the vault ATA
    #[account(
        seeds = [VAULT_SEED, agent.key().as_ref()],
        bump,
    )]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(mut, token::authority = vault_authority)]
    pub vault_ata: Account<'info, TokenAccount>,

    #[account(mut)]
    pub owner_ata: Account<'info, TokenAccount>,
    #[account(mut)]
    pub buyback_ata: Account<'info, TokenAccount>,
    #[account(mut)]
    pub treasury_ata: Account<'info, TokenAccount>,
    #[account(mut)]
    pub operator_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

/* ——— Events ——— */

#[event]
pub struct AgentRegistered {
    pub agent: Pubkey,
    pub owner: Pubkey,
}

#[event]
pub struct Distributed {
    pub agent: Pubkey,
    pub amount: u64,
    pub owner: u64,
    pub buyback: u64,
    pub treasury: u64,
    pub operator: u64,
}

/* ——— Errors ——— */

#[error_code]
pub enum VaultError {
    #[msg("Split bps must sum to 10000")]
    SplitMustSumTo10000,
    #[msg("Owner share must be at least 50%")]
    OwnerShareTooLow,
    #[msg("Operator share must be at most 10%")]
    OperatorShareTooHigh,
    #[msg("Pricing table is full (max 16 entries)")]
    TooManyPricingEntries,
    #[msg("Caller is not the agent owner")]
    NotOwner,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Vault balance is insufficient for the requested distribution")]
    InsufficientVaultBalance,
}
