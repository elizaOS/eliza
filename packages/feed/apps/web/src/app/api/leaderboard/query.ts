import { ApiError } from '@babylon/api';
import { LeaderboardQuerySchema } from '@babylon/shared';

const SUPPORTED_LEADERBOARD_QUERY_PARAMS = new Set([
  'page',
  'pageSize',
  'metric',
  'type',
  'userId',
]);

export function parseLeaderboardQuery(searchParams: URLSearchParams) {
  const unsupportedParams = Array.from(searchParams.keys()).filter(
    (key) => !SUPPORTED_LEADERBOARD_QUERY_PARAMS.has(key)
  );

  if (unsupportedParams.length > 0) {
    throw new ApiError(
      `Unsupported query parameter${unsupportedParams.length === 1 ? '' : 's'}: ${unsupportedParams.join(
        ', '
      )}`,
      400
    );
  }

  const validationResult = LeaderboardQuerySchema.safeParse(
    Object.fromEntries(searchParams.entries())
  );

  if (!validationResult.success) {
    throw validationResult.error;
  }

  return validationResult.data;
}
