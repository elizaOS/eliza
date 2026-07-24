import { analyzeWalletActivity } from "../analyzers/activity";
import { analyzeWalletAge } from "../analyzers/walletAge";
import { analyzeWalletAssessment } from "../analyzers/assessment";
import { analyzeWalletBehavior } from "../analyzers/behavior";
import { analyzeWalletCaseSummary } from "../analyzers/caseSummary";
import { analyzeWalletCompliance } from "../analyzers/compliance";
import { analyzeWalletCustodyProfile } from "../analyzers/custody";
import { analyzeWalletDecision } from "../analyzers/decision";
import { analyzeWalletDeFi } from "../analyzers/defi";
import { analyzeWalletDisplayScores } from "../analyzers/display";
import { analyzeWalletEvidence } from "../analyzers/evidence";
import { analyzeWalletEvidenceRecords } from "../analyzers/evidenceRecords";
import { analyzeExecutiveVerdict } from "../analyzers/executiveVerdict";
import { analyzeWalletExposure } from "../analyzers/exposure";
import { analyzeWalletFunding } from "../analyzers/funding";
import { analyzeWalletIntelligenceBrief } from "../analyzers/intelligenceBrief";
import { analyzeInvestigationNarrative } from "../analyzers/investigationNarrative";
import { analyzeInvestigationReplay } from "../analyzers/investigationReplay";
import { analyzeInvestigationReport } from "../analyzers/investigationReport";
import { analyzeWalletPortfolio } from "../analyzers/portfolio";
import { analyzeProtocolIntelligence } from "../analyzers/protocolIntelligence";
import { analyzeWalletProtocols } from "../analyzers/protocols";
import { analyzeWalletRelationships } from "../analyzers/relationships";
import { analyzeWalletRisk } from "../analyzers/risk";
import { analyzeWalletSmartMoney } from "../analyzers/smartMoney";
import { analyzeWalletConviction } from "../analyzers/conviction";
import { analyzeWalletAlpha } from "../analyzers/alpha";
import { analyzeInvestmentStyle } from "../analyzers/investmentStyle";
import { analyzeWalletProfitability } from "../analyzers/profitability";
import { analyzeWalletReputation } from "../analyzers/reputation";
import { analyzeWalletStrategy } from "../analyzers/strategy";
import { analyzeWalletTransactionRisk } from "../analyzers/transactionRisk";
import { analyzeWalletTrust } from "../analyzers/trust";
import { analyzeWalletWhaleStatus } from "../analyzers/whale";
import { getWalletIntelligenceSources } from "../sources/registry";
import {
  WalletPipelineInput,
  WalletPipelineOutput,
} from "./types";

export function runWalletPipeline(
  input: WalletPipelineInput,
): WalletPipelineOutput {
  const activity = analyzeWalletActivity(
    input.recentTransactions,
  );

  const age = analyzeWalletAge(
    input.oldestTransactionId,
    input.oldestTransactionTimestamp,
  );

  const funding = analyzeWalletFunding(
    input.chain,
    input.address,
    input.firstParsedTransaction,
  );

  const portfolio = analyzeWalletPortfolio(
    input.balance,
    input.tokenHoldings,
    input.tokenPrices,
  );

  const risk = analyzeWalletRisk(
    input.balance.nativeAmount,
    activity,
  );

  const whale = analyzeWalletWhaleStatus(
    portfolio,
    age,
    activity,
    funding,
    risk,
  );

  const defi = analyzeWalletDeFi(
    input.parsedTransactions,
  );

  const protocols = analyzeWalletProtocols(
    input.parsedTransactions,
  );

  const protocolIntelligence =
    analyzeProtocolIntelligence(protocols);

  const behavior = analyzeWalletBehavior(
  activity,
  age,
  defi,
  protocolIntelligence,
  whale,
  risk,
);

  const exposure = analyzeWalletExposure(
    input.address,
    funding,
  );

  const relationships = analyzeWalletRelationships(
    funding,
    input.address,
    input.parsedTransactions,
  );

  const custodyProfile = analyzeWalletCustodyProfile(
    activity,
    funding,
    relationships,
  );

  const complianceScreening = analyzeWalletCompliance(
    exposure,
  );

  const intelligenceSources =
    getWalletIntelligenceSources();

  const trust = analyzeWalletTrust(
    age,
    activity,
    funding,
    exposure,
    risk,
  );

  const display = analyzeWalletDisplayScores(
    risk,
    trust,
    exposure,
    whale,
  );

  const caseSummary = analyzeWalletCaseSummary(
    age,
    risk,
    whale,
    defi,
    behavior,
  );

  const transactionRisk = analyzeWalletTransactionRisk(
    risk,
    trust,
    exposure,
    complianceScreening,
    caseSummary,
  );

  const {
    recommendation: _legacyTransactionRiskRecommendation,
    ...transactionRiskAssessment
  } = transactionRisk;

  void _legacyTransactionRiskRecommendation;

  const smartMoney = analyzeWalletSmartMoney(
    age,
    activity,
    defi,
    portfolio,
    whale,
    trust,
  );

  const strategy = analyzeWalletStrategy({
  activity,
  age,
  portfolio,
  behavior,
  defi,
  whale,
  smartMoney,
});

  const conviction = analyzeWalletConviction({
  activity,
  portfolio,
  behavior,
  strategy,
  whale,
  smartMoney,
});

  const alpha = analyzeWalletAlpha({
  risk,
  trust,
  portfolio,
  whale,
  smartMoney,
  strategy,
  conviction,
  defi,
  protocolIntelligence,
});

  const investmentStyle = analyzeInvestmentStyle({
  strategy,
  smartMoney,
  conviction,
  alpha,
  portfolio,
  whale,
  defi,
});

  const profitability = analyzeWalletProfitability({
  alpha,
  conviction,
  strategy,
  trust,
  smartMoney,
  portfolio,
});

  const reputation = analyzeWalletReputation({
  trust,
  risk,
  smartMoney,
  alpha,
  profitability,
});

  const investigationReplay =
    analyzeInvestigationReplay(
      portfolio,
      activity,
      age,
      funding,
      defi,
      exposure,
      relationships,
      risk,
      whale,
      trust,
    );

  const evidenceRecords =
    analyzeWalletEvidenceRecords(
      input.address,
      activity,
      age,
      funding,
      portfolio,
      defi,
      exposure,
      relationships,
      complianceScreening,
      custodyProfile,
      risk,
      whale,
      smartMoney,
      transactionRisk,
    );

  const decision = analyzeWalletDecision(
    evidenceRecords,
    risk,
    trust,
    exposure,
    transactionRisk,
  );

  const assessment = analyzeWalletAssessment(
    risk,
    trust,
    exposure,
    transactionRisk,
    evidenceRecords,
  );

  const intelligenceBrief =
    analyzeWalletIntelligenceBrief(
      assessment,
      evidenceRecords,
    );

  const evidence = analyzeWalletEvidence(
    evidenceRecords,
  );

  const executiveVerdict = analyzeExecutiveVerdict(
    display,
    behavior,
    caseSummary,
    evidence,
    exposure,
    risk,
    trust,
    decision,
  );

  const investigationReport =
    analyzeInvestigationReport(
      input.chain,
      input.address,
      executiveVerdict,
      caseSummary,
      decision,
      evidenceRecords,
    );

  const investigationNarrative =
    analyzeInvestigationNarrative(
      executiveVerdict,
      caseSummary,
      trust,
      decision,
      evidenceRecords,
    );

  return {
    activity,
    age,
    funding,
    portfolio,
    risk,
    whale,
    defi,
    protocols,
    protocolIntelligence,
    behavior,
    exposure,
    relationships,
    custodyProfile,
    complianceScreening,
    intelligenceSources,
    trust,
    display,
    caseSummary,
    transactionRisk,
    transactionRiskAssessment,
    smartMoney,
    strategy,
    conviction,
    alpha,
    investmentStyle,
    profitability,
    reputation,
    investigationReplay,
    evidenceRecords,
    decision,
    assessment,
    intelligenceBrief,
    evidence,
    executiveVerdict,
    investigationReport,
    investigationNarrative,
  };
}
