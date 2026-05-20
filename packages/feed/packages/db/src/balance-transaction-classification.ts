import {
  AGENT_TRANSFER_IN_TRANSACTION_TYPE,
  AGENT_TRANSFER_OUT_TRANSACTION_TYPE,
  PEER_TRANSFER_IN_TRANSACTION_TYPE,
  PEER_TRANSFER_OUT_TRANSACTION_TYPE,
} from "@feed/shared";
import type { BalanceTransaction } from "./model-types";

export const WELCOME_BONUS_BALANCE_DESCRIPTION =
  "Welcome bonus - initial signup";
export const DAILY_LOGIN_REWARD_BALANCE_DESCRIPTION_PREFIX =
  "Daily login reward";
export const AGENT_EVM_REGISTRATION_REFUND_BALANCE_DESCRIPTION =
  "Refund - agent EVM registration failed";
export const AGENT_SOLANA_REGISTRATION_REFUND_BALANCE_DESCRIPTION =
  "Refund - agent Solana registration failed";

export type CapitalBaseScope = "wallet" | "team";
export type CapitalBaseEffect = "credit" | "debit" | "none";
export type BalanceTransactionCapitalKind =
  | "external_funding"
  | "capital_reversal"
  | "capital_restoration"
  | "internal_transfer"
  | "non_capital_activity"
  | "unknown";
export type DepositClassificationReason =
  | "default_wallet_funding"
  | "daily_login_reward"
  | "agent_registration_refund";
export type CapitalAmountStrategy =
  | "absolute_amount"
  | "balance_units_requested";

type ClassifiedBalanceTransactionInput = Pick<
  BalanceTransaction,
  "type" | "amount" | "description"
>;

interface BaseCapitalClassification {
  capitalKind: BalanceTransactionCapitalKind;
  walletCapitalBaseEffect: CapitalBaseEffect;
  teamCapitalBaseEffect: CapitalBaseEffect;
  isExternalCapitalInflow: boolean;
  isInternalTransfer: boolean;
  isReversal: boolean;
  isCapitalRestoration: boolean;
  isCapitalNeutralActivity: boolean;
  amountStrategy: CapitalAmountStrategy;
  depositReason: DepositClassificationReason | null;
  descriptionDriven: boolean;
}

export interface BalanceTransactionCapitalClassification
  extends BaseCapitalClassification {
  type: string;
}

type FixedTransactionTypeRule = Omit<
  BaseCapitalClassification,
  "depositReason" | "descriptionDriven"
>;

type DepositDescriptionRule = {
  reason: Exclude<DepositClassificationReason, "default_wallet_funding">;
  matches: (description: string | null) => boolean;
  matchesSql: (transactionAlias: string) => string;
  classification: Omit<
    BaseCapitalClassification,
    "depositReason" | "descriptionDriven"
  >;
};

const FIXED_TRANSACTION_TYPE_RULES: Record<string, FixedTransactionTypeRule> = {
  crypto_purchase: {
    capitalKind: "external_funding",
    walletCapitalBaseEffect: "credit",
    teamCapitalBaseEffect: "credit",
    isExternalCapitalInflow: true,
    isInternalTransfer: false,
    isReversal: false,
    isCapitalRestoration: false,
    isCapitalNeutralActivity: false,
    amountStrategy: "absolute_amount",
  },
  stripe_purchase: {
    capitalKind: "external_funding",
    walletCapitalBaseEffect: "credit",
    teamCapitalBaseEffect: "credit",
    isExternalCapitalInflow: true,
    isInternalTransfer: false,
    isReversal: false,
    isCapitalRestoration: false,
    isCapitalNeutralActivity: false,
    amountStrategy: "absolute_amount",
  },
  stripe_refund: {
    capitalKind: "capital_reversal",
    walletCapitalBaseEffect: "debit",
    teamCapitalBaseEffect: "debit",
    isExternalCapitalInflow: false,
    isInternalTransfer: false,
    isReversal: true,
    isCapitalRestoration: false,
    isCapitalNeutralActivity: false,
    amountStrategy: "balance_units_requested",
  },
  stripe_dispute: {
    capitalKind: "capital_reversal",
    walletCapitalBaseEffect: "debit",
    teamCapitalBaseEffect: "debit",
    isExternalCapitalInflow: false,
    isInternalTransfer: false,
    isReversal: true,
    isCapitalRestoration: false,
    isCapitalNeutralActivity: false,
    amountStrategy: "balance_units_requested",
  },
  stripe_dispute_won: {
    capitalKind: "capital_restoration",
    walletCapitalBaseEffect: "credit",
    teamCapitalBaseEffect: "credit",
    isExternalCapitalInflow: false,
    isInternalTransfer: false,
    isReversal: false,
    isCapitalRestoration: true,
    isCapitalNeutralActivity: false,
    amountStrategy: "absolute_amount",
  },
  owner_deposit: {
    capitalKind: "internal_transfer",
    walletCapitalBaseEffect: "credit",
    teamCapitalBaseEffect: "none",
    isExternalCapitalInflow: false,
    isInternalTransfer: true,
    isReversal: false,
    isCapitalRestoration: false,
    isCapitalNeutralActivity: false,
    amountStrategy: "absolute_amount",
  },
  owner_withdraw: {
    capitalKind: "internal_transfer",
    walletCapitalBaseEffect: "debit",
    teamCapitalBaseEffect: "none",
    isExternalCapitalInflow: false,
    isInternalTransfer: true,
    isReversal: false,
    isCapitalRestoration: false,
    isCapitalNeutralActivity: false,
    amountStrategy: "absolute_amount",
  },
  agent_deposit: {
    capitalKind: "internal_transfer",
    walletCapitalBaseEffect: "none",
    teamCapitalBaseEffect: "none",
    isExternalCapitalInflow: false,
    isInternalTransfer: true,
    isReversal: false,
    isCapitalRestoration: false,
    isCapitalNeutralActivity: false,
    amountStrategy: "absolute_amount",
  },
  agent_withdraw: {
    capitalKind: "internal_transfer",
    walletCapitalBaseEffect: "none",
    teamCapitalBaseEffect: "none",
    isExternalCapitalInflow: false,
    isInternalTransfer: true,
    isReversal: false,
    isCapitalRestoration: false,
    isCapitalNeutralActivity: false,
    amountStrategy: "absolute_amount",
  },
  agent_balance_return: {
    capitalKind: "internal_transfer",
    walletCapitalBaseEffect: "none",
    teamCapitalBaseEffect: "none",
    isExternalCapitalInflow: false,
    isInternalTransfer: true,
    isReversal: false,
    isCapitalRestoration: false,
    isCapitalNeutralActivity: false,
    amountStrategy: "absolute_amount",
  },
  [AGENT_TRANSFER_IN_TRANSACTION_TYPE]: {
    capitalKind: "internal_transfer",
    walletCapitalBaseEffect: "none",
    teamCapitalBaseEffect: "none",
    isExternalCapitalInflow: false,
    isInternalTransfer: true,
    isReversal: false,
    isCapitalRestoration: false,
    isCapitalNeutralActivity: false,
    amountStrategy: "absolute_amount",
  },
  [AGENT_TRANSFER_OUT_TRANSACTION_TYPE]: {
    capitalKind: "internal_transfer",
    walletCapitalBaseEffect: "none",
    teamCapitalBaseEffect: "none",
    isExternalCapitalInflow: false,
    isInternalTransfer: true,
    isReversal: false,
    isCapitalRestoration: false,
    isCapitalNeutralActivity: false,
    amountStrategy: "absolute_amount",
  },
  [PEER_TRANSFER_IN_TRANSACTION_TYPE]: {
    capitalKind: "internal_transfer",
    walletCapitalBaseEffect: "credit",
    teamCapitalBaseEffect: "credit",
    isExternalCapitalInflow: false,
    isInternalTransfer: true,
    isReversal: false,
    isCapitalRestoration: false,
    isCapitalNeutralActivity: false,
    amountStrategy: "absolute_amount",
  },
  [PEER_TRANSFER_OUT_TRANSACTION_TYPE]: {
    capitalKind: "internal_transfer",
    walletCapitalBaseEffect: "none",
    teamCapitalBaseEffect: "none",
    isExternalCapitalInflow: false,
    isInternalTransfer: true,
    isReversal: false,
    isCapitalRestoration: false,
    isCapitalNeutralActivity: false,
    amountStrategy: "absolute_amount",
  },
};

const DEPOSIT_DESCRIPTION_RULES: DepositDescriptionRule[] = [
  {
    reason: "daily_login_reward",
    matches: (description) =>
      typeof description === "string" &&
      description.startsWith(DAILY_LOGIN_REWARD_BALANCE_DESCRIPTION_PREFIX),
    matchesSql: (transactionAlias) =>
      `${transactionAlias}."description" LIKE '${escapeSqlLiteral(
        `${DAILY_LOGIN_REWARD_BALANCE_DESCRIPTION_PREFIX}%`,
      )}'`,
    classification: {
      capitalKind: "non_capital_activity",
      walletCapitalBaseEffect: "none",
      teamCapitalBaseEffect: "none",
      isExternalCapitalInflow: false,
      isInternalTransfer: false,
      isReversal: false,
      isCapitalRestoration: false,
      isCapitalNeutralActivity: true,
      amountStrategy: "absolute_amount",
    },
  },
  {
    reason: "agent_registration_refund",
    matches: (description) =>
      description === AGENT_EVM_REGISTRATION_REFUND_BALANCE_DESCRIPTION ||
      description === AGENT_SOLANA_REGISTRATION_REFUND_BALANCE_DESCRIPTION,
    matchesSql: (transactionAlias) =>
      `${transactionAlias}."description" IN (${[
        AGENT_EVM_REGISTRATION_REFUND_BALANCE_DESCRIPTION,
        AGENT_SOLANA_REGISTRATION_REFUND_BALANCE_DESCRIPTION,
      ]
        .map(quoteSqlLiteral)
        .join(", ")})`,
    classification: {
      capitalKind: "non_capital_activity",
      walletCapitalBaseEffect: "none",
      teamCapitalBaseEffect: "none",
      isExternalCapitalInflow: false,
      isInternalTransfer: false,
      isReversal: false,
      isCapitalRestoration: false,
      isCapitalNeutralActivity: true,
      amountStrategy: "absolute_amount",
    },
  },
];

const DEFAULT_DEPOSIT_CLASSIFICATION: BaseCapitalClassification = {
  capitalKind: "external_funding",
  walletCapitalBaseEffect: "credit",
  teamCapitalBaseEffect: "credit",
  isExternalCapitalInflow: true,
  isInternalTransfer: false,
  isReversal: false,
  isCapitalRestoration: false,
  isCapitalNeutralActivity: false,
  amountStrategy: "absolute_amount",
  depositReason: "default_wallet_funding",
  descriptionDriven: true,
};

const UNKNOWN_TRANSACTION_CLASSIFICATION: BaseCapitalClassification = {
  capitalKind: "unknown",
  walletCapitalBaseEffect: "none",
  teamCapitalBaseEffect: "none",
  isExternalCapitalInflow: false,
  isInternalTransfer: false,
  isReversal: false,
  isCapitalRestoration: false,
  isCapitalNeutralActivity: false,
  amountStrategy: "absolute_amount",
  depositReason: null,
  descriptionDriven: false,
};

function quoteSqlLiteral(value: string): string {
  return `'${escapeSqlLiteral(value)}'`;
}

function escapeSqlLiteral(value: string): string {
  return value.replaceAll("'", "''");
}

function buildScopedTypes(effect: CapitalBaseEffect, scope: CapitalBaseScope) {
  return Object.entries(FIXED_TRANSACTION_TYPE_RULES)
    .filter(([, rule]) =>
      scope === "wallet"
        ? rule.walletCapitalBaseEffect === effect
        : rule.teamCapitalBaseEffect === effect,
    )
    .map(([type]) => type);
}

export function buildDailyLoginRewardBalanceDescription(
  streak: number,
  milestoneBonus: number,
): string {
  return `${DAILY_LOGIN_REWARD_BALANCE_DESCRIPTION_PREFIX} (Day ${streak})${milestoneBonus ? ` + ${streak}-day milestone` : ""}`;
}

export function classifyBalanceTransaction(
  transaction: ClassifiedBalanceTransactionInput,
): BalanceTransactionCapitalClassification {
  if (transaction.type === "deposit") {
    const matchedRule = DEPOSIT_DESCRIPTION_RULES.find((rule) =>
      rule.matches(transaction.description),
    );

    if (matchedRule) {
      return {
        type: transaction.type,
        ...matchedRule.classification,
        depositReason: matchedRule.reason,
        descriptionDriven: true,
      };
    }

    return {
      type: transaction.type,
      ...DEFAULT_DEPOSIT_CLASSIFICATION,
    };
  }

  const fixedRule = FIXED_TRANSACTION_TYPE_RULES[transaction.type];
  if (fixedRule) {
    return {
      type: transaction.type,
      ...fixedRule,
      depositReason: null,
      descriptionDriven: false,
    };
  }

  return {
    type: transaction.type,
    ...UNKNOWN_TRANSACTION_CLASSIFICATION,
  };
}

export function extractCapitalBaseAmount(
  transaction: ClassifiedBalanceTransactionInput,
): number {
  if (transaction.type === "deposit" && Number(transaction.amount ?? 0) <= 0) {
    return 0;
  }

  const classification = classifyBalanceTransaction(transaction);
  const fallbackAmount = Math.abs(Number(transaction.amount ?? 0));

  if (classification.amountStrategy !== "balance_units_requested") {
    return fallbackAmount;
  }

  const requestedUnits = extractRequestedBalanceUnits(transaction.description);
  return requestedUnits ?? fallbackAmount;
}

export function getCapitalBaseContributionAmount(
  transaction: ClassifiedBalanceTransactionInput,
  scope: CapitalBaseScope,
): number {
  const classification = classifyBalanceTransaction(transaction);
  const effect =
    scope === "wallet"
      ? classification.walletCapitalBaseEffect
      : classification.teamCapitalBaseEffect;

  if (effect === "none") {
    return 0;
  }

  const amount = extractCapitalBaseAmount(transaction);
  return effect === "credit" ? amount : -amount;
}

export function buildCapitalBaseContributionSql(
  transactionAlias: string,
  scope: CapitalBaseScope,
): string {
  const positiveTypes = buildScopedTypes("credit", scope);
  const negativeTypes = buildScopedTypes("debit", scope);
  const reversalAmountExpression = buildReversalAmountSql(transactionAlias);
  const depositContributionCondition = buildDepositContributionSql(
    transactionAlias,
    scope,
  );

  const cases: string[] = [];

  if (positiveTypes.length > 0) {
    cases.push(`
      WHEN ${transactionAlias}."type" IN (${positiveTypes
        .map(quoteSqlLiteral)
        .join(", ")})
        THEN ABS(${transactionAlias}."amount"::numeric)
    `);
  }

  if (negativeTypes.length > 0) {
    cases.push(`
      WHEN ${transactionAlias}."type" IN (${negativeTypes
        .map(quoteSqlLiteral)
        .join(", ")})
        THEN -(${reversalAmountExpression})
    `);
  }

  if (depositContributionCondition) {
    cases.push(`
      WHEN ${depositContributionCondition}
        THEN ABS(${transactionAlias}."amount"::numeric)
    `);
  }

  return `
    CASE
      ${cases.join("\n")}
      ELSE 0::numeric
    END
  `;
}

function buildDepositContributionSql(
  transactionAlias: string,
  scope: CapitalBaseScope,
): string | null {
  if (scope === "team") {
    if (DEFAULT_DEPOSIT_CLASSIFICATION.teamCapitalBaseEffect !== "credit") {
      return null;
    }
  } else if (
    DEFAULT_DEPOSIT_CLASSIFICATION.walletCapitalBaseEffect !== "credit"
  ) {
    return null;
  }

  const exclusionClauses = DEPOSIT_DESCRIPTION_RULES.filter(
    (rule) =>
      (scope === "wallet"
        ? rule.classification.walletCapitalBaseEffect
        : rule.classification.teamCapitalBaseEffect) === "none",
  ).map((rule) => `NOT (${rule.matchesSql(transactionAlias)})`);

  const exclusionCondition =
    exclusionClauses.length > 0 ? exclusionClauses.join(" AND ") : "TRUE";

  return `
    ${transactionAlias}."type" = 'deposit'
    AND ${transactionAlias}."amount"::numeric > 0
    AND (
      ${transactionAlias}."description" IS NULL
      OR (${exclusionCondition})
    )
  `;
}

function buildReversalAmountSql(transactionAlias: string): string {
  return `
    CASE
      WHEN ${transactionAlias}."description" IS NOT NULL
        AND LEFT(${transactionAlias}."description", 1) = '{'
      THEN COALESCE(
        NULLIF(
          (${transactionAlias}."description"::jsonb ->> 'balanceUnitsRequested'),
          ''
        )::numeric,
        ABS(${transactionAlias}."amount"::numeric)
      )
      ELSE ABS(${transactionAlias}."amount"::numeric)
    END
  `;
}

function extractRequestedBalanceUnits(
  description: string | null,
): number | null {
  if (!description?.startsWith("{")) {
    return null;
  }

  try {
    const parsed = JSON.parse(description) as {
      balanceUnitsRequested?: unknown;
    };
    const requested = parsed.balanceUnitsRequested;

    if (typeof requested === "number" && Number.isFinite(requested)) {
      return Math.abs(requested);
    }

    if (typeof requested === "string") {
      const numericValue = Number(requested);
      if (Number.isFinite(numericValue)) {
        return Math.abs(numericValue);
      }
    }
  } catch {
    return null;
  }

  return null;
}
