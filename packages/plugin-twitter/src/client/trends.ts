import { addApiParams, requestApi } from './api';
import type { TwitterAuth } from './auth';
import type { TimelineV1 } from './timeline-v1';

/**
 * Retrieves the current trends from the Twitter API.
 *
 * @param {TwitterAuth} auth - The authentication credentials for accessing the Twitter API.
 * @returns {Promise<string[]>} An array of strings representing the current trends.
 * @throws {Error} If no trend entries are found in the response.
 */
export async function getTrends(auth: TwitterAuth): Promise<string[]> {
  const params = new URLSearchParams();
  addApiParams(params, false);

  params.set('count', '20');
  params.set('candidate_source', 'trends');
  params.set('include_page_configuration', 'false');
  params.set('entity_tokens', 'false');

  const res = await requestApi<TimelineV1>(
    `https://api.twitter.com/2/guide.json?${params.toString()}`,
    auth
  );
  if (!res.success) {
    throw res.err;
  }

  const instructions = res.value.timeline?.instructions ?? [];
  if (instructions.length < 2) {
    throw new Error('No trend entries found.');
  }

  // Some of this is silly, but for now we're assuming we know nothing about the
  // data, and that anything can be missing. Go has non-nilable strings and empty
  // slices are nil, so it largely doesn't need to worry about this.
  const entries = instructions[1].addEntries?.entries ?? [];
  if (entries.length < 2) {
    throw new Error('No trend entries found.');
  }

  const items = entries[1].content?.timelineModule?.items ?? [];
  const trends: string[] = [];
  for (const item of items) {
    const trend =
      item.item?.clientEventInfo?.details?.guideDetails?.transparentGuideDetails?.trendMetadata
        ?.trendName;
    if (trend != null) {
      trends.push(trend);
    }
  }

  return trends;
}
