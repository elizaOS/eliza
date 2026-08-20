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
 *
 * Coverage is tiered by locale: the English shapes below, plus per-locale
 * claim tiers for the shipped keyword locales (es, ko, pt, tl, vi, zh-CN).
 * Each locale tier gates on that locale's tracked-work nouns inside the
 * containing sentence, matches only perfective/completed verb shapes, and
 * excludes negation/subordination leads, second-person descriptions, and
 * question sentences — including full-width terminators and particle-final
 * questions (吗/吧/呢, -까요, …không) that carry no question mark. None of
 * these patterns use `\b`, which is ASCII-only and silently dead against
 * letters like the Vietnamese "nhắc nhở" — boundaries are Unicode
 * lookarounds instead (#17027 AC7).
 */

// Perfective first-person claims ("I've set…", "I have scheduled…", "I just
// added…") carry an explicit completion auxiliary, so they read as reports in
// any sentence shape — including tag questions ("I've set it — anything
// else?"). Only a leading subordinator ("Once I've set…") turns one into a
// plan instead of a report. Adjacency keeps denials out: "I have not set"
// never matches.
const PERFECTIVE_SIDE_EFFECT_CLAIM_PATTERN =
	/\bi(?:['’]ve|\s+have|\s+just)\s+(?:(?:just|already|now)\s+)?(?:set|scheduled|created|added|saved|booked|logged|arranged|updated|renamed|deleted|removed|cancell?ed)\b/gi;
// Bare simple-past claims ("I set a reminder for 9am."). "set" is the one
// verb here whose past tense equals its base form, so offers ("Should I
// set…?", "Before I set…") collide with reports on the raw pattern — this
// branch is additionally gated on the word preceding "I" and on the
// containing sentence not being a question.
const BARE_PAST_SIDE_EFFECT_CLAIM_PATTERN =
	/\bi\s+(?:set|scheduled|created|added|saved|booked|logged|arranged|updated|renamed|deleted|removed|cancell?ed)\b/gi;
// State-of-the-world completion claims that need no first-person subject
// ("that's all set", "your reminders are set", "is now set up", "Done —").
// The "now" forms and the bare completion opener ("Saved!", "Done.") were
// added after a live fabricated reply — "Saved! ✅ Your book report plan is
// now set up as reminders" with zero tool calls — slipped through the
// first-person-only shapes (#16941). The bare "done —" branch is anchored to
// the start of the (trimmed) reply or of a sentence, so congratulations like
// "Well done — that's every task cleared." are not misread (#16987).
const STATE_SIDE_EFFECT_CLAIM_PATTERN =
	/\b(?:(?:it['’]s|it is|you['’]re|that['’]s)\s+all\s+set\b|remind(?:er)?s?\s+(?:are|is)\s+(?:set|saved|scheduled|in\s+place)\b|(?:is|are)\s+now\s+(?:set(?:\s+up)?|saved|scheduled|in\s+place)\b)|(?:^|[.!?]\s+)done\s*[—–-]|^\s*(?:saved|done)\s*[!.…✅🎉]/giu;
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
	/\b(?:remind(?:er)?s?|alarms?|schedul(?:e|ed|ing)|scheduled\s+(?:task|item)s?|tasks?|appointments?|calendar|routines?|habits?|goals?|todos?|to[- ]dos?|notes?|check[- ]?ins?|follow[- ]?ups?|set[- ]?up|setup|onboard(?:ing)?|first[- ]?run|settings|defaults|configur(?:ation|ed))\b/i;

function sentenceContaining(text: string, index: number): string {
	let start = index;
	while (start > 0 && !/[.!?\n]/u.test(text[start - 1] ?? "")) {
		start -= 1;
	}
	let end = index;
	while (end < text.length && !/[.!?\n]/u.test(text[end] ?? "")) {
		end += 1;
	}
	return text.slice(start, end);
}

// A generic "done" sentence is exempt only when its complete grammar is a
// read/navigation acknowledgement. Keeping this full-sentence match narrow is
// important: a loose "contains a read verb and no known write verb" test lets
// an unlisted mutation hide beside the read (for example, "notes are visible
// and I archived the old ones").
const READ_NAVIGATION_ONLY_SENTENCE_PATTERN = new RegExp(
	String.raw`^[\s.!?…–—-]*done\b[\s:;,…–—-]*(?:` +
		String.raw`(?:showing|displaying|loading|opening|rendering|highlighting|pulled\s+up|brought\s+up)\s+` +
		String.raw`(?:the\s+|your\s+)?(?:\d+\s+)?(?:notes?|reminders?|tasks?|todos?|to[- ]dos?|goals?|habits?|appointments?|calendar|settings)(?:\s+view)?` +
		"|" +
		String.raw`(?:the\s+|your\s+)?(?:\d+\s+)?(?:notes?|reminders?|tasks?|todos?|to[- ]dos?|goals?|habits?|appointments?|calendar|settings)(?:\s+view)?\s+` +
		String.raw`(?:is|are)\s+(?:now\s+)?(?:loaded|visible|shown|displayed|open|rendered|onscreen|on\s+screen|in\s+view|pulled\s+up|brought\s+up|highlighted)` +
		String.raw`)[\s…✅🎉]*$`,
	"iu",
);
// A bare completion opener ("Done —", "Done!", "Done.") carries no verb of its
// own — only the rest of its sentence can. Match text that begins with "done"
// (after the leading sentence-boundary anchor the STATE pattern captures)
// identifies these generic openers so they are held to the read-verb exclusion
// below.
const GENERIC_COMPLETION_OPENER_PATTERN = /^[\s.!?…–—-]*done\b/i;

/**
 * Bare completion openers must name their tracked subject in the same
 * sentence. A later question such as "Done. What should we do with your
 * notes?" mentions notes but does not claim a note was saved; treating the
 * whole reply as one clause replaces a true UI-navigation acknowledgement
 * with the unrelated unverified-effect fallback.
 *
 * A generic "done" opener is additionally rejected when its sentence's only
 * predicate is a read/navigation verb: "Done — your notes are loaded/visible"
 * (and the quantified variants) surfaced tracked state rather than committing a
 * write, so it is not a mutation report (#22609). A committed-mutation verb in
 * the same sentence overrides that exclusion, and openers whose own match text
 * carries the write verb ("reminders are set", "Saved!") are unaffected.
 */
function stateSideEffectClaimHasLocalSubject(text: string): boolean {
	for (const match of text.matchAll(STATE_SIDE_EFFECT_CLAIM_PATTERN)) {
		const firstWordOffset = match[0].search(/[\p{L}\p{N}]/u);
		const claimIndex =
			(match.index ?? 0) + (firstWordOffset >= 0 ? firstWordOffset : 0);
		const sentence = sentenceContaining(text, claimIndex);
		if (!SIDE_EFFECT_SUBJECT_NOUN_PATTERN.test(sentence)) continue;
		if (
			GENERIC_COMPLETION_OPENER_PATTERN.test(match[0]) &&
			READ_NAVIGATION_ONLY_SENTENCE_PATTERN.test(sentence)
		) {
			continue;
		}
		return true;
	}
	return false;
}

// True when the sentence containing the match (scanning forward from the
// match) terminates in "?" — the shape of a consent-seeking offer or a
// clarifying question ("I set reminders in the morning usually — should I?").
function sideEffectClaimSentenceIsQuestion(
	text: string,
	fromIndex: number,
): boolean {
	for (let i = fromIndex; i < text.length; i += 1) {
		const ch = text[i];
		if (ch === "?") return true;
		if (ch === "." || ch === "!" || ch === "\n") return false;
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
// Subjectless past-participle openers — "Added todo: sand the shelf",
// "saved a note: the charger is in the drawer", "Deleted the reminder." The
// live fabrication shape the I-subject patterns miss: the model reports
// finished work headline-style with no pronoun (observed on the Discord
// group surface: "Added todo: sand the dc5 shelf (no deadline, general
// task)" shipped with ZERO tool calls). Anchored to a sentence start so
// ordinary mid-sentence past tense ("the note I added yesterday") passes;
// bare "set" is deliberately absent — "Set a reminder on your phone…" is a
// common advisory imperative, not a report.
const SUBJECTLESS_PAST_SIDE_EFFECT_CLAIM_PATTERN =
	/(?:^|[.!?]\s+)(?:added|created|saved|scheduled|booked|logged|deleted|removed|renamed|cancell?ed|arranged)\b/gi;

// Noun-first passive headline claims — "todo added: polish the lens",
// "note saved.", "reminder set: 9am" (live variant that evaded the verb-first
// shape above: the model leads with the record noun). Requires the terminal
// claim punctuation/colon so descriptive prose ("the todo added by you last
// week…") passes through.
const NOUN_FIRST_SIDE_EFFECT_CLAIM_PATTERN =
	/(?:^|[.!?]\s+)(?:todos?|to[- ]dos?|notes?|reminders?|alarms?|tasks?|events?|appointments?|goals?|habits?)\s+(?:added|created|saved|scheduled|booked|logged|deleted|removed|renamed|cancell?ed|set|updated)\s*(?::|[.!…]|$)/gi;

/**
 * One locale's fabricated-completion claim tier. `claims` are the
 * perfective/completed assertion shapes (global regexes); a match counts only
 * when the containing sentence also names a `subjectNoun`, is not a question
 * (terminator, embedded `? ？ ¿`, or `questionTail` particle), and the
 * sentence prefix before the match does not end in a `nonAssertiveLead`
 * (negation, subordination, second-person subject, or offer scaffolding).
 */
interface LocaleSideEffectClaimShapes {
	readonly locale: string;
	readonly subjectNoun: RegExp;
	readonly claims: readonly RegExp[];
	readonly nonAssertiveLead: RegExp;
	readonly questionTail?: RegExp;
}

// Sentence terminators across the shipped locales: ASCII plus the full-width
// CJK set. Commas (including 、，) deliberately do NOT split — the noun gate
// should see the whole clause chain ("好了，提醒已保存。").
const MULTILINGUAL_SENTENCE_TERMINATOR = /[.!?。！？\n]/u;

const LOCALE_SIDE_EFFECT_CLAIM_SHAPES: readonly LocaleSideEffectClaimShapes[] =
	[
		{
			locale: "es",
			subjectNoun:
				/(?<![\p{L}])(?:recordatorios?|alarmas?|tareas?|citas?|calendario|rutinas?|h[áa]bitos?|metas?|objetivos?|notas?|apuntes?|pendientes?|seguimientos?|agenda|eventos?)(?![\p{L}])/iu,
			claims: [
				// "he guardado", "ya he creado", "te he programado"
				/(?<![\p{L}])(?:ya\s+)?(?:he|hemos)\s+(?:cread|guardad|programad|añadid|agregad|configurad|actualizad|eliminad|borrad|cancelad|apuntad|anotad|registrad|agendad)o/giu,
				// "acabo de crear un recordatorio"
				/(?<![\p{L}])acab(?:o|amos)\s+de\s+(?:crear|guardar|programar|añadir|agregar|configurar|actualizar|eliminar|borrar|cancelar|apuntar|anotar|registrar|agendar)/giu,
				// First-person preterite is unambiguous by conjugation: "guardé", "programé"
				/(?<![\p{L}])(?:guardé|creé|programé|agregué|añadí|configuré|actualicé|eliminé|borré|cancelé|anoté|registré|agendé|apunté)(?![\p{L}])/giu,
				// "tu recordatorio está programado", "queda guardado". Vague
				// readiness ("quedó listo", like English "is ready") is left to
				// the model's semantic replyEffectStatus classification.
				/(?<![\p{L}])(?:est[áa]n?|queda(?:n|ron)?|qued[óo])\s+(?:ya\s+)?(?:guardad|programad|cread|configurad|agendad|anotad|registrad)[oa]s?(?![\p{L}])/giu,
				// Participle-first openers: "Listo —", "Guardado."
				/(?:^|[.!?。！？\n]\s*)(?:listo|hecho|guardado|creado|agendado|programado|añadido|agregado)\s*[.!…—–:-]/giu,
			],
			nonAssertiveLead:
				/(?:(?<![\p{L}])(?:no|nunca|jamás|todav[íi]a\s+no|a[úu]n\s+no)\s+(?:(?:lo|la|los|las|le|les|te|me|se)\s+)?|(?:^|[,;—–-]\s*)(?:si|cuando|una\s+vez\s+que|en\s+cuanto|apenas|antes\s+de\s+que|mientras)\s+[^.!?\n]*)$/iu,
		},
		{
			locale: "pt",
			subjectNoun:
				/(?<![\p{L}])(?:lembretes?|alarmes?|tarefas?|compromissos?|agenda|calend[áa]rio|rotinas?|h[áa]bitos?|metas?|objetivos?|notas?|anota[çc](?:[ãa]o|[õo]es)|pend[êe]ncias?|eventos?)(?![\p{L}])/iu,
			claims: [
				// First-person preterite: "criei", "já salvei", "agendei"
				/(?<![\p{L}])(?:j[áa]\s+)?(?:criei|salvei|guardei|agendei|adicionei|configurei|atualizei|apaguei|removi|cancelei|registrei|anotei|marquei)(?![\p{L}])/giu,
				// "acabei de criar o lembrete"
				/(?<![\p{L}])acabei\s+de\s+(?:criar|salvar|guardar|agendar|adicionar|configurar|atualizar|apagar|remover|cancelar|registrar|anotar|marcar)/giu,
				// "seu lembrete está salvo", "ficou agendado", "foi criado"
				/(?<![\p{L}])(?:est[áa]|est[ãa]o|ficou|ficaram|foi|foram)\s+(?:j[áa]\s+)?(?:salv|guardad|agendad|criad|configurad|registrad|anotad|marcad|atualizad)[oa]s?(?![\p{L}])/giu,
				// "Pronto —", "Feito.", "Salvo!"
				/(?:^|[.!?。！？\n]\s*)(?:pronto|feito|salvo|criado|agendado|adicionado)\s*[.!…—–:-]/giu,
			],
			nonAssertiveLead:
				/(?:(?<![\p{L}])(?:n[ãa]o|nunca|jamais|ainda\s+n[ãa]o)\s+(?:(?:o|a|os|as|lhe|lhes|te|me|se)\s+)?|(?:^|[,;—–-]\s*)(?:se|quando|assim\s+que|antes\s+de|depois\s+que|caso)\s+[^.!?\n]*)$/iu,
		},
		{
			locale: "ko",
			subjectNoun:
				/(?:알림|리마인더|일정|할\s?일|습관|목표|메모|노트|루틴|캘린더|미리\s?알림|예약|과제|체크인)/u,
			claims: [
				// "저장했어요", "알림을 설정했습니다", "등록해 뒀어요", "저장되었습니다".
				// Adjacency is the negation guard: "저장 안 했어요" and future
				// volitionals ("저장할게요") never form 저장했/저장됐.
				/(?:저장|설정|추가|등록|예약|생성|기록|변경|수정|삭제|취소)(?:을|를)?\s*(?:완료했|했|해\s?두었|해\s?뒀|해\s?놓았|해\s?놨|되었|됐)/gu,
				// Headline noun form: "저장 완료!"
				/(?:저장|설정|추가|등록|예약|생성|기록)\s*완료/gu,
			],
			nonAssertiveLead: /(?:안|못)\s*$/u,
			questionTail: /(?:까요|나요|가요|을까)$/u,
		},
		{
			locale: "tl",
			subjectNoun:
				/(?<![\p{L}])(?:paalala|alarma|gawain|iskedyul|tala|layunin|rutina|kalendaryo|appointment|tasks?|reminders?|notes?|habits?|goals?|todos?)(?![\p{L}])/iu,
			claims: [
				// Completed-aspect verb forms: "Naitakda ko na", "Nai-save",
				// "nakatakda na ang paalala". A following second-person/third-person
				// pronoun ("Na-save mo…") describes the USER's action, not the
				// agent's, and is excluded. Contemplated-aspect forms (reduplicated
				// "Ise-save", "Itatakda") are deliberately absent.
				/(?<![\p{L}-])(?:naitakda|naidagdag|nailagay|naitala|itinakda|idinagdag|inilagay|kinansela|tinanggal|inalis|nai-?saved?|na-?saved?|na-?set|naka-?set|nakatakda|na-?i?-?scheduled?|in-?updated?)(?![\p{L}])(?!\s+(?:mo|niya|nila|ninyo)(?![\p{L}]))/giu,
				/(?<![\p{L}])ginawa\s+ko\s+na(?![\p{L}])/giu,
			],
			nonAssertiveLead:
				/(?:(?<![\p{L}])(?:hindi|di)(?:\s+ko)?(?:\s+pa)?\s+|(?:^|[,;]\s*)(?:kung|kapag|bago|pagkatapos|para)\s+[^.!?\n]*)$/iu,
			questionTail: /\sba$/iu,
		},
		{
			locale: "vi",
			subjectNoun:
				/(?:lời\s+nhắc|nhắc\s+nhở|báo\s+thức|công\s+việc|lịch\s+hẹn|lịch|ghi\s+chú|thói\s+quen|mục\s+tiêu|việc\s+cần\s+làm|nhiệm\s+vụ|sự\s+kiện|cuộc\s+hẹn)/iu,
			claims: [
				// Perfective "đã/vừa" + verb: "Mình đã đặt lời nhắc", "đã được lưu",
				// "đã giúp bạn tạo nhắc nhở"
				/(?:đã|vừa(?:\s+mới)?)\s+(?:được\s+|giúp\s+bạn\s+)?(?:đặt|lưu|tạo|thêm|lên\s+lịch|đặt\s+lịch|ghi(?:\s+lại)?|xóa|xoá|hủy|huỷ|cập\s+nhật|sửa|chỉnh)/giu,
				// verb + "xong (rồi)": "lưu xong rồi"
				/(?:đặt|lưu|tạo|thêm|ghi|xóa|xoá|hủy|huỷ|cập\s+nhật)\s+xong(?:\s+rồi)?/giu,
				// "Xong rồi —" opener (noun gate still applies to the sentence)
				/(?:^|[.!?。！？\n]\s*)(?:xong\s+rồi|đã\s+xong)\s*[.!…—–,:-]/giu,
			],
			// "chưa/không" negate; "sẽ/định/sắp" are future intent; a directly
			// preceding second-person pronoun describes the user's own action.
			nonAssertiveLead:
				/(?:(?:chưa|không|sẽ|định|sắp|muốn|nên|hãy|bạn|anh|chị|em|cậu)\s+|(?:^|[,;]\s*)(?:nếu|khi|trước\s+khi|giả\s+sử)\s+[^.!?\n]*)$/iu,
			questionTail: /(?:không|chưa|hả|à|phải\s+không)$/iu,
		},
		{
			locale: "zh-CN",
			subjectNoun:
				/(?:提醒|闹钟|任务|日程|待办|备忘|笔记|习惯|目标|日历|打卡|事项|清单|例行)/u,
			claims: [
				// Perfective 了: "设置好了", "保存了", "已经…添加完了"
				/(?:设置|设定|保存|创建|添加|新建|安排|预约|记录|删除|取消|更新|修改)(?:好|完)?了/gu,
				// Perfective 已/已经 (covers passives: "提醒已保存")
				/已经?(?:为你|帮你|给你|被)?(?:设置|设定|保存|创建|添加|新建|安排|预约|记录|删除|取消|更新|修改)/gu,
			],
			// Negation/modality directly before the verb phrase; a sentence whose
			// subject is 你/您 with no 我 describes the USER's action ("你已经把提醒
			// 设置好了"), not the agent's — the tempered [^我] scan keeps "你好，我已
			// 经…" assertive.
			nonAssertiveLead:
				/(?:(?:没|没有|还没|尚未|未|不会|无法|不能|别|不用|无需)\s*|^(?:你|您)(?:(?!我)[^。！？!?\n])*|(?:^|[，,；;]\s*)(?:如果|要是|假如|万一|一旦)(?:(?!。)[^。！？!?\n])*)$/u,
			questionTail: /(?:吗|吧|呢|么)$/u,
		},
	];

function localeClauseAround(
	text: string,
	index: number,
): { sentence: string; start: number; terminator: string } {
	let start = index;
	while (
		start > 0 &&
		!MULTILINGUAL_SENTENCE_TERMINATOR.test(text[start - 1] ?? "")
	) {
		start -= 1;
	}
	let end = index;
	while (
		end < text.length &&
		!MULTILINGUAL_SENTENCE_TERMINATOR.test(text[end] ?? "")
	) {
		end += 1;
	}
	return {
		sentence: text.slice(start, end),
		start,
		terminator: text[end] ?? "",
	};
}

function localeReplyClaimsCompletedSideEffect(text: string): boolean {
	for (const shapes of LOCALE_SIDE_EFFECT_CLAIM_SHAPES) {
		if (!shapes.subjectNoun.test(text)) continue;
		for (const claim of shapes.claims) {
			for (const match of text.matchAll(claim)) {
				const firstWordOffset = match[0].search(/[\p{L}\p{N}]/u);
				const claimIndex =
					(match.index ?? 0) + (firstWordOffset >= 0 ? firstWordOffset : 0);
				const { sentence, start, terminator } = localeClauseAround(
					text,
					claimIndex,
				);
				if (!shapes.subjectNoun.test(sentence)) continue;
				if (terminator === "?" || terminator === "？") continue;
				if (/[?？¿]/u.test(sentence)) continue;
				if (shapes.questionTail?.test(sentence.trim())) continue;
				if (shapes.nonAssertiveLead.test(text.slice(start, claimIndex))) {
					continue;
				}
				return true;
			}
		}
	}
	return false;
}

export function replyClaimsCompletedSideEffect(reply: string): boolean {
	const text = reply.trim();
	if (!text) return false;
	if (!SIDE_EFFECT_SUBJECT_NOUN_PATTERN.test(text)) {
		return localeReplyClaimsCompletedSideEffect(text);
	}
	if (stateSideEffectClaimHasLocalSubject(text)) return true;
	for (const match of text.matchAll(
		SUBJECTLESS_PAST_SIDE_EFFECT_CLAIM_PATTERN,
	)) {
		if (sideEffectClaimSentenceIsQuestion(text, match.index)) continue;
		return true;
	}
	for (const match of text.matchAll(NOUN_FIRST_SIDE_EFFECT_CLAIM_PATTERN)) {
		if (sideEffectClaimSentenceIsQuestion(text, match.index)) continue;
		return true;
	}
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
	// English nouns can co-occur with non-English claim grammar (loanword
	// nouns in Tagalog, code-switched replies) — always try the locale tiers.
	return localeReplyClaimsCompletedSideEffect(text);
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
