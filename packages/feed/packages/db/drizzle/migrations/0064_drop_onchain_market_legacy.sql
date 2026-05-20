DROP INDEX IF EXISTS "Market_onChainMarketId_idx";
DROP INDEX IF EXISTS "PerpPosition_settledToChain_idx";
DROP INDEX IF EXISTS "Question_oraclePublishedAt_idx";
DROP INDEX IF EXISTS "Question_oracleSessionId_idx";

ALTER TABLE "Question" DROP CONSTRAINT IF EXISTS "Question_oracleSessionId_unique";

ALTER TABLE "Market"
  DROP COLUMN IF EXISTS "onChainMarketId",
  DROP COLUMN IF EXISTS "onChainResolutionTxHash",
  DROP COLUMN IF EXISTS "onChainResolved",
  DROP COLUMN IF EXISTS "oracleAddress";

ALTER TABLE "Question"
  DROP COLUMN IF EXISTS "oracleCommitBlock",
  DROP COLUMN IF EXISTS "oracleCommitTxHash",
  DROP COLUMN IF EXISTS "oracleCommitment",
  DROP COLUMN IF EXISTS "oracleError",
  DROP COLUMN IF EXISTS "oraclePublishedAt",
  DROP COLUMN IF EXISTS "oracleRevealBlock",
  DROP COLUMN IF EXISTS "oracleRevealTxHash",
  DROP COLUMN IF EXISTS "oracleSaltEncrypted",
  DROP COLUMN IF EXISTS "oracleSessionId";

ALTER TABLE "PerpPosition"
  DROP COLUMN IF EXISTS "settledToChain",
  DROP COLUMN IF EXISTS "settlementTxHash";

DROP TABLE IF EXISTS "OracleTransaction";
DROP TABLE IF EXISTS "OracleCommitment";
