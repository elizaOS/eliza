/** Shared browser-failure classification contract for app audits. */

export const LIFEOPS_ACTIVITY_SIGNALS_PATH: string;
export const LIFEOPS_ACTIVITY_SIGNALS_INACTIVE_ERROR: string;

export function isLifeOpsActivitySignals503(
  status: number,
  url: string,
): boolean;

export function isExpectedInactiveLifeOpsActivitySignalsResponse(
  status: number,
  url: string,
  body: string | null | undefined,
): boolean;

export const isExpectedDevSmokeResponse: typeof isExpectedInactiveLifeOpsActivitySignalsResponse;

export function isExpectedDevSmokeConsoleError(
  text: string,
  locationUrl: string,
): boolean;

export class ExpectedDevSmokeFailureMatcher {
  recordResponse(status: number, url: string, body: string): boolean;
  consumeConsoleError(text: string, locationUrl: string): boolean;
}
