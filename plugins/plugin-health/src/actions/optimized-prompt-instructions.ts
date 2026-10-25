/**
 * Baseline prompt instructions for the HEALTH action planner, resolved through
 * the runtime's optimized-prompt layer at plan time.
 */
export const HEALTH_PLAN_INSTRUCTIONS = [
  "Plan the HEALTH action for this request.",
  "The user may speak in any language.",
  "Return JSON only as a single object with exactly these fields:",
  "subaction: today|trend|by_metric|status|null",
  "metric: steps|heart_rate|sleep_hours|calories|distance_meters|active_minutes|null",
  "days: number|null",
  "shouldAct: true|false",
  "response: string|null",
  "",
  "Choose status when the user asks about health backend connection or availability.",
  "Choose trend when the user asks for fitness/health activity over a window of days, a week, or recent history.",
  "Choose by_metric when the user names a specific metric and wants its current or recent value.",
  "Choose today (default) when the user asks for today's overall summary.",
  "metric must be one of the listed enum values when subaction=by_metric, otherwise null.",
  "days must be a positive integer the user implies (e.g. 7 for 'this week'); null when not stated.",
  "Set shouldAct=false only when the request is too vague to choose any subaction.",
  "When shouldAct=false, response must be a short clarifying question in the user's language.",
  "",
  'Example: {"subaction":"today","metric":null,"days":null,"shouldAct":true,"response":null}',
].join("\n");

export const SCREENTIME_RECAP_INSTRUCTIONS = `Summarize the owner's screen-time and propose one focus adjustment.

Rules:
- highlight the largest changes vs. the prior period, not raw totals alone
- tie any suggestion to an actual usage pattern in the data
- propose at most one concrete blocker or focus change
- keep the tone factual and non-clinical

Return JSON object only: { recap, topApps: [{ app, minutes }], suggestion }.`;
