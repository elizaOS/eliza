import { describe, expect, it } from 'bun:test';
import {
  AGENT_EVM_REGISTRATION_REFUND_BALANCE_DESCRIPTION,
  buildDailyLoginRewardBalanceDescription,
  classifyBalanceTransaction,
  getCapitalBaseContributionAmount,
  WELCOME_BONUS_BALANCE_DESCRIPTION,
} from '@babylon/db';
import {
  AGENT_TRANSFER_IN_TRANSACTION_TYPE,
  AGENT_TRANSFER_OUT_TRANSACTION_TYPE,
  PEER_TRANSFER_IN_TRANSACTION_TYPE,
  PEER_TRANSFER_OUT_TRANSACTION_TYPE,
} from '@babylon/shared';

describe('balance transaction capital-base classification', () => {
  it('includes external funding in both wallet and team capital base', () => {
    const transaction = {
      type: 'stripe_purchase',
      amount: '5000',
      description: 'card top-up',
    };

    const classification = classifyBalanceTransaction(transaction);

    expect(classification.capitalKind).toBe('external_funding');
    expect(classification.isExternalCapitalInflow).toBe(true);
    expect(classification.descriptionDriven).toBe(false);
    expect(getCapitalBaseContributionAmount(transaction, 'wallet')).toBe(5000);
    expect(getCapitalBaseContributionAmount(transaction, 'team')).toBe(5000);
  });

  it('counts owner funding for wallet scope but excludes it from team scope', () => {
    const transaction = {
      type: 'owner_deposit',
      amount: '1250',
      description: 'Deposit from owner',
    };

    const classification = classifyBalanceTransaction(transaction);

    expect(classification.capitalKind).toBe('internal_transfer');
    expect(classification.isInternalTransfer).toBe(true);
    expect(getCapitalBaseContributionAmount(transaction, 'wallet')).toBe(1250);
    expect(getCapitalBaseContributionAmount(transaction, 'team')).toBe(0);
  });

  it('credits received peer transfers without debiting sender historical capital', () => {
    const inboundTransfer = {
      type: PEER_TRANSFER_IN_TRANSACTION_TYPE,
      amount: '250',
      description: 'Trading balance transfer from alice',
    };
    const outboundTransfer = {
      type: PEER_TRANSFER_OUT_TRANSACTION_TYPE,
      amount: '-250',
      description: 'Trading balance transfer to bob',
    };

    expect(classifyBalanceTransaction(inboundTransfer).capitalKind).toBe(
      'internal_transfer'
    );
    expect(getCapitalBaseContributionAmount(inboundTransfer, 'wallet')).toBe(
      250
    );
    expect(getCapitalBaseContributionAmount(inboundTransfer, 'team')).toBe(250);
    expect(getCapitalBaseContributionAmount(outboundTransfer, 'wallet')).toBe(
      0
    );
    expect(getCapitalBaseContributionAmount(outboundTransfer, 'team')).toBe(0);
  });

  it('keeps agent-initiated transfers neutral for wallet and team capital base', () => {
    const inboundTransfer = {
      type: AGENT_TRANSFER_IN_TRANSACTION_TYPE,
      amount: '250',
      description: 'Trading balance transfer from agent',
    };
    const outboundTransfer = {
      type: AGENT_TRANSFER_OUT_TRANSACTION_TYPE,
      amount: '-250',
      description: 'Trading balance transfer to user',
    };

    expect(classifyBalanceTransaction(inboundTransfer).capitalKind).toBe(
      'internal_transfer'
    );
    expect(getCapitalBaseContributionAmount(inboundTransfer, 'wallet')).toBe(0);
    expect(getCapitalBaseContributionAmount(inboundTransfer, 'team')).toBe(0);
    expect(getCapitalBaseContributionAmount(outboundTransfer, 'wallet')).toBe(
      0
    );
    expect(getCapitalBaseContributionAmount(outboundTransfer, 'team')).toBe(0);
  });

  it('deducts reversals using requested balance units when present', () => {
    const transaction = {
      type: 'stripe_refund',
      amount: '-2000',
      description: JSON.stringify({
        amountUSD: 50,
        balanceUnitsRequested: 5000,
        balanceUnitsDeducted: 2000,
      }),
    };

    const classification = classifyBalanceTransaction(transaction);

    expect(classification.capitalKind).toBe('capital_reversal');
    expect(classification.isReversal).toBe(true);
    expect(getCapitalBaseContributionAmount(transaction, 'wallet')).toBe(-5000);
    expect(getCapitalBaseContributionAmount(transaction, 'team')).toBe(-5000);
  });

  it('restores capital explicitly when a dispute is won', () => {
    const transaction = {
      type: 'stripe_dispute_won',
      amount: '5000',
      description: JSON.stringify({
        amountUSD: 50,
        balanceUnitsCredited: 5000,
      }),
    };

    const classification = classifyBalanceTransaction(transaction);

    expect(classification.capitalKind).toBe('capital_restoration');
    expect(classification.isCapitalRestoration).toBe(true);
    expect(getCapitalBaseContributionAmount(transaction, 'wallet')).toBe(5000);
    expect(getCapitalBaseContributionAmount(transaction, 'team')).toBe(5000);
  });

  it('excludes non-capital deposit activity through canonical deposit reasons', () => {
    const dailyLoginReward = {
      type: 'deposit',
      amount: '150',
      description: buildDailyLoginRewardBalanceDescription(7, 50),
    };
    const agentRefund = {
      type: 'deposit',
      amount: '1000',
      description: AGENT_EVM_REGISTRATION_REFUND_BALANCE_DESCRIPTION,
    };

    expect(classifyBalanceTransaction(dailyLoginReward).depositReason).toBe(
      'daily_login_reward'
    );
    expect(getCapitalBaseContributionAmount(dailyLoginReward, 'wallet')).toBe(
      0
    );
    expect(getCapitalBaseContributionAmount(dailyLoginReward, 'team')).toBe(0);

    expect(classifyBalanceTransaction(agentRefund).depositReason).toBe(
      'agent_registration_refund'
    );
    expect(getCapitalBaseContributionAmount(agentRefund, 'wallet')).toBe(0);
    expect(getCapitalBaseContributionAmount(agentRefund, 'team')).toBe(0);
  });

  it('defaults legitimate wallet deposit funding to capital base without brittle text matching', () => {
    const welcomeBonusDeposit = {
      type: 'deposit',
      amount: '1000',
      description: WELCOME_BONUS_BALANCE_DESCRIPTION,
    };

    const classification = classifyBalanceTransaction(welcomeBonusDeposit);

    expect(classification.depositReason).toBe('default_wallet_funding');
    expect(classification.descriptionDriven).toBe(true);
    expect(
      getCapitalBaseContributionAmount(welcomeBonusDeposit, 'wallet')
    ).toBe(1000);
    expect(getCapitalBaseContributionAmount(welcomeBonusDeposit, 'team')).toBe(
      1000
    );
  });

  it('ignores non-positive legacy deposits to match the SQL capital-base path', () => {
    const legacyNegativeDeposit = {
      type: 'deposit',
      amount: '-250',
      description: 'legacy correction row',
    };

    expect(
      getCapitalBaseContributionAmount(legacyNegativeDeposit, 'wallet')
    ).toBe(0);
    expect(
      getCapitalBaseContributionAmount(legacyNegativeDeposit, 'team')
    ).toBe(0);
  });
});
