/**
 * Streaming carry-over guard for the secret-swap / PII-pseudonymization layer
 * (#15256). When either guard is active, {@link ../runtime | AgentRuntime.useModel}
 * used to buffer the whole model stream and run the substitution pipeline once at
 * the end, emitting the entire reply as a single chunk — so a guarded turn had
 * TTFT equal to full generation time. This scanner restores incremental delivery:
 * each raw model chunk is appended to a small carry-over tail, an emit-safe prefix
 * is chosen, that prefix is run through the exact same pipeline the end-of-stream
 * flush used, and only the still-in-progress tail is held back.
 *
 * The safety contract the cut must uphold: a prefix may be emitted only when no
 * sensitive token and no in-progress detector match straddles the cut. A cut that
 * split a known secret value, a PII value/surrogate, a spaced credit card, a
 * BIP-39 mnemonic, a `KEY=`/JSON-field/`Bearer` assignment, or an open PEM/PGP
 * block would emit a raw fragment the buffered path would have masked. {@link
 * GuardedStreamScanner.findSafeCut} therefore holds back (a) a base window sized to
 * the longest known value/surrogate so a partial known value at the tail is never
 * emitted, and (b) any trailing region that matches an in-progress multi-token
 * secret/PII shape. Held text is released as soon as a following token proves the
 * shape complete, or at {@link GuardedStreamScanner.flush} (end of stream), whose
 * held-tail-drop-on-abort behaviour matches the old buffer exactly.
 *
 * Accepted semantic delta vs whole-buffer substitution: streaming cannot
 * retro-redact. A secret whose ONLY detectable form appears late in the reply
 * (e.g. a bare value that becomes detectable only once a later `API_KEY=` names
 * it) no longer cleans an earlier bare occurrence the way whole-buffer split/join
 * did, and a surrogate emitted before a parallel turn-call first learns it stays
 * unrestored on the visible side. This is inherent to any streaming guard; the
 * realistic paths are unaffected because known secrets (character settings) and
 * ingress-detected PII are always in the session before the stream starts.
 *
 * Pathological whitespace-free streams (multi-KB JWTs/URLs) and multi-KB known
 * secrets degrade to holding until a whitespace boundary or flush — i.e. to the
 * old full-buffer behaviour. Correctness over latency; there is no regression.
 */

import { BIP39_WORD_SET } from "./bip39-wordlist.js";
import type { PseudonymSession } from "./pii-pseudonymizer.js";
import type { SecretSwapSession } from "./secret-swap.js";

/** One increment of guarded output: provider-safe text and its user-visible form. */
export interface GuardedStreamOutput {
	/** Text safe to persist / send onward: secrets → placeholders, PII → surrogates. */
	safe: string;
	/** Text safe to show the user: PII surrogates restored to their real values. */
	visible: string;
}

export interface GuardedStreamScannerOptions {
	secretSession?: SecretSwapSession | null;
	piiSession?: PseudonymSession | null;
}

const NOTHING: GuardedStreamOutput = { safe: "", visible: "" };

/**
 * Openers that indicate an in-progress secret whose value has not fully arrived.
 * Each is anchored at end-of-input (`$`) and matched against the trailing window;
 * a match holds the cut back to the opener's start so the assignment/header and
 * its (possibly whitespace-containing) value are substituted together rather than
 * split across chunks. Supersets of the detector/redact patterns they mirror.
 */
const OPENER_PATTERNS: readonly RegExp[] = [
	// ENV-style assignment (NAME=… / NAME: …), value still arriving.
	/[A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|MNEMONIC|SEED|CREDENTIAL)\s*(?:[=:]\s*(?:["']?[^\s"'\\]*)?)?$/,
	// JSON credential field, still open: name seen, optionally `: `, optionally a
	// string value. Unlike the other openers the value can contain whitespace, so
	// the hold must persist past the closing quote — through any trailing
	// non-whitespace (`"}`, `",`) — and release only once whitespace follows. That
	// guarantees the whitespace-snapped cut lands after the whole `"key":"value"`
	// (so the buffer detector `"key"\s*:\s*"([^"]+)"` matches the emitted piece)
	// rather than inside a multi-word value.
	/"(?:apiKey|token|secret|password|passwd|accessToken|refreshToken|mnemonic|seedPhrase|passphrase|privateKey|credential)"\s*(?::\s*(?:"[^"]*(?:"[^\s]*)?)?)?$/i,
	// Authorization Bearer/Basic header, token still arriving.
	/(?:Authorization\s*[:=]\s*)?(?:Bearer|Basic)\s+[A-Za-z0-9._+/=-]*$/i,
	// `Authorization` anchor held through the ENTIRE streaming header, from before
	// the scheme discriminator arrives (`Authorization:`), across a partial scheme
	// (`Authorization: B`), and through the value (`Authorization: Basic <b64>`).
	// The `basic-auth-header` detector needs the `Authorization:` anchor to fire;
	// without this hold `snapToWhitespace` releases `"Authorization: "` the moment it
	// ends in a space — orphaning the later `"Basic <b64>"`, which has no anchor and
	// is emitted in the clear. The scheme is optional and the value charclass is
	// letter-inclusive, so a partial scheme is covered; a trailing whitespace ends
	// the value and releases the whole header contiguously for detection. (redact.ts
	// carries a standalone `\bBearer …` pattern, so Bearer survives without an
	// anchor; Basic has none — hence the anchored hold rather than a Basic pattern.)
	/\bAuthorization\s*[:=]?\s*(?:Bearer|Basic)?\s*[A-Za-z0-9._+/=-]*$/i,
	// CLI credential flag, value still arriving.
	/--(?:api[-_]?key|token|secret|password|passwd)(?:[=\s]+(?:["']?[^\s"']*)?)?$/i,
];

/** Safety bound on the grouped-number left-walk; hitting it holds everything (safe). */
const GROUPED_RUN_SCAN_LIMIT = 512;
/** Trailing window scanned for an in-progress opener before the long-value fallback. */
const OPENER_WINDOW = 512;
/** Longest suffix probed when detecting a partial `-----BEGIN` armor marker. */
const ARMOR_BEGIN = "-----BEGIN";

function isDigit(code: number): boolean {
	return code >= 48 && code <= 57;
}
function isAsciiAlpha(code: number): boolean {
	return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}
function isAlnum(code: number): boolean {
	return isDigit(code) || isAsciiAlpha(code);
}
function isAsciiWhitespace(code: number): boolean {
	return (
		code === 32 ||
		code === 9 ||
		code === 10 ||
		code === 13 ||
		code === 12 ||
		code === 11
	);
}
function isSpaceOrTab(code: number): boolean {
	return code === 32 || code === 9;
}
function isUpperAlnum(code: number): boolean {
	return isDigit(code) || (code >= 65 && code <= 90);
}
/** Card/SSN/IBAN group separators: single space, tab, or dash. */
function isGroupSeparator(code: number): boolean {
	return code === 32 || code === 9 || code === 45;
}

/**
 * Chunked, order-preserving replacement for the runtime's end-of-stream
 * `flushGuardedStream`. Constructed once per guarded turn; the same secret/PII
 * sessions are shared with the rest of the turn and may grow mid-stream (the
 * secret session learns new values as it substitutes each emitted prefix), so the
 * hold window is recomputed from live session state on every {@link push}.
 */
export class GuardedStreamScanner {
	private pending = "";
	private readonly secretSession: SecretSwapSession | null;
	private readonly piiSession: PseudonymSession | null;

	constructor(options: GuardedStreamScannerOptions) {
		this.secretSession = options.secretSession ?? null;
		this.piiSession = options.piiSession ?? null;
	}

	/** Append a raw model chunk; return the text newly cleared for delivery (may be empty). */
	push(chunk: string): GuardedStreamOutput {
		if (!chunk) return NOTHING;
		this.pending += chunk;
		const cut = this.findSafeCut();
		if (cut <= 0) return NOTHING;
		const raw = this.pending.slice(0, cut);
		this.pending = this.pending.slice(cut);
		return this.transform(raw);
	}

	/** End of stream: process and return the entire held tail, then reset. */
	flush(): GuardedStreamOutput {
		if (!this.pending) return NOTHING;
		const raw = this.pending;
		this.pending = "";
		return this.transform(raw);
	}

	/**
	 * The exact pipeline the buffered path ran: secret placeholders first, then PII
	 * surrogates for the safe side, with the PII surrogates restored for the
	 * user-visible side. Kept byte-identical so streamed and buffered turns produce
	 * the same reply text.
	 */
	private transform(raw: string): GuardedStreamOutput {
		let safe = raw;
		if (this.secretSession) safe = this.secretSession.substituteText(safe);
		if (this.piiSession) safe = this.piiSession.substituteText(safe);
		const visible = this.piiSession ? this.piiSession.restoreText(safe) : safe;
		return { safe, visible };
	}

	private maxTokenLength(): number {
		let max = 0;
		if (this.secretSession)
			max = Math.max(max, this.secretSession.maxTokenLength);
		if (this.piiSession) max = Math.max(max, this.piiSession.maxTokenLength);
		return max;
	}

	/**
	 * Every string that must not be split across the cut: known secret values and
	 * their placeholders, PII values and their surrogates. Read live because the
	 * secret session learns new values while substituting emitted prefixes.
	 */
	private tokenKeys(): string[] {
		const keys: string[] = [];
		if (this.secretSession) {
			for (const entry of this.secretSession.entries) {
				keys.push(entry.value, entry.placeholder);
			}
		}
		if (this.piiSession) {
			for (const entry of this.piiSession.entries) {
				keys.push(entry.value, entry.surrogate);
			}
		}
		return keys;
	}

	/**
	 * Largest index up to which `pending` may be emitted. Starts at a window sized
	 * to the longest known token, then moves left (only ever left) past any trailing
	 * in-progress sensitive shape, to a fixpoint. Returns 0 when nothing is safe yet.
	 */
	private findSafeCut(): number {
		const n = this.pending.length;
		if (n === 0) return 0;
		let cut = n - this.maxTokenLength();
		if (cut > n) cut = n;
		if (cut <= 0) return 0;

		for (let iterations = 0; iterations <= n + 2; iterations += 1) {
			let next = this.snapToWhitespace(cut);
			next = Math.min(next, this.groupedNumberRunStart(next));
			next = Math.min(next, this.phoneRunStart(next));
			next = Math.min(next, this.bip39RunStart(next));
			next = Math.min(next, this.openerTailStart(next));
			next = Math.min(next, this.openArmorStart(next));
			next = Math.min(next, this.knownTokenCrossingStart(next));
			next = this.snapToWhitespace(next);
			if (next >= cut) break;
			cut = next;
			if (cut <= 0) return 0;
		}
		return cut > 0 ? cut : 0;
	}

	/**
	 * Move the cut left until the character before it is whitespace (or 0). This
	 * makes the cut land exactly between tokens, so no whitespace-free token is
	 * split and the PII replacer's `(?<![A-Za-z0-9_])…(?![A-Za-z0-9_])` word
	 * boundaries stay exact at the emit edge.
	 */
	private snapToWhitespace(index: number): number {
		const p = this.pending;
		let i = Math.min(index, p.length);
		while (i > 0 && !isAsciiWhitespace(p.charCodeAt(i - 1))) i -= 1;
		return i;
	}

	/**
	 * Hold the trailing run of grouped tokens that could be a space/dash-separated
	 * card, SSN, or IBAN whose remaining groups are still in the tail. A group joins
	 * the run only if it carries a digit or is an uppercase 4-char IBAN body group
	 * ("NWBK") — so lowercase prose (even 4-letter-word prose) ends the run — and the
	 * run is held only when it contains at least one digit-bearing group. A lone
	 * in-progress leading group ("DE89 ", "4111 ") is enough to hold, since the rest
	 * of the number is still arriving. Walks to the true run start (never mid-token).
	 */
	private groupedNumberRunStart(cut: number): number {
		const p = this.pending;
		let i = cut;
		let groups = 0;
		let hasDigitGroup = false;
		let runStart = cut;
		for (;;) {
			// Step over exactly one group separator (present before every group except
			// possibly the boundary at `cut`, which snapToWhitespace already trimmed).
			let sepEnd = i;
			if (sepEnd > 0 && isGroupSeparator(p.charCodeAt(sepEnd - 1))) {
				sepEnd -= 1;
			} else if (i !== cut) {
				break;
			}
			let k = sepEnd;
			let len = 0;
			let digitInGroup = false;
			let upperAlnum = true;
			while (k > 0 && len < 8 && isAlnum(p.charCodeAt(k - 1))) {
				const code = p.charCodeAt(k - 1);
				if (isDigit(code)) digitInGroup = true;
				else if (!isUpperAlnum(code)) upperAlnum = false;
				k -= 1;
				len += 1;
			}
			if (len === 0) break;
			// A neighbouring alnum char means the group is longer than 8 → not a
			// card/IBAN group; stop before mis-holding a long token.
			if (k > 0 && isAlnum(p.charCodeAt(k - 1))) break;
			// Only digit-bearing or uppercase 4-char (IBAN body) groups continue a
			// grouped-number run; anything else ends it.
			if (!digitInGroup && !(len === 4 && upperAlnum)) break;
			groups += 1;
			if (digitInGroup) hasDigitGroup = true;
			runStart = k;
			i = k;
			if (cut - runStart > GROUPED_RUN_SCAN_LIMIT) return 0;
		}
		return groups >= 1 && hasDigitGroup ? runStart : cut;
	}

	/**
	 * Hold a trailing in-progress NANP phone number whose area code is
	 * parenthesised — the one whitespace-spanning phone shape
	 * {@link groupedNumberRunStart} misses, because the `)`/`(` around the area
	 * code are non-alnum and break its left-walk (leaking e.g. `"(555) "` before the
	 * local number `"123-4567"` arrives). Only a SPACE/TAB separator can fall on a
	 * chunk boundary (dash/dot never split a token, so `snapToWhitespace` already
	 * holds `123-4567`); this walks the space-separated `(\d{2,4})` area-code group
	 * plus any following digit groups, and — when a parenthesised group is present —
	 * pulls the hold left over an optional `+?1` / `+` dialing prefix so the whole
	 * number matches the buffered detector in one emitted piece. Runs with no
	 * parenthesised group are left to `groupedNumberRunStart` (no double-holding).
	 */
	private phoneRunStart(cut: number): number {
		const p = this.pending;
		let i = cut;
		let runStart = cut;
		let groups = 0;
		let hasParen = false;
		for (;;) {
			let sepEnd = i;
			if (sepEnd > 0 && isGroupSeparator(p.charCodeAt(sepEnd - 1))) {
				sepEnd -= 1;
			} else if (i !== cut) {
				break;
			}
			let k = sepEnd;
			let paren = false;
			// A parenthesised area-code group `(\d{2,4})` ending at `sepEnd`.
			if (k > 0 && p.charCodeAt(k - 1) === 41 /* ) */) {
				let j = k - 1;
				let digits = 0;
				while (j > 0 && isDigit(p.charCodeAt(j - 1)) && digits < 4) {
					j -= 1;
					digits += 1;
				}
				if (digits >= 2 && j > 0 && p.charCodeAt(j - 1) === 40 /* ( */) {
					k = j - 1;
					paren = true;
				}
			}
			if (!paren) {
				let j = sepEnd;
				let digits = 0;
				while (j > 0 && isDigit(p.charCodeAt(j - 1)) && digits < 7) {
					j -= 1;
					digits += 1;
				}
				if (digits === 0) break;
				// A neighbouring alnum char means a longer token, not a phone group.
				if (j > 0 && isAlnum(p.charCodeAt(j - 1))) break;
				k = j;
			}
			groups += 1;
			if (paren) hasParen = true;
			runStart = k;
			i = k;
			if (cut - runStart > GROUPED_RUN_SCAN_LIMIT) return cut;
		}
		if (groups === 0 || !hasParen) return cut;
		// Pull left over an optional `+?1` / `+` dialing prefix so the emitted span
		// begins where the buffered phone detector's match begins (byte equivalence).
		let s = runStart;
		while (s > 0 && isSpaceOrTab(p.charCodeAt(s - 1))) s -= 1;
		if (s > 0 && p.charCodeAt(s - 1) === 49 /* 1 */) {
			let t = s - 1;
			if (t > 0 && p.charCodeAt(t - 1) === 43 /* + */) t -= 1;
			if (t === 0 || !isAlnum(p.charCodeAt(t - 1))) runStart = t;
		} else if (s > 0 && p.charCodeAt(s - 1) === 43 /* + */) {
			runStart = s - 1;
		}
		return runStart;
	}

	/**
	 * If the words immediately before `cut` are all BIP-39 words, they could be the
	 * start of a mnemonic whose remaining words are still in the tail; hold from the
	 * run's start. Ordinary prose exits at the first non-wordlist word, so it is not
	 * wedged. Walks to the true run start (never mid-word).
	 */
	private bip39RunStart(cut: number): number {
		const p = this.pending;
		let i = cut;
		let runStart = cut;
		let sawWord = false;
		for (;;) {
			let j = i;
			while (j > 0 && isSpaceOrTab(p.charCodeAt(j - 1))) j -= 1;
			if (j === i && i !== cut) break;
			let k = j;
			while (k > 0 && isAsciiAlpha(p.charCodeAt(k - 1))) k -= 1;
			const wordLen = j - k;
			if (wordLen < 3 || wordLen > 8) break;
			if (k > 0 && isAlnum(p.charCodeAt(k - 1))) break;
			if (!BIP39_WORD_SET.has(p.slice(k, j).toLowerCase())) break;
			sawWord = true;
			runStart = k;
			i = k;
		}
		return sawWord ? runStart : cut;
	}

	/**
	 * If the prefix ending at `cut` ends with an in-progress secret opener (`KEY=`,
	 * JSON field, `Bearer`/`Basic`, CLI flag), hold from the opener start. The fast
	 * path scans the bounded suffix; the long-token fallback extends left from the
	 * current value token so a 512+ byte value cannot orphan its anchor before the
	 * detector sees the complete assignment/header/flag.
	 */
	private openerTailStart(cut: number): number {
		const p = this.pending;
		const end = Math.min(cut, p.length);
		const matchStart = (base: number): number => {
			const tail = p.slice(base, end);
			let start = end;
			for (const pattern of OPENER_PATTERNS) {
				const match = pattern.exec(tail);
				if (match) start = Math.min(start, base + match.index);
			}
			return start;
		};

		const base = Math.max(0, end - OPENER_WINDOW);
		const tailStart = matchStart(base);
		if (tailStart < end) return tailStart;

		let runStart = end;
		while (runStart > 0 && !isAsciiWhitespace(p.charCodeAt(runStart - 1))) {
			runStart -= 1;
		}
		if (runStart >= base) return end;

		const extendedBase = Math.max(0, runStart - OPENER_WINDOW);
		return matchStart(extendedBase);
	}

	/**
	 * Hold a PEM/PGP armor block whole — a streamed private key must never partially
	 * emit. The whole `-----BEGIN … -----END …-----` span is an unsplittable region:
	 * the buffer detector only matches the complete block, so a cut inside it would
	 * emit body bytes the buffered path masked. Treated like a straddled known token:
	 * if the tentative `cut` falls inside the block owning it, pull back to that
	 * block's `-----BEGIN`. The span end is the char after the END marker's closing
	 * dashes, or the whole tail while the block is still unclosed (so the growing
	 * body is held). Also holds a partial `-----BEGIN` marker forming at the tail so
	 * a later chunk cannot orphan it. `cut === beginIdx` needs no pull — the marker
	 * is already in the held tail.
	 */
	private openArmorStart(cut: number): number {
		const p = this.pending;
		const n = p.length;
		const beginIdx = p.lastIndexOf(ARMOR_BEGIN, Math.max(0, cut - 1));
		if (beginIdx !== -1 && beginIdx < cut) {
			const endIdx = p.indexOf("-----END", beginIdx);
			const closeDashIdx = endIdx === -1 ? -1 : p.indexOf("-----", endIdx + 8);
			// Unclosed: the whole growing tail is the block — hold all of it. Closed:
			// hold only while the cut still lands inside the completed block span.
			if (closeDashIdx === -1) return beginIdx;
			if (cut < closeDashIdx + 5) return beginIdx;
		}
		// Partial "-----BEGIN" prefix at the tail (e.g. "-----BEG", or a bare dash run
		// building toward it) — hold so a later chunk cannot orphan the marker.
		const maxLen = Math.min(ARMOR_BEGIN.length - 1, n);
		for (let len = maxLen; len >= 1; len -= 1) {
			if (p.endsWith(ARMOR_BEGIN.slice(0, len))) return n - len;
		}
		return n;
	}

	/**
	 * Move the cut left off any known token (secret value/placeholder, PII
	 * value/surrogate) that straddles it — the one case snapToWhitespace and the
	 * shape rules miss, because these keys can contain whitespace ("Dana Whitfield",
	 * a seed phrase, a PEM value). Iterates to a local fixpoint since moving the cut
	 * can expose another straddling key.
	 */
	private knownTokenCrossingStart(cut: number): number {
		const p = this.pending;
		const keys = this.tokenKeys();
		let result = cut;
		let moved = true;
		while (moved) {
			moved = false;
			for (const key of keys) {
				const len = key.length;
				if (len === 0) continue;
				const idx = p.lastIndexOf(key, result - 1);
				if (idx !== -1 && idx < result && result < idx + len) {
					result = idx;
					moved = true;
				}
			}
		}
		return result;
	}
}
