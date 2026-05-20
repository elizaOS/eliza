/**
 * @deprecated Import ReputationService from './reputation-service' or
 * '@feed/api' instead. This alias remains for compatibility while
 * downstream consumers migrate away from ambiguous "points" naming.
 */

export {
  type AwardReputationResult as AwardPointsResult,
  type ReputationHistoryItem as PointsHistoryItem,
  ReputationService as PointsService,
} from './reputation-service';
