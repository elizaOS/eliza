/**
 * Explicit-recurrence detection for cadence guards: does the user's own text
 * state a REPEATING schedule? This is deliberately narrower than the
 * `lifeops_cadence` keyword doc — that doc also carries time-of-day WINDOW
 * phrases ("in the morning", "before bed", "after work") used for window
 * extraction, and a window phrase in a one-shot ask ("remind me to call mom
 * in the morning") is not a recurrence statement. Guards that consumed the
 * full doc flipped both ways: one-shot reminders lost their run cap and
 * one-off calendar events kept model-invented RRULEs.
 *
 * ASCII languages match on word boundaries with schedule-noun anchoring so
 * quantifier uses ("invite every member") stay out; CJK matches by substring.
 */

const ASCII_RECURRENCE_PATTERNS: readonly RegExp[] = [
  // en: every/each anchored to a schedule noun within the phrase
  /\b(?:every|each)\s+(?:other\s+)?(?:day|week|month|year|morning|afternoon|evening|night|hour|weekday|weekend|mon(?:day)?|tues?(?:day)?|wed(?:nesday)?|thur?s?(?:day)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)s?\b/i,
  // "daily"/es "diario" match lowercase only: title-cased uses are names
  // ("Daily Planet interview", "comprar el Diario") — the review's observed
  // false-positive class.
  /\bdaily\b/,
  /\b(?:weekly|monthly|nightly|hourly|yearly|annually|quarterly|biweekly|fortnightly)\b/i,
  /\brepeat(?:s|ing)\b|\brecurring\b|\brecurs?\b/i,
  /\b(?:once|twice|thrice|\d+\s*times)\s+(?:a|per|each|every)\s+(?:day|week|month|year)\b/i,
  /\bper\s+(?:day|week|month|year)\b/i,
  /\b(?:on\s+)?(?:mondays|tuesdays|wednesdays|thursdays|fridays|saturdays|sundays)\b/i,
  /\b(?:weekdays|weekends)\b/i,
  // es: cada / todos los / todas las + schedule noun; adjective forms
  /\b(?:cada|todos\s+los|todas\s+las)\s+(?:d[ií]as?|semanas?|mes(?:es)?|años?|mañanas?|noches?|tardes?|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bados?|domingos?)\b/i,
  /\bdiario\b/,
  /\b(?:diaria(?:mente)?|semanal(?:mente)?|mensual(?:mente)?|anual(?:mente)?)\b/i,
  /\blos\s+(?:lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bados|domingos)\b/i,
  /\buna\s+vez\s+(?:a\s+la|por)\s+semana\b/i,
  // pt: cada / todos os / todas as + schedule noun; adjective forms
  /\b(?:cada|todos\s+os|todas\s+as)\s+(?:dias?|semanas?|m[eê]s(?:es)?|anos?|manh[aã]s?|noites?|tardes?|segundas?|ter[cç]as?|quartas?|quintas?|sextas?|s[aá]bados?|domingos?)\b/i,
  /\b(?:diariamente|semanal(?:mente)?|mensal(?:mente)?|anual(?:mente)?)\b/i,
  /\b(?:toda|todo)\s+(?:semana|m[eê]s|ano|segunda|ter[cç]a|quarta|quinta|sexta|s[aá]bado|domingo)\b/i,
  /\buma\s+vez\s+por\s+(?:semana|m[eê]s)\b/i,
  // vi: mỗi / hàng + schedule noun
  /(?:mỗi|hàng|hằng)\s*(?:ngày|tuần|tháng|năm|sáng|tối|chiều)/i,
  // tl: reduplicated schedule nouns and "tuwing"
  /\b(?:araw-araw|linggo-linggo|buwan-buwan|taon-taon|gabi-gabi|tuwing|bawat\s+(?:araw|linggo|buwan|taon))\b/i,
];

// CJK repetition markers — substring matches (no word boundaries).
const CJK_RECURRENCE_MARKERS: readonly string[] = [
  // zh-CN
  "每天",
  "每日",
  "每周",
  "每星期",
  "每个星期",
  "每月",
  "每个月",
  "每年",
  "天天",
  "周一到周五",
  "一周一次",
  "每逢",
  // ko — 마다 is the productive "every" suffix
  "마다",
  "매일",
  "매주",
  "매월",
  "매달",
  "매년",
  "격주",
];

/**
 * True when any of the provided texts states a repeating cadence in the
 * user's own words. Pass every text the turn can ground recurrence in — the
 * raw user message, the planner intent, and the recent-conversation window a
 * clarify round-trip carries ("make it weekly" answered in a prior turn).
 */
export function textStatesExplicitRecurrence(
  ...texts: ReadonlyArray<string | null | undefined>
): boolean {
  for (const text of texts) {
    if (typeof text !== "string" || !text.trim()) continue;
    if (ASCII_RECURRENCE_PATTERNS.some((pattern) => pattern.test(text))) {
      return true;
    }
    if (CJK_RECURRENCE_MARKERS.some((marker) => text.includes(marker))) {
      return true;
    }
  }
  return false;
}
