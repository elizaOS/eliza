/**
 * Detectors for replies that assert ungrounded state: an already-completed
 * scheduling/save side effect ("I've set…", "Done — your reminders are set")
 * and the read-side twin — an empty/absent tracked-work state ("your task
 * list is empty", "I don't have today's log"). Lives in a leaf module because
 * the Stage-1 response-handler evaluators (services/message.ts), the
 * planner-path REPLY action guard (features/basic-capabilities/actions/
 * reply.ts), and the planned-reply egress guard all consume it — importing
 * the full message service from an action would create an import cycle.
 *
 * Detection is split by grammatical certainty so that only ASSERTIONS
 * fire; consent-seeking offers, questions, and conditionals must pass
 * through untouched (a rewritten offer forces an unwanted planner run — the
 * user asked a question and got an action).
 */

// Perfective first-person claims ("I've set…", "I have scheduled…", "I just
// added…") carry an explicit completion auxiliary, so they read as reports in
// any sentence shape — including tag questions ("I've set it — anything
// else?"). Only a leading subordinator ("Once I've set…") turns one into a
// plan instead of a report. Adjacency keeps denials out: "I have not set"
// never matches.
const PERFECTIVE_SIDE_EFFECT_CLAIM_PATTERN =
	/\bi(?:['’]ve|\s+have|\s+just)\s+(?:(?:just|already|now)\s+)?(?:set|scheduled|created|added|saved|booked|logged|arranged)\b/gi;
// Bare simple-past claims ("I set a reminder for 9am."). "set" is the one
// verb here whose past tense equals its base form, so offers ("Should I
// set…?", "Before I set…") collide with reports on the raw pattern — this
// branch is additionally gated on the word preceding "I" and on the
// containing sentence not being a question.
const BARE_PAST_SIDE_EFFECT_CLAIM_PATTERN =
	/\bi\s+(?:set|scheduled|created|added|saved|booked|logged|arranged)\b/gi;
// State-of-the-world completion claims that need no first-person subject
// ("that's all set", "your reminders are set", "is now set up", "Done —").
// The "now" forms and the bare completion opener ("Saved!", "Done.") were
// added after a live fabricated reply — "Saved! ✅ Your book report plan is
// now set up as reminders" with zero tool calls — slipped through the
// first-person-only shapes (#16941). The bare "done —" branch is anchored to
// the start of the (trimmed) reply or of a sentence, so congratulations like
// "Well done — that's every task cleared." are not misread (#16987).
const STATE_SIDE_EFFECT_CLAIM_PATTERN =
	/\b(?:(?:it['’]s|it is|you['’]re|that['’]s)\s+all\s+set\b|remind(?:er)?s?\s+(?:are|is)\s+(?:set|saved|scheduled|in\s+place)\b|(?:is|are)\s+now\s+(?:set(?:\s+up)?|saved|scheduled|in\s+place)\b)|(?:^|[.!?]\s+)done\s*[—–-]|^\s*(?:saved|done)\s*[!.…✅🎉]/iu;
// A modal, interrogative auxiliary, or subordinator immediately before the
// matched "I" makes the clause an offer/question/condition ("Should I
// set…?", "Shall I set…?", "When I set…", "Once I've set…"), not a report of
// finished work.
const NON_ASSERTIVE_SIDE_EFFECT_LEAD_PATTERN =
	/\b(?:should|shall|can|could|may|might|would|will|do|does|did|must|if|unless|once|when|whenever|while|before|after|until|whether)\s+$/i;
// The claim must be ABOUT a schedulable/saved thing, not e.g. "I've set aside
// some thoughts". Vocabulary mirrors the scheduled-item nouns the LifeOps
// surfaces own.
const SIDE_EFFECT_SUBJECT_NOUN_PATTERN =
	/\b(?:remind(?:er)?s?|alarms?|schedul(?:e|ed|ing)|scheduled\s+(?:task|item)s?|tasks?|appointments?|calendar|routines?|habits?|goals?|todos?|to[- ]dos?|check[- ]?ins?|follow[- ]?ups?|set[- ]?up|setup|onboard(?:ing)?|first[- ]?run|settings|defaults|configur(?:ation|ed))\b/i;

// True when the sentence containing the match (scanning forward from the
// match) terminates in "?" — the shape of a consent-seeking offer or a
// clarifying question ("I set reminders in the morning usually — should I?").
// Full-width CJK punctuation ("？" / "。" / "！") participates so the
// multilingual tier gates offers like "设置好了吗？" the same way.
function sideEffectClaimSentenceIsQuestion(
	text: string,
	fromIndex: number,
): boolean {
	for (let i = fromIndex; i < text.length; i += 1) {
		const ch = text[i];
		if (ch === "?" || ch === "？") return true;
		if (ch === "." || ch === "!" || ch === "。" || ch === "！" || ch === "\n")
			return false;
	}
	return false;
}

/**
 * Multilingual completed-claim shapes for the locales the product ships
 * keyword translations for (packages/shared/src/i18n/keywords: es, ko, pt,
 * tl, vi, zh-CN). The send-boundary gates are receipt-based and therefore
 * language-independent whenever a mutation-capable action ran; this tier only
 * closes the zero-tool hole — a fabricated "¡Guardado!"/"已保存" with no tool
 * call — where wording is the ONLY available signal (#17027 AC7).
 *
 * Each rule keeps the English tier's precision discipline: a claim fires only
 * when (a) the text names a schedulable/saved subject noun, (b) a perfective
 * completion shape matches, (c) the immediately preceding words are not a
 * negation/subordination lead, and (d) the containing sentence is not a
 * question. Romance perfective participles ("creado"/"criei") cannot follow
 * modals or subjunctive offer forms ("¿Quieres que cree…?"), so the offer
 * false-positive class that plagued English "set" (#16966) is structurally
 * absent; the negation leads carry the denial cases ("no he creado…",
 * "hindi ko pa na-set…").
 */
interface LocaleSideEffectClaimRule {
	/** BCP-47-ish tag, for maintenance only. */
	readonly locale: string;
	/** Schedulable/saved subject nouns; gate before any claim pattern runs. */
	readonly nouns: RegExp;
	/** Perfective completed-side-effect shapes (global flags for matchAll). */
	readonly claims: readonly RegExp[];
	/** Prefix shapes that turn the match into a denial/hypothetical. */
	readonly negationLead?: RegExp;
}

const LOCALE_SIDE_EFFECT_CLAIM_RULES: readonly LocaleSideEffectClaimRule[] = [
	{
		locale: "es",
		nouns:
			/\b(?:recordatorios?|alarmas?|tareas?|citas?|calendario|rutinas?|hábitos?|habitos?|metas?|seguimientos?|pendientes?|horarios?)\b/i,
		claims: [
			// "He creado…", "Ya he guardado…", "Acabo de programar…"
			/\b(?:he|acabo\s+de)\s+(?:(?:ya|justo)\s+)?(?:cread[oa]|guardad[oa]|programad[oa]|agendad[oa]|configurad[oa]|añadid[oa]|anotad[oa]|registrad[oa]|programar|agendar|guardar|crear|configurar|añadir|anotar|registrar)\b/giu,
			// "Ya está guardado", "Tus recordatorios quedaron programados" — the
			// change-of-state shapes only. Plain "está agendada para el martes"
			// describes existing state (the English "is scheduled for Tuesday"
			// twin) and must pass through.
			/\b(?:ya\s+(?:está|están)|queda|quedan|quedó|quedaron)\s+(?:guardad[oa]s?|programad[oa]s?|agendad[oa]s?|configurad[oa]s?|cread[oa]s?|anotad[oa]s?)\b/giu,
		],
		negationLead: /\b(?:no|aún\s+no|todavía\s+no|nunca)\s+$/iu,
	},
	{
		locale: "pt",
		nouns:
			/\b(?:lembretes?|alarmes?|tarefas?|consultas?|compromissos?|calendário|calendario|rotinas?|hábitos?|habitos?|metas?|agendamentos?|pendências?|pendencias?|horários?|horarios?)\b/i,
		claims: [
			// "Criei…", "Já salvei…", "Acabei de agendar…"
			/\b(?:(?:eu\s+)?(?:já\s+)?(?:criei|salvei|guardei|agendei|programei|configurei|adicionei|anotei|registrei)|acabei\s+de\s+(?:criar|salvar|guardar|agendar|programar|configurar|adicionar|anotar|registrar))\b/giu,
			// "Já está salvo", "Seus lembretes ficaram agendados" — change-of-state
			// shapes only; plain "está agendada para terça" describes existing
			// state and must pass through.
			/\b(?:já\s+(?:está|estão)|ficou|ficaram)\s+(?:salv[oa]s?|guardad[oa]s?|agendad[oa]s?|programad[oa]s?|configurad[oa]s?|criad[oa]s?)\b/giu,
		],
		negationLead: /\b(?:não|nao|ainda\s+não|ainda\s+nao|nunca)\s+$/iu,
	},
	{
		locale: "ko",
		nouns: /(?:알림|리마인더|일정|할\s?일|습관|목표|예약|미리\s?알림|스케줄)/,
		claims: [
			// "알림 설정했어요", "일정을 저장해 뒀습니다", "예약해 놨어"
			/(?:저장|설정|예약|등록|추가|생성)(?:을|를)?\s*(?:해\s?뒀|해\s?놨|했)/g,
			// "일정 잡았어요"
			/일정(?:을|를)?\s*잡았/g,
		],
		negationLead: /(?:안|못)\s*$/,
	},
	{
		locale: "vi",
		nouns:
			/\b(?:lời\s+nhắc|nhắc\s+nhở|lịch(?:\s+hẹn)?|công\s+việc|thói\s+quen|mục\s+tiêu|báo\s+thức|cuộc\s+hẹn)\b/iu,
		claims: [
			// "Đã lưu…", "Mình đã đặt lịch…", "Đã tạo nhắc nhở…" — JS \b is
			// ASCII-only and never matches before "đ", so the left edge is
			// anchored on start-of-text/whitespace instead.
			/(?:^|\s)đã\s+(?:lưu|tạo|đặt(?:\s+lịch)?|lên\s+lịch|thêm|cài(?:\s+đặt)?|ghi(?:\s+lại)?|hẹn)\b/giu,
		],
		// "chưa"/"sẽ" shapes don't contain "đã"; guard the explicit denial "đã
		// không lưu" and hypothetical "nếu … đã".
		negationLead: /\b(?:không|chưa|nếu)\s*$/iu,
	},
	{
		locale: "tl",
		nouns:
			/\b(?:paalala|reminders?|iskedyul|schedules?|gawain|alarmas?|alarms?|layunin|appointments?|tasks?)\b/i,
		claims: [
			// "Na-set ko na ang reminder", "Nai-save ko na", "Ginawa ko na…"
			/\b(?:na[- ]?(?:set|save|schedule)|nai[- ]?(?:set|save|schedule)|ginawa|inilagay|idinagdag|itinakda|naitakda|nailagay)\s+ko\s+na\b/gi,
			// "Naka-schedule na ang paalala mo"
			/\bnaka[- ]?(?:set|save|schedule|iskedyul)\s+na\b/gi,
		],
		negationLead: /\b(?:hindi|di|wala)\s+[^.!?\n]{0,16}$/i,
	},
	{
		locale: "zh-CN",
		nouns: /(?:提醒|任务|日程|闹钟|习惯|目标|待办|日历|预约|打卡)/,
		claims: [
			// "已保存"/"已经为你创建了提醒"
			/已(?:经)?(?:为(?:你|您))?(?:帮(?:你|您))?(?:保存|创建|设置|安排|添加|记录|预约)/g,
			// "设置好了"/"保存好了"
			/(?:保存|创建|设置|安排|添加|记录|预约)好了/g,
		],
		negationLead: /(?:还没(?:有)?|没有|尚未|如果)\s*$/,
	},
];

/**
 * True when the reply asserts a completed scheduling/save side effect in one
 * of the shipped non-English locales. Same contract as the English tiers:
 * offers, questions, denials, and ordinary chat must pass through.
 */
function replyClaimsCompletedSideEffectMultilingual(text: string): boolean {
	for (const rule of LOCALE_SIDE_EFFECT_CLAIM_RULES) {
		if (!rule.nouns.test(text)) continue;
		for (const claim of rule.claims) {
			for (const match of text.matchAll(claim)) {
				const prefix = text.slice(0, match.index);
				if (rule.negationLead?.test(prefix)) continue;
				if (sideEffectClaimSentenceIsQuestion(text, match.index)) continue;
				return true;
			}
		}
	}
	return false;
}

/**
 * True when a reply ASSERTS that a scheduling/save side effect already
 * happened. When no tool has run in the turn any such assertion is
 * fabricated — the "not loaded must never read as zero" doctrine applied to
 * writes: "no tool ran" must never read as "done" (#16935; observed live: a
 * bill-reminder ask answered "Done — I've set two reminders" with zero tool
 * calls, plus invented "session-only" caveats). Consent-seeking offers,
 * questions, and conditionals ("Want me to set…?", "Should I set…?", "I could
 * set…") are NOT claims and must return false — rewriting them to "On it."
 * turns a question the user asked into an action they did not consent to.
 */
export function replyClaimsCompletedSideEffect(reply: string): boolean {
	const text = reply.trim();
	if (!text) return false;
	if (!SIDE_EFFECT_SUBJECT_NOUN_PATTERN.test(text)) {
		return replyClaimsCompletedSideEffectMultilingual(text);
	}
	if (STATE_SIDE_EFFECT_CLAIM_PATTERN.test(text)) return true;
	for (const match of text.matchAll(PERFECTIVE_SIDE_EFFECT_CLAIM_PATTERN)) {
		if (
			!NON_ASSERTIVE_SIDE_EFFECT_LEAD_PATTERN.test(text.slice(0, match.index))
		) {
			return true;
		}
	}
	for (const match of text.matchAll(BARE_PAST_SIDE_EFFECT_CLAIM_PATTERN)) {
		const prefix = text.slice(0, match.index);
		if (NON_ASSERTIVE_SIDE_EFFECT_LEAD_PATTERN.test(prefix)) continue;
		if (sideEffectClaimSentenceIsQuestion(text, match.index)) continue;
		return true;
	}
	// Mixed-language replies (Taglish "Na-set ko na ang reminder mo") satisfy
	// the English noun gate without matching any English claim shape, so the
	// multilingual tier gets the final look regardless of which gate admitted
	// the text.
	return replyClaimsCompletedSideEffectMultilingual(text);
}

// Read-side twin of the completed-side-effect patterns above: assertions that
// the user's TRACKED WORK is empty/absent ("your task list is empty", "no
// notes, tasks, or messages from earlier today", "I don't have today's log").
// On a path where no read tool ran, such a reply conflates "not loaded" with
// "zero" — the exact conflation the error doctrine bans on data paths. Each
// branch is anchored to tracked-work nouns so ordinary chat ("no messages from
// Bob in this thread") passes through; chat-recall stays owned by the
// visible-context-recall exception.
const EMPTY_TRACKED_STATE_CLAIM_PATTERNS: readonly RegExp[] = [
	// "your task list is empty", "the todo list looks clear"
	/\b(?:task|todo|to[- ]do|reminder|goal|habit)s?\s+list\s+(?:is|looks|seems|appears)\s+(?:empty|clear|blank)\b/gi,
	// "no notes, tasks, or messages from earlier today", "no tasks logged"
	/\b(?:no|zero)\s+(?:new\s+)?(?:notes?|tasks?|todos?|to[- ]dos?|reminders?|habits?|goals?|entries)\b[^.!?\n]*\b(?:today|tonight|this\s+morning|this\s+afternoon|this\s+evening|so\s+far|earlier|logged|recorded|saved|tracked|on\s+file)\b/gi,
	// "I don't have today's log (in front of me)", "I don't have your task list"
	/\bi\s+don['’]t\s+have\s+(?:today['’]s|your)\s+(?:log|notes?|list|tasks?|todos?)\b/gi,
	// "nothing logged today", "nothing was recorded this morning"
	/\bnothing\s+(?:is\s+|was\s+|got\s+)?(?:logged|recorded|written\s+down|saved|tracked)\b[^.!?\n]*\b(?:today|tonight|yesterday|this\s+(?:morning|afternoon|evening|week)|so\s+far)\b/gi,
	// "nothing on your list/schedule/plate"
	/\bnothing\s+(?:is\s+)?on\s+(?:your|the)\s+(?:list|schedule|plate|docket)\b/gi,
	// "your day is wide open", "your schedule looks clear"
	/\byour\s+(?:day|schedule|slate)\s+(?:is|looks|seems|appears)\s+(?:empty|clear|blank|free|wide\s+open)\b/gi,
];

// A subordinator opening the clause turns the match into a hypothetical ("If
// your task list is empty, we could…"), not a report of looked-up state.
const CONDITIONAL_EMPTY_CLAIM_LEAD_PATTERN =
	/\b(?:if|unless|when|whenever|once|whether|in\s+case)\b[^.!?\n]*$/i;

/**
 * True when a reply ASSERTS that the user's tracked work (tasks, todos,
 * reminders, habits, goals, notes, day log) is empty or unavailable. On a path
 * where no read tool ran, that assertion fabricates an empty day — "not loaded
 * must never read as zero" applied to READS (#17059; observed live: a recap ask
 * routed contexts=["simple"] and answered "I don't have today's log in front of
 * me — no notes, tasks, or messages from earlier today", run 729acaf2).
 * Questions and conditionals pass through: asking the user whether their list
 * is empty is not a claim about looked-up state.
 */
export function replyClaimsEmptyTrackedWorkState(reply: string): boolean {
	const text = reply.trim();
	if (!text) return false;
	for (const pattern of EMPTY_TRACKED_STATE_CLAIM_PATTERNS) {
		for (const match of text.matchAll(pattern)) {
			const prefix = text.slice(0, match.index);
			if (CONDITIONAL_EMPTY_CLAIM_LEAD_PATTERN.test(prefix)) continue;
			if (sideEffectClaimSentenceIsQuestion(text, match.index)) continue;
			return true;
		}
	}
	return false;
}
