/**
 * Canonical owner-authority policy for creating a Todo without a schedule.
 * Deterministic action validation and every LifeOps extraction prompt consume
 * this ordered multilingual policy so later corrections win and model wording
 * cannot drift from the write boundary.
 */

import {
  normalizeKeywordMatchText,
  textStatesExplicitRecurrence,
  UI_LANGUAGES,
  type UiLanguage,
} from "@elizaos/shared";

type PhraseSpec = {
  value: string;
  wordBounded?: boolean;
};

type TextSpan = {
  start: number;
  end: number;
};

type UndatedDirective = TextSpan & {
  kind: "allow" | "deny";
};

type LocalePolicy = {
  label: string;
  explicitPhrases: readonly PhraseSpec[];
  promptExample: string;
  negationBefore: readonly RegExp[];
  negationAfter: readonly RegExp[];
  scheduleMarkers: readonly RegExp[];
  negatedScheduleSpans: readonly RegExp[];
};

const LATIN_WEEKDAYS =
  "monday|tuesday|wednesday|thursday|friday|saturday|sunday";
const ENGLISH_TEMPORAL_NAMES = `today|tomorrow|tonight|${LATIN_WEEKDAYS}`;
const DIRECTIVE_GAP = "[^,.!?;:。！？；，、]*";

const POLICY_BY_LANGUAGE: Record<UiLanguage, LocalePolicy> = {
  en: {
    label: "English",
    explicitPhrases: [
      { value: "no due date", wordBounded: true },
      { value: "no deadline", wordBounded: true },
      { value: "without a deadline", wordBounded: true },
      { value: "no date", wordBounded: true },
      { value: "without a due date", wordBounded: true },
      { value: "without due date", wordBounded: true },
      { value: "no schedule", wordBounded: true },
      { value: "no scheduled time", wordBounded: true },
      { value: "no time needed", wordBounded: true },
      { value: "no required time", wordBounded: true },
      { value: "plain todo", wordBounded: true },
      { value: "plain task", wordBounded: true },
      { value: "general todo", wordBounded: true },
      { value: "general task", wordBounded: true },
      { value: "simple todo", wordBounded: true },
      { value: "simple task", wordBounded: true },
      { value: "regular todo", wordBounded: true },
      { value: "regular task", wordBounded: true },
      { value: "undated todo", wordBounded: true },
      { value: "undated task", wordBounded: true },
      { value: "unscheduled todo", wordBounded: true },
      { value: "unscheduled task", wordBounded: true },
      { value: "just a todo", wordBounded: true },
      { value: "just a task", wordBounded: true },
      { value: "someday", wordBounded: true },
    ],
    promptExample: "no due date / someday",
    negationBefore: [
      /\b(?:not|never)\s+(?:an?\s+)?$/u,
      new RegExp(
        `\\b(?:do not|don't|don’t|dont)\\s+(?:leave|make|save|add|create|keep)\\b${DIRECTIVE_GAP}$`,
        "u",
      ),
    ],
    negationAfter: [],
    scheduleMarkers: [
      new RegExp(
        `\\b(?:${ENGLISH_TEMPORAL_NAMES}|next\\s+(?:day|week|month|year|${LATIN_WEEKDAYS}))\\b`,
        "u",
      ),
      /\b(?:at|by|on)\s+\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?\b/u,
      /\b\d{1,2}(?::\d{2})\s*(?:a\.?m\.?|p\.?m\.?)?\b/u,
      /\b\d{1,2}\s*(?:a\.?m\.?|p\.?m\.?)\b/u,
      /\bin\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|a|an)\s+(?:minutes?|hours?|days?|weeks?|months?|years?)\b/u,
      /\b(?:at|by|before|after)\s+(?:the\s+)?(?:start|beginning|middle|end)\s+of\s+(?:the\s+|this\s+|next\s+)?(?:day|week|month|year)\b/u,
      /\b(?:before|after)\s+(?:the\s+)?(?:meeting|game|work|school|lunch|dinner|appointment|trip|flight|event)\b/u,
      new RegExp(
        `\\b(?:a|one|two|three|four|five|six|seven|eight|nine|ten|\\d+)\\s+(?:days?|weeks?|months?|years?)\\s+from\\s+(?:today|tomorrow|${LATIN_WEEKDAYS})\\b`,
        "u",
      ),
      /\b\d{4}-\d{2}-\d{2}\b/u,
      /\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/u,
    ],
    negatedScheduleSpans: [
      new RegExp(
        `\\b(?:not|never)\\s+(?:on\\s+)?(?:${ENGLISH_TEMPORAL_NAMES}|next\\s+(?:${LATIN_WEEKDAYS}|day|week|month|year))\\b`,
        "u",
      ),
    ],
  },
  es: {
    label: "Spanish",
    explicitPhrases: [
      { value: "sin fecha", wordBounded: true },
      { value: "sin plazo", wordBounded: true },
      { value: "sin horario", wordBounded: true },
    ],
    promptExample: "sin fecha",
    negationBefore: [
      new RegExp(
        `\\bno\\s+(?:lo\\s+)?(?:dejes?|dejar|hagas?|hacer|crees?|crear|guardes?|guardar)\\b${DIRECTIVE_GAP}$`,
        "u",
      ),
    ],
    negationAfter: [],
    scheduleMarkers: [
      /\b(?:hoy|mañana|esta noche|próxim[oa]\s+(?:día|semana|mes|año)|lunes|martes|miércoles|miercoles|jueves|viernes|sábado|sabado|domingo)\b/u,
      /\b(?:a las?|dentro de)\s+(?:\d+|un[oa]?|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)(?:\s+(?:minutos?|horas?|días?|semanas?|meses?|años?))?/u,
    ],
    negatedScheduleSpans: [
      /\b(?:no|nunca)\s+(?:el\s+)?(?:hoy|mañana|lunes|martes|miércoles|miercoles|jueves|viernes|sábado|sabado|domingo)\b/u,
    ],
  },
  pt: {
    label: "Portuguese",
    explicitPhrases: [
      { value: "sem data", wordBounded: true },
      { value: "sem prazo", wordBounded: true },
      { value: "sem horário", wordBounded: true },
      { value: "sem horario", wordBounded: true },
    ],
    promptExample: "sem prazo",
    negationBefore: [
      new RegExp(
        `\\b(?:não|nao)\\s+(?:o\\s+)?(?:deixe|deixar|faça|faca|fazer|crie|criar|guarde|guardar)\\b${DIRECTIVE_GAP}$`,
        "u",
      ),
    ],
    negationAfter: [],
    scheduleMarkers: [
      /(?<![\p{L}\p{N}_])(?:hoje|amanhã|amanha|esta noite|próxim[oa]\s+(?:dia|semana|mês|mes|ano)|segunda-feira|terça-feira|terca-feira|quarta-feira|quinta-feira|sexta-feira|sábado|sabado|domingo)(?![\p{L}\p{N}_])/u,
      /(?<![\p{L}\p{N}_])(?:às?|dentro de)\s+(?:\d+|um|uma|dois|duas|três|tres|quatro|cinco|seis|sete|oito|nove|dez)(?:\s+(?:minutos?|horas?|dias?|semanas?|meses?|anos?))?(?![\p{L}\p{N}_])/u,
    ],
    negatedScheduleSpans: [
      /(?<![\p{L}\p{N}_])(?:não|nao|nunca)\s+(?:na?|no)?\s*(?:hoje|amanhã|amanha|segunda-feira|terça-feira|terca-feira|quarta-feira|quinta-feira|sexta-feira|sábado|sabado|domingo)(?![\p{L}\p{N}_])/u,
    ],
  },
  "zh-CN": {
    label: "Chinese",
    explicitPhrases: [
      { value: "没有截止日期" },
      { value: "沒有截止日期" },
      { value: "无截止日期" },
      { value: "無截止日期" },
      { value: "没有到期日" },
      { value: "沒有到期日" },
      { value: "没有日期" },
      { value: "沒有日期" },
      { value: "没有时间" },
      { value: "沒有時間" },
      { value: "没有日程" },
      { value: "沒有日程" },
    ],
    promptExample: "没有截止日期",
    negationBefore: [new RegExp(`(?:不要|别|別)${DIRECTIVE_GAP}$`, "u")],
    negationAfter: [],
    scheduleMarkers: [
      /(?:今天|明天|今晚|周[一二三四五六日天]|星期[一二三四五六日天])/u,
      /(?:\d{1,2}|[一二三四五六七八九十]+)(?:点|點)/u,
      /(?:在|过|過)\s*(?:\d+|[一二三四五六七八九十]+)\s*(?:分钟|分鐘|小时|小時|天|周|週|个月|個月|年)(?:后|後)/u,
    ],
    negatedScheduleSpans: [
      /(?:不是|不要|别在|別在|不在)\s*(?:今天|明天|今晚|周[一二三四五六日天]|星期[一二三四五六日天])/u,
    ],
  },
  ja: {
    label: "Japanese",
    explicitPhrases: [
      { value: "期限なし" },
      { value: "期限はなし" },
      { value: "締め切りなし" },
      { value: "締め切りはなし" },
      { value: "日付なし" },
      { value: "日付はなし" },
      { value: "予定なし" },
      { value: "予定はなし" },
    ],
    promptExample: "期限なし",
    negationBefore: [],
    negationAfter: [/^\s*(?:には?|では?)?しないで/u],
    scheduleMarkers: [
      /(?:今日|明日|今夜|(?:月|火|水|木|金|土|日)曜日)/u,
      /(?:\d{1,2}|[一二三四五六七八九十]+)時/u,
      /(?:\d+|[一二三四五六七八九十]+)(?:分|時間|日|週間|か月|ヶ月|年)後/u,
    ],
    negatedScheduleSpans: [
      /(?:(?:月|火|水|木|金|土|日)曜日|今日|明日)(?:ではない|じゃない)/u,
    ],
  },
  ko: {
    label: "Korean",
    explicitPhrases: [
      { value: "마감일 없이" },
      { value: "날짜 없이" },
      { value: "일정 없이" },
    ],
    promptExample: "마감일 없이",
    negationBefore: [],
    negationAfter: [/^\s*(?:만들지|하지|두지)\s*마/u],
    scheduleMarkers: [
      /(?:오늘|내일|오늘 밤|(?:월|화|수|목|금|토|일)요일)/u,
      /(?:\d{1,2}|[일이삼사오육칠팔구십]+)시/u,
      /(?:\d+|[일이삼사오육칠팔구십]+)\s*(?:분|시간|일|주|개월|년)\s*후/u,
    ],
    negatedScheduleSpans: [
      /(?:(?:월|화|수|목|금|토|일)요일|오늘|내일)(?:이|가)?\s*아니/u,
    ],
  },
  vi: {
    label: "Vietnamese",
    explicitPhrases: [
      { value: "không có ngày đến hạn", wordBounded: true },
      { value: "khong co ngay den han", wordBounded: true },
      { value: "không ngày đến hạn", wordBounded: true },
      { value: "khong ngay den han", wordBounded: true },
      { value: "không có lịch", wordBounded: true },
      { value: "khong co lich", wordBounded: true },
    ],
    promptExample: "không có ngày đến hạn",
    negationBefore: [
      new RegExp(
        `(?:^|\\s)(?:đừng|dung)\\s+(?:để|de|làm|lam|tạo|tao)(?:\\s|$)${DIRECTIVE_GAP}$`,
        "u",
      ),
    ],
    negationAfter: [],
    scheduleMarkers: [
      /\b(?:hôm nay|hom nay|ngày mai|ngay mai|tối nay|toi nay|tuần tới|tuan toi|tháng tới|thang toi|năm tới|nam toi)\b/u,
      /\b(?:thứ|thu)\s+(?:hai|ba|tư|tu|năm|nam|sáu|sau|bảy|bay|chủ nhật|chu nhat)\b/u,
      /\b(?:lúc|luc)\s*\d{1,2}\s*(?:giờ|gio)\b/u,
      /\b(?:trong|sau)\s+(?:\d+|một|mot|hai|ba|bốn|bon|năm|nam|sáu|sau|bảy|bay|tám|tam|chín|chin|mười|muoi)\s+(?:phút|phut|giờ|gio|ngày|ngay|tuần|tuan|tháng|thang|năm|nam)\b/u,
    ],
    negatedScheduleSpans: [
      /\b(?:không|khong)\s+(?:phải|phai)\s+(?:(?:vào|vao)\s+)?(?:(?:thứ|thu)\s+(?:hai|ba|tư|tu|năm|nam|sáu|sau|bảy|bay|chủ nhật|chu nhat)|hôm nay|hom nay|ngày mai|ngay mai)\b/u,
    ],
  },
  tl: {
    label: "Tagalog",
    explicitPhrases: [
      { value: "walang takdang petsa", wordBounded: true },
      { value: "walang iskedyul", wordBounded: true },
    ],
    promptExample: "walang takdang petsa",
    negationBefore: [
      new RegExp(
        `\\b(?:huwag|wag)\\s+(?:gawing|ilagay|iwan|lumikha)\\b${DIRECTIVE_GAP}$`,
        "u",
      ),
    ],
    negationAfter: [],
    scheduleMarkers: [
      /\b(?:ngayon|bukas|mamayang gabi|sa susunod na\s+(?:araw|linggo|buwan|taon))\b/u,
      /\b(?:lunes|martes|miyerkules|huwebes|biyernes|sabado|linggo)\b/u,
      /\balas\s+\d{1,2}\b/u,
      /\bsa loob ng\s+(?:\d+|isa|dalawa|tatlo|apat|lima|anim|pito|walo|siyam|sampu)\s+(?:minuto|oras|araw|linggo|buwan|taon)\b/u,
    ],
    negatedScheduleSpans: [
      /\b(?:hindi|huwag|wag)\s+(?:sa\s+)?(?:ngayon|bukas|lunes|martes|miyerkules|huwebes|biyernes|sabado|linggo)\b/u,
    ],
  },
};

const LOCALE_POLICIES = UI_LANGUAGES.map(
  (language) => POLICY_BY_LANGUAGE[language],
);

function isWordCharacter(value: string | undefined): boolean {
  return value !== undefined && /[\p{L}\p{N}_]/u.test(value);
}

function phraseMatches(text: string, phrase: PhraseSpec): TextSpan[] {
  const needle = normalizeKeywordMatchText(phrase.value);
  const matches: TextSpan[] = [];
  let offset = 0;
  while (offset <= text.length - needle.length) {
    const start = text.indexOf(needle, offset);
    if (start < 0) break;
    const end = start + needle.length;
    if (
      phrase.wordBounded !== true ||
      (!isWordCharacter(text[start - 1]) && !isWordCharacter(text[end]))
    ) {
      matches.push({ start, end });
    }
    offset = start + Math.max(needle.length, 1);
  }
  return matches;
}

function patternSpans(text: string, pattern: RegExp): TextSpan[] {
  const flags = pattern.flags.includes("g")
    ? pattern.flags
    : `${pattern.flags}g`;
  const matcher = new RegExp(pattern.source, flags);
  return Array.from(text.matchAll(matcher), (match) => ({
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
  }));
}

function negatedDirective(
  text: string,
  positive: TextSpan,
  policy: LocalePolicy,
): UndatedDirective | null {
  const before = text.slice(0, positive.start);
  const prefix = policy.negationBefore
    .flatMap((pattern) => patternSpans(before, pattern))
    .filter((span) => span.end === before.length)
    .sort((left, right) => {
      const rightStart =
        typeof right.start === "number" && Number.isFinite(right.start)
          ? right.start
          : 0;
      const leftStart =
        typeof left.start === "number" && Number.isFinite(left.start)
          ? left.start
          : 0;
      return rightStart - leftStart || left.end - right.end;
    })[0];
  const after = text.slice(positive.end);
  const suffix = policy.negationAfter
    .flatMap((pattern) => patternSpans(after, pattern))
    .filter((span) => span.start === 0)
    .sort((left, right) => {
      const rightEnd =
        typeof right.end === "number" && Number.isFinite(right.end)
          ? right.end
          : 0;
      const leftEnd =
        typeof left.end === "number" && Number.isFinite(left.end)
          ? left.end
          : 0;
      return rightEnd - leftEnd || left.start - right.start;
    })[0];
  if (!prefix && !suffix) return null;
  return {
    kind: "deny",
    start: prefix?.start ?? positive.start,
    end: positive.end + (suffix?.end ?? 0),
  };
}

function orderedUndatedDirectives(text: string): UndatedDirective[] {
  const directives = LOCALE_POLICIES.flatMap((policy) =>
    policy.explicitPhrases.flatMap((phrase) =>
      phraseMatches(text, phrase).map(
        (positive) =>
          negatedDirective(text, positive, policy) ?? {
            ...positive,
            kind: "allow" as const,
          },
      ),
    ),
  );
  return directives.sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );
}

function maskSpans(text: string, spans: readonly TextSpan[]): string {
  if (spans.length === 0) return text;
  const characters = text.split("");
  for (const span of spans) {
    for (let index = span.start; index < span.end; index += 1) {
      characters[index] = " ";
    }
  }
  return characters.join("");
}

const TITLE_SCHEDULE_SPANS = [
  new RegExp(
    `\\b(?:call|name|title|label)\\s+(?:it|this|that|the\\s+(?:todo|task|item))?\\s*(?:as\\s+|called\\s+|titled\\s+)?["'“”‘’]?(?:${ENGLISH_TEMPORAL_NAMES}|daily|weekly|monthly|yearly)\\b`,
    "u",
  ),
  new RegExp(
    `\\b(?:called|named|titled|labelled|labeled)\\s+["'“”‘’]?(?:${ENGLISH_TEMPORAL_NAMES}|daily|weekly|monthly|yearly)\\b`,
    "u",
  ),
] as const;

function suffixStatesSchedule(text: string): boolean {
  const exceptionSpans = [
    ...TITLE_SCHEDULE_SPANS.flatMap((pattern) => patternSpans(text, pattern)),
    ...LOCALE_POLICIES.flatMap((policy) =>
      policy.negatedScheduleSpans.flatMap((pattern) =>
        patternSpans(text, pattern),
      ),
    ),
  ];
  const authoritative = maskSpans(text, exceptionSpans);
  if (textStatesExplicitRecurrence(authoritative)) return true;
  return LOCALE_POLICIES.some((policy) =>
    policy.scheduleMarkers.some(
      (pattern) => patternSpans(authoritative, pattern).length > 0,
    ),
  );
}

type UndatedTodoDirectiveState =
  | "absent"
  | "explicit"
  | "scheduled_after_explicit";

function undatedTodoDirectiveState(text: string): UndatedTodoDirectiveState {
  const normalized = normalizeKeywordMatchText(text);
  if (!normalized) return "absent";
  const directive = orderedUndatedDirectives(normalized).at(-1);
  if (!directive || directive.kind === "deny") return "absent";
  return suffixStatesSchedule(normalized.slice(directive.end))
    ? "scheduled_after_explicit"
    : "explicit";
}

/** True only when the owner's last no-date directive survives later schedule text. */
export function textStatesExplicitUndatedTodo(text: string): boolean {
  return undatedTodoDirectiveState(text) === "explicit";
}

/** True when a schedule after the final explicit no-date directive contradicts it. */
export function textContradictsExplicitUndatedTodo(text: string): boolean {
  return undatedTodoDirectiveState(text) === "scheduled_after_explicit";
}

const PROMPT_EXAMPLES = LOCALE_POLICIES.map(
  (policy) => `${policy.label}: ${policy.promptExample}`,
).join("; ");

/** Prompt contract derived from the same locale catalog used at the write boundary. */
export const UNDATED_TODO_EXTRACTION_GUIDANCE = [
  '  - "unscheduled" — ONLY when the user explicitly declines a date or schedule for this Todo.',
  `    Explicit examples by locale: ${PROMPT_EXAMPLES}.`,
  "    Interpret corrections in order: the last explicit no-date or negated no-date directive wins.",
  "    After the final no-date directive, any non-negated date, weekday, time, recurrence, or relative offset means the Todo is scheduled. A merely omitted date is not unscheduled.",
  "    Temporal words in the Todo title are not a schedule (for example, a title named Tomorrow followed by an explicit no-date request).",
].join("\n");
