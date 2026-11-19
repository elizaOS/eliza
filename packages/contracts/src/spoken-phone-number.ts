/**
 * Digits the owner spoke rather than typed. A voice request reaches the agent
 * as its transcript, where a number is words ("four one five, five five five,
 * zero one zero zero", "oh one double oh") or ASR fragments ("Call for 15.
 * 5550160."), so it has no digit string to compare a proposed number with.
 *
 * This only reads candidates from the owner's own words; a proposal is
 * accepted when it equals one exactly (country code aside). It never guesses a
 * digit the words do not carry.
 */

const UNITS = new Map(
  Object.entries({
    zero: "0",
    oh: "0",
    o: "0",
    one: "1",
    two: "2",
    three: "3",
    four: "4",
    five: "5",
    six: "6",
    seven: "7",
    eight: "8",
    nine: "9",
  }),
);
// "four fifteen" is 4 1 5: a spoken pair is its two digits.
const TEENS = new Map(
  Object.entries({
    ten: "10",
    eleven: "11",
    twelve: "12",
    thirteen: "13",
    fourteen: "14",
    fifteen: "15",
    sixteen: "16",
    seventeen: "17",
    eighteen: "18",
    nineteen: "19",
  }),
);
const TENS = new Map(
  Object.entries({
    twenty: "2",
    thirty: "3",
    forty: "4",
    fifty: "5",
    sixty: "6",
    seventy: "7",
    eighty: "8",
    ninety: "9",
  }),
);
const REPEATS = new Map(Object.entries({ double: 2, triple: 3 }));
// Words an ASR writes for a spoken digit; a digit only beside other digits
// ("Call for 15." is 4 15), never on its own ("text Sam to say hi").
const HOMOPHONES = new Map(
  Object.entries({
    for: "4",
    to: "2",
    too: "2",
  }),
);
// Pauses inside one spoken number: "four one five, five five five".
const SEPARATORS = new Set([",", ".", "-", "(", ")"]);
// Shorter candidates are times, counts and list numbers; 3 keeps 911.
const MIN_DIGITS = 3;
// A run longer than this is not one phone number with its country code.
const MAX_DIGITS = 15;

type Fragment = { digits: string; homophone: boolean };

function unitDigit(token: string | undefined): string | undefined {
  if (token === undefined) return;
  if (/^\d$/.test(token)) return token;
  return UNITS.get(token);
}

/**
 * Fragments of spoken digits, in order, split into runs at anything that is
 * not a number word, a digit group or a pause. A fragment ends at a pause and
 * a homophone is a fragment of its own.
 */
function spokenRuns(text: string, wholeNumber = false): Fragment[][] {
  const tokens =
    text
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[’‘]/g, "'")
      .match(/[\p{L}\p{N}']+|\S/gu) ?? [];
  const runs: Fragment[][] = [];
  let run: Fragment[] = [];
  let open = false; // The last fragment may still grow.
  const end = () => {
    if (run.length) runs.push(run);
    run = [];
    open = false;
  };
  const add = (digits: string, homophone = false) => {
    const last = run.at(-1);
    if (open && last && !last.homophone && !homophone) last.digits += digits;
    else run.push({ digits, homophone });
    open = !homophone;
  };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === undefined) break;
    const digit = UNITS.get(token);
    const teen = TEENS.get(token);
    const tens = TENS.get(token);
    const repeats = REPEATS.get(token);
    const homophone = HOMOPHONES.get(token);
    if (/^\d+$/.test(token)) add(token);
    else if (digit !== undefined) add(digit);
    else if (teen !== undefined) add(teen);
    else if (tens !== undefined) {
      // "forty two", "forty-two" or a bare "forty".
      const hyphen = tokens[i + 1] === "-" ? 1 : 0;
      const nextWord = tokens[i + 1 + hyphen];
      const unit = unitDigit(nextWord);
      if (unit && unit !== "0" && nextWord && /^\p{L}+$/u.test(nextWord)) {
        add(tens + unit);
        i += 1 + hyphen;
      } else add(`${tens}0`);
    } else if (repeats !== undefined) {
      const unit = unitDigit(tokens[i + 1]);
      if (!unit) {
        if (wholeNumber) return [];
        end();
        continue;
      }
      add(unit.repeat(repeats));
      i += 1;
    } else if (homophone !== undefined) add(homophone, true);
    else if (SEPARATORS.has(token)) open = false;
    else if (wholeNumber) return [];
    else end();
  }
  end();
  // A homophone counts only beside a fragment of real digits.
  return runs.flatMap((fragments) => {
    let part: Fragment[] = [];
    const split = [part];
    for (const [i, fragment] of fragments.entries()) {
      const beside =
        !fragment.homophone ||
        [fragments[i - 1], fragments[i + 1]].some(
          (neighbor) => neighbor && !neighbor.homophone,
        );
      if (beside) part.push(fragment);
      else if (wholeNumber) return [];
      else {
        part = [];
        split.push(part);
      }
    }
    return split.filter((part) => part.length);
  });
}

/** A whole spoken address, with no name or message-body words. */
export function completeSpokenPhoneNumber(text: string): string | undefined {
  if (!/[a-z]/iu.test(text)) return;
  const prefix = /^(?:plus\s+|\+)/iu.exec(text);
  const [run, second] = spokenRuns(text.slice(prefix?.[0].length ?? 0), true);
  if (!run || second) return;
  const digits = run.map(({ digits }) => digits).join("");
  if (digits.length >= MIN_DIGITS && digits.length <= MAX_DIGITS)
    return prefix ? `+${digits}` : digits;
}

/**
 * Every number the owner may have spoken in `text`: the digits of each spoken
 * run and of each of its consecutive fragments ("for | 15 | 5550160" gives
 * 4155550160, 415, 155550160, 5550160 …), with at least three digits.
 */
export function spokenPhoneNumbers(text: string): string[] {
  const numbers = new Set<string>();
  for (const run of spokenRuns(text))
    for (let i = 0; i < run.length; i++) {
      let digits = "";
      for (let j = i; j < run.length; j++) {
        const fragment = run[j];
        if (!fragment) break;
        digits += fragment.digits;
        if (digits.length > MAX_DIGITS) break;
        if (digits.length >= MIN_DIGITS) numbers.add(digits);
      }
    }
  return [...numbers];
}
