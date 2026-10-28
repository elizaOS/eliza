import { NativeHostError } from "./errors.mjs";

const DIGIT_WORDS = {
  zero: "0",
  oh: "0",
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
};
const DIGIT_WORD = Object.keys(DIGIT_WORDS).join("|");
const SPOKEN_DIGITS = new RegExp(
  `\\b(?:${DIGIT_WORD})(?:[\\s,.-]+(?:${DIGIT_WORD})){3,}\\b`,
  "gi",
);
/** Speech recognition writes "one two three four" or "1 2 3 4" for a spoken code. */
const spokenDigits = (text) =>
  text.replace(SPOKEN_DIGITS, (run) =>
    run
      .split(/[\s,.-]+/)
      .map((word) => DIGIT_WORDS[word.toLowerCase()])
      .join(""),
  );
const normalize = (value) => {
  // A non-string would be checked as "[object Object]" and let its secret pass.
  if (typeof value !== "string")
    throw new NativeHostError("Text to check must be a string.", {
      status: 400,
      code: "INVALID_TEXT",
    });
  return value.normalize("NFKC").replace(/[\u200B-\u200D\uFEFF]/g, "");
};

/** The words shown when text is refused. They never include the matched value. */
export const SENSITIVE_TEXT_REFUSAL =
  "This looks like a password, verification code, token or card number. It was not sent. Remove it from your draft and enter it directly in the website or password manager.";
const refusal = () =>
  new NativeHostError(SENSITIVE_TEXT_REFUSAL, {
    status: 422,
    code: "SENSITIVE_TEXT",
  });

/** Luhn checksum of a 13 to 19 digit card number. A run of one repeated digit is not a card. */
export function luhn(digits) {
  if (!/^\d{13,19}$/.test(digits) || /^(\d)\1+$/.test(digits)) return false;
  let sum = 0;
  for (
    let i = digits.length - 1, alternate = false;
    i >= 0;
    i--, alternate = !alternate
  ) {
    let n = Number(digits[i]);
    if (alternate) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return sum % 10 === 0;
}

/**
 * An extra matcher lets a host refuse and remove its own kinds of values (for
 * example ID or bank numbers). `spans(text)` returns the [start, end) ranges
 * of the values in normalized text. `test(text)` is optional; without it, the
 * text is refused when `spans` finds a value in it, also after spoken digit
 * words are written as digits.
 * @typedef {{ spans(text: string): Iterable<[number, number]>, test?(text: string): boolean }} SensitiveTextMatcher
 */
const matcherFinds = (matcher, text) =>
  matcher.test
    ? matcher.test(text)
    : [...matcher.spans(text)].length > 0 ||
      (spokenDigits(text) !== text &&
        [...matcher.spans(spokenDigits(text))].length > 0);

/** Conservative recognition, not a promise to identify every possible secret.
 * Reject the whole input rather than silently changing a user's instructions.
 * Never include the matched value in an error or a log.
 */
export function containsSensitiveText(value, { matchers = [] } = {}) {
  const normalized = normalize(value);
  const spoken = spokenDigits(normalized);
  return (
    sensitive(normalized) ||
    (spoken !== normalized && sensitive(spoken)) ||
    matchers.some((matcher) => matcherFinds(matcher, normalized))
  );
}
function sensitive(text) {
  if (
    /\b(?:csk-|sk-(?:proj-|live-)?|gh[pousr]_|github_pat_|AIza)[A-Za-z0-9_-]{16,}\b/.test(
      text,
    )
  )
    return true;
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text))
    return true;
  if (/\bBearer\s+[A-Za-z0-9._~+/-]{12,}/i.test(text)) return true;
  if (/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/.test(text))
    return true;
  if (
    /\b(?:password|passphrase|api[ _-]?key|access[ _-]?token|refresh[ _-]?token|client[ _-]?secret)\s*(?:is\s+|=\s*|:\s*)\S+/i.test(
      text,
    )
  )
    return true;
  if (
    /\b(?:verification|security|one[ -]?time|confirmation|login|sign[ -]?in|authentication)\s+(?:code|pin)\s*(?:(?:is|was)\s*|[:=]\s*)?\d(?:[\s-]?\d){3,9}\b/i.test(
      text,
    )
  )
    return true;
  if (/\b(?:otp|pin|cvv|cvc)\s*(?:is\s+|[:=]\s*)\d{3,10}\b/i.test(text))
    return true;
  // "my code is 4 8 2 9 1 7", "the code they sent is 482917" and
  // "482917 is the code". A zip, postal or area code is not a secret, and
  // neither is an amount ("the code costs 1250.75").
  if (
    /(?<!\b(?:zip|postal|post|area|country|dialing)\s+)\b(?:pass)?code\b(?:\s+[a-z']+){0,4}?\s*(?:[:=]\s*)?\d(?:[\s-]?\d){3,7}(?![.,]?\d)/i.test(
      text,
    ) ||
    /(?<!\d|\d[.,])\d(?:[\s-]?\d){3,7}\s+(?:is|was)\s+(?:the|my|your|our)\s+(?:(?!(?:zip|postal|post|area|country|dialing)\b)[a-z]+\s+){0,2}?(?:pass)?code\b/i.test(
      text,
    )
  )
    return true;
  // Bare short codes are commonly pasted from verification messages.
  // Speech recognition may space the digits ("1 2 3 4"). Amounts such as
  // "12.50" or "1,000", a phone number such as "555-1234" and a time such
  // as "10 30" are not codes.
  const bare = text.trim().replace(/[.!?]$/, "");
  if (/^\d{4,8}$/.test(bare) || /^\d(?: \d){3,7}$/.test(bare)) return true;
  if (
    /^\d{2,}(?:[ -]\d{2,})+$/.test(bare) &&
    bare.replace(/\D/g, "").length >= 6 &&
    bare.replace(/\D/g, "").length <= 8 &&
    !/^\d{3}[ -]\d{4}$/.test(bare)
  )
    return true;
  for (const candidate of text.matchAll(/(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g))
    if (luhn(candidate[0].replace(/\D/g, ""))) return true;
  return false;
}

export function requireNonSensitiveText(text, options) {
  if (containsSensitiveText(text, options)) throw refusal();
}

// Removing a detected secret from text that is kept.
//
// The check above rejects text that looks like a secret. Rejection is not
// enough for text that a host already keeps: a transcript, the conversation
// history and a diagnostic log keep the words. A secret scrubber removes a
// detected secret from text and remembers it, so the same value is removed
// again from later text, also where it has no telling words around it
// ("use 482917 like before").
//
// Limits: detection is the same conservative recognition as the check above.
// The scrubber keeps keyed in-memory fingerprints, never the values, and never
// returns or logs a value. A short code can still be found from a fingerprint
// by trying every code, so a host must never store the fingerprints.
// No Node imports: hosts also load this in a renderer.

/** Replaces each removed value. */
export const SECRET_REMOVED_MARK = "[removed]";
/** One digit, typed ("4") or as speech recognition writes it ("four"). */
const D = `(?:\\d|\\b(?:${DIGIT_WORD})\\b)`;
/**
 * Between digits: nothing, a space or dash, or a comma or dot followed by a
 * space or dash ("4 8-2, 9"). A comma or dot right before the next digit is
 * an amount ("12.50", "1,250"), not a code, so it ends the run.
 */
const S = "(?:[\\s-]{0,3}|[,.][\\s-]{1,3})";
const digitRun = (min, max) => `${D}(?:${S}${D}){${min - 1},${max - 1}}`;
const DIGIT_OR_WORD = new RegExp(`\\d|\\b(?:${DIGIT_WORD})\\b`, "gi");
const digitsOf = (text) =>
  (String(text).match(DIGIT_OR_WORD) || [])
    .map((part) => (/\d/.test(part) ? part : DIGIT_WORDS[part.toLowerCase()]))
    .join("");

/**
 * The value after "password is" up to the end of its clause. Punctuation
 * inside a value ("Correct-Horse!9", "abc.def") is part of it; punctuation
 * followed by a space or the end of the text ends the clause.
 */
const CLAUSE = "(?:[^\\n.!?;,]|[.!?;,](?![\\s.!?;,]|$))+";
/**
 * Where a value follows (or comes before) its telling words. Each rule keeps
 * the words that say what it is ("my verification code is") and removes only
 * the value. `kind` says how the value is remembered: digits, a phrase, or
 * the first word of a clause only (`password`, `clause`).
 */
const RULES = [
  {
    pattern:
      /\b(?:csk-|sk-(?:proj-|live-)?|gh[pousr]_|github_pat_|AIza)[A-Za-z0-9_-]{16,}\b/g,
    kind: "phrase",
  },
  {
    pattern:
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|$)/g,
    kind: null,
  },
  { pattern: /\b(Bearer\s+)([A-Za-z0-9._~+/-]{12,}=*)/gi, kind: "phrase" },
  {
    pattern: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
    kind: "phrase",
  },
  // "my password is not working" names no password: only the word right after
  // "password is" is remembered, and only when it looks like a credential.
  // The clause is still removed.
  {
    pattern: new RegExp(
      `\\b(password\\s*(?:is\\s+|=\\s*|:\\s*))(${CLAUSE})`,
      "gi",
    ),
    kind: "password",
  },
  {
    pattern: new RegExp(
      `\\b((?:passphrase|pass phrase|api[ _-]?key|access[ _-]?token|refresh[ _-]?token|client[ _-]?secret)\\s*(?:is\\s+|=\\s*|:\\s*))(${CLAUSE})`,
      "gi",
    ),
    kind: "clause",
  },
  {
    pattern: new RegExp(
      `\\b((?:verification|security|one[ -]?time|confirmation|login|sign[ -]?in|authentication)\\s+(?:code|pin)\\s*(?:(?:is|was)\\s*|[:=]\\s*)?)(${digitRun(4, 10)})`,
      "gi",
    ),
    kind: "digits",
  },
  {
    pattern: new RegExp(
      `\\b((?:otp|pin|cvv|cvc)\\s*(?:is\\s+|[:=]\\s*))(${digitRun(3, 10)})`,
      "gi",
    ),
    kind: "digits",
  },
  // "my code is 4 8 2 9 1 7". A zip, postal or area code is not a secret,
  // and neither is an amount ("the code costs 1250.75").
  {
    pattern: new RegExp(
      `(?<!\\b(?:zip|postal|post|area|country|dialing)\\s+)\\b((?:pass)?code\\b(?:\\s+[a-z']+){0,4}?\\s*(?:[:=]\\s*)?)(${digitRun(4, 8)})(?![.,]?\\d)`,
      "gi",
    ),
    kind: "digits",
  },
  // "482917 is the code". "90210 is my zip code" is not a secret.
  {
    pattern: new RegExp(
      `(?<!\\d|\\d[.,])(${digitRun(4, 8)})(\\s+(?:is|was)\\s+(?:the|my|your|our)\\s+(?:(?!(?:zip|postal|post|area|country|dialing)\\b)[a-z]+\\s+){0,2}?(?:pass)?code\\b)`,
      "gi",
    ),
    kind: "digits",
    valueFirst: true,
  },
];
const CARD = new RegExp(`(?<!\\d)${digitRun(13, 19)}(?!\\d)`, "gi");
/**
 * A run of digits where a remembered value can come back without telling
 * words. An amount is never part of a run: "$41.11", "48.29" and "1,250" stay.
 */
const RUN = new RegExp(
  `(?<![\\d$€£]|[$€£]\\s|\\d[.,])${D}(?:(?:[ \\t-]{1,2}|[,.]\\s+)?${D}){0,63}(?![.,]?\\d)`,
  "gi",
);
/** A remembered value is found inside a run at most this many digits longer. */
const EXTRA_DIGITS = 2;
/** Refuse new values at capacity; only the host may clear session memory. */
const REMEMBER_LIMIT = 128;

/** cyrb53: a fast 53-bit keyed string hash for comparison. Not cryptographic. */
function cyrb53(seed, text) {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 =
    Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^
    Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 =
    Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^
    Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}
const randomSeed = () =>
  globalThis.crypto.getRandomValues(new Uint32Array(1))[0];
const tokensOf = (text) =>
  [...String(text).matchAll(/\S+/g)]
    .map((match) => {
      const raw = match[0];
      const lead = raw.length - raw.replace(/^[("'“‘]+/, "").length;
      const word = raw.slice(lead).replace(/[)"'”’.,!?;:]+$/, "");
      const start = match.index + lead;
      return { word: word.toLowerCase(), start, end: start + word.length };
    })
    .filter((token) => token.word);
const credentialWords = (tokens) =>
  tokens.filter((word) => word.length >= 4 && /[^a-z]/.test(word));
const onlyDigits = (value, digits) =>
  digits.length >= 4 &&
  digits.length === value.replace(/[^\dA-Za-z]/g, "").length;

/** [start, end) spans from every matcher, sorted and merged. */
function matcherSpans(matchers, text) {
  const merged = [];
  const spans = matchers
    .flatMap((matcher) => [...matcher.spans(text)])
    .sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  for (const [start, end] of spans) {
    const last = merged.at(-1);
    if (last && start < last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

/**
 * Removes detected secrets from text and remembers each one, so it is removed
 * again wherever it comes back later, also as spoken digit words or as the
 * start or end of a code that a transcript heard only in part. Use one
 * scrubber per signed-in session and call `clear()` when the session ends.
 * @param {{ seed?: number, matchers?: SensitiveTextMatcher[] }} [options]
 */
export function createSecretScrubber({
  seed = randomSeed(),
  matchers = [],
} = {}) {
  const digitSecrets = new Set();
  const digitParts = new Set();
  const digitLengths = new Set();
  const phraseSecrets = new Set();
  const phraseLengths = new Set();
  const key = (text) => cyrb53(seed, text);
  const size = () => digitSecrets.size + phraseSecrets.size;
  let exhausted = false;
  function requireCapacity() {
    if (exhausted)
      throw new NativeHostError(
        "Secret memory is full. End the session before continuing.",
        { status: 422, code: "SENSITIVE_TEXT_CAPACITY" },
      );
  }

  function clear() {
    exhausted = false;
    digitSecrets.clear();
    digitParts.clear();
    digitLengths.clear();
    phraseSecrets.clear();
    phraseLengths.clear();
  }
  function rememberFingerprint(values, fingerprint) {
    if (!values.has(fingerprint) && size() >= REMEMBER_LIMIT) exhausted = true;
    requireCapacity();
    values.add(fingerprint);
  }
  function rememberDigits(digits) {
    if (digits.length < 4 || digits.length > 64) return;
    rememberFingerprint(digitSecrets, key(digits));
    digitLengths.add(digits.length);
    // The start or end of the value: four or more digits of a short code,
    // eight or more of a longer number. A card's last four digits are on
    // every receipt, so they are not remembered.
    for (let n = digits.length <= 8 ? 4 : 8; n < digits.length; n++) {
      digitParts.add(key(digits.slice(0, n)));
      digitParts.add(key(digits.slice(-n)));
    }
  }
  function rememberWords(words) {
    for (const word of credentialWords(words)) {
      rememberFingerprint(phraseSecrets, key(word));
      phraseLengths.add(1);
    }
  }
  /**
   * The value of a clause ("password is hunter2 and I paid 1250"): its first
   * word only. The rest of the clause is removed but never remembered, so an
   * amount, date or room number in the same sentence is not refused later.
   * A comma or semicolon with no space after it may end the value
   * ("hunter2,please") or be part of it, so the word and the part before
   * the punctuation are remembered, never what comes after it.
   */
  function rememberClauseValue(first) {
    if (!first) return;
    const head = first.split(/[,;]/)[0];
    rememberWords(head && head !== first ? [first, head] : [first]);
    // Digits come from the part before the punctuation only: "4829,2024"
    // remembers 4829 (and the whole word above), never the year after it.
    const digits = digitsOf(head);
    if (onlyDigits(head, digits)) rememberDigits(digits);
  }
  function remember(kind, value) {
    if (!kind) return;
    const digits = digitsOf(value);
    if (kind === "digits") return rememberDigits(digits);
    const words = tokensOf(value)
      .map((token) => token.word)
      .filter((word) => word !== SECRET_REMOVED_MARK);
    if (kind === "password") return rememberClauseValue(words[0]);
    if (!words.length || words.length > 12) return;
    rememberFingerprint(phraseSecrets, key(words.join(" ")));
    phraseLengths.add(words.length);
    if (kind === "clause") return rememberClauseValue(words[0]);
    rememberWords(words);
    if (onlyDigits(value, digits)) rememberDigits(digits);
  }

  function removeRemembered(text, mark) {
    let out = text;
    if (digitSecrets.size) {
      out = out.replace(RUN, (match) => {
        const digits = digitsOf(match);
        if (digits.length < 4) return match;
        if (digitSecrets.has(key(digits)) || digitParts.has(key(digits)))
          return mark;
        for (const n of digitLengths) {
          if (digits.length <= n || digits.length > n + EXTRA_DIGITS) continue;
          for (let i = 0; i + n <= digits.length; i++)
            if (digitSecrets.has(key(digits.slice(i, i + n)))) return mark;
        }
        return match;
      });
    }
    if (phraseSecrets.size) {
      const tokens = tokensOf(out);
      const taken = [];
      // Longest phrase first; a span inside one already taken is skipped.
      for (const n of [...phraseLengths].sort((a, b) => b - a))
        for (let i = 0; i + n <= tokens.length; i++) {
          const window = tokens.slice(i, i + n);
          const [start, end] = [window[0].start, window.at(-1).end];
          if (window[0].word === SECRET_REMOVED_MARK) continue;
          if (taken.some(([a, b]) => start < b && end > a)) continue;
          if (phraseSecrets.has(key(window.map((t) => t.word).join(" "))))
            taken.push([start, end]);
        }
      for (const [start, end] of taken.sort((a, b) => b[0] - a[0]))
        out = out.slice(0, start) + mark + out.slice(end);
    }
    return out;
  }

  /**
   * One pass. With `keepWords` false the telling words go too, which gives the
   * probe that the check reads afterwards.
   */
  function pass(text, mark, keepWords) {
    let out = text;
    for (const { pattern, kind, valueFirst } of RULES) {
      out = out.replace(pattern, (match, first, second) => {
        if (typeof first !== "string") {
          remember(kind, match);
          return mark;
        }
        const [secret, words] = valueFirst ? [first, second] : [second, first];
        if (secret.trim().startsWith(SECRET_REMOVED_MARK))
          return keepWords ? match : mark;
        remember(kind, secret);
        if (!keepWords) return mark;
        return valueFirst ? mark + words : words + mark;
      });
    }
    out = out.replace(CARD, (match) => {
      const digits = digitsOf(match);
      if (!luhn(digits)) return match;
      rememberDigits(digits);
      return mark;
    });
    for (const [start, end] of matcherSpans(matchers, out).reverse()) {
      remember("phrase", out.slice(start, end));
      out = out.slice(0, start) + mark + out.slice(end);
    }
    return removeRemembered(out, mark);
  }

  /** Text with every detected or remembered secret replaced by the mark. */
  function scrub(value) {
    requireCapacity();
    if (typeof value !== "string" || !value) return value;
    const text = normalize(value);
    const out = pass(text, SECRET_REMOVED_MARK, true);
    // A secret the check still sees but no rule could place ("482917",
    // "four eight two nine"): the whole text goes.
    const probe = pass(text, "\n", false).split(SECRET_REMOVED_MARK).join("\n");
    if (containsSensitiveText(probe, { matchers })) {
      const digits = digitsOf(probe);
      if (digits.length >= 4 && digits.length <= 19) rememberDigits(digits);
      return SECRET_REMOVED_MARK;
    }
    // Nothing found: the original characters come back (NFKC is only for matching).
    return out === text ? value : out;
  }

  /** A copy of a plain object or array with every string scrubbed. Keys are kept. */
  function scrubValue(value, depth = 0) {
    if (typeof value === "string") return scrub(value);
    if (value === null || typeof value !== "object") return value;
    if (depth > 20)
      throw new NativeHostError("Value nesting exceeds the scrubber limit.", {
        status: 400,
        code: "INVALID_TEXT_STRUCTURE",
      });
    if (Array.isArray(value))
      return value.map((item) => scrubValue(item, depth + 1));
    // A Date, Error, Map or class instance is returned as it is.
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [
        name,
        scrubValue(item, depth + 1),
      ]),
    );
  }

  return {
    scrub,
    scrubValue,
    /** Removes only values already remembered; nothing new is looked for. */
    scrubRemembered(value) {
      requireCapacity();
      if (typeof value !== "string" || !value || !size()) return value;
      const text = normalize(value);
      const out = removeRemembered(text, SECRET_REMOVED_MARK);
      return out === text ? value : out;
    },
    /**
     * Whether text carries a value already remembered. Nothing new is looked
     * for and nothing is remembered.
     */
    carriesRemembered(value) {
      requireCapacity();
      if (typeof value !== "string" || !value || !size()) return false;
      const text = normalize(value);
      return removeRemembered(text, SECRET_REMOVED_MARK) !== text;
    },
    /** Detects and remembers the secrets in rejected text without keeping the text. */
    remember(value) {
      if (typeof value === "string") scrub(value);
    },
    /** How many values are remembered (never the values). */
    get size() {
      return size();
    },
    clear,
  };
}

/**
 * The check a host runs on text before it reaches a model, speech or storage,
 * with a memory. A refused value is remembered, and later text that carries
 * it is refused too, also without telling words. The whole text is refused,
 * never silently changed.
 * @param {{ matchers?: SensitiveTextMatcher[], scrubber?: ReturnType<typeof createSecretScrubber> }} [options]
 */
export function createSensitiveTextGate({
  matchers = [],
  scrubber = createSecretScrubber({ matchers }),
} = {}) {
  return {
    scrubber,
    require(text) {
      if (containsSensitiveText(text, { matchers })) {
        scrubber.remember(text);
        throw refusal();
      }
      // Only a value refused before; never what the scrubber's wider
      // removal rules would change, and nothing new is remembered here.
      if (scrubber.carriesRemembered(text)) throw refusal();
    },
    clear() {
      scrubber.clear();
    },
  };
}

/** Text with detected secrets replaced by the mark. Nothing is remembered. */
export const redactSensitiveText = (value, options) =>
  createSecretScrubber(options).scrub(value);
