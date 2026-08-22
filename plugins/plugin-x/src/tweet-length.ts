/** Uses X's reference parser as the admission authority for post length. */
import twitterText from "twitter-text";

/** Weighted length used by X for the 280-unit tweet cap. */
export function countTwitterWeightedLength(text: string): number {
  return twitterText.parseTweet(text).weightedLength;
}
