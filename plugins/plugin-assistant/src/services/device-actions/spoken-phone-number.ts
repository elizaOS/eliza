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

const UNITS: Readonly<Record<string, string>> = {
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
};
// "four fifteen" is 4 1 5: a spoken pair is its two digits.
const TEENS: Readonly<Record<string, string>> = {
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
};
const TENS: Readonly<Record<string, string>> = {
  twenty: "2",
  thirty: "3",
  forty: "4",
  fifty: "5",
  sixty: "6",
  seventy: "7",
  eighty: "8",
  ninety: "9",
};
const REPEATS: Readonly<Record<string, number>> = { double: 2, triple: 3 };
// Words an ASR writes for a spoken digit; a digit only beside other digits
// ("Call for 15." is 4 15), never on its own ("text Sam to say hi").
const HOMOPHONES: Readonly<Record<string, string>> = {
  for: "4",
  to: "2",
  too: "2",
};
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
  return UNITS[token];
}

/**
 * Fragments of spoken digits, in order, split into runs at anything that is
 * not a number word, a digit group or a pause. A fragment ends at a pause and
 * a homophone is a fragment of its own.
 */
function spokenRuns(text: string): Fragment[][] {
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
    const token = tokens[i] ?? "";
    const units = UNITS[token];
    const teens = TEENS[token];
    const tens = TENS[token];
    const repeats = REPEATS[token];
    const homophone = HOMOPHONES[token];
    if (/^\d+$/.test(token)) add(token);
    else if (units !== undefined) add(units);
    else if (teens !== undefined) add(teens);
    else if (tens !== undefined) {
      // "forty two", "forty-two" or a bare "forty".
      const hyphen = tokens[i + 1] === "-" ? 1 : 0;
      const next = tokens[i + 1 + hyphen];
      const unit = unitDigit(next);
      if (
        unit &&
        unit !== "0" &&
        next !== undefined &&
        /^\p{L}+$/u.test(next)
      ) {
        add(tens + unit);
        i += 1 + hyphen;
      } else add(`${tens}0`);
    } else if (repeats !== undefined) {
      const unit = unitDigit(tokens[i + 1]);
      if (!unit) {
        end();
        continue;
      }
      add(unit.repeat(repeats));
      i += 1;
    } else if (homophone !== undefined) add(homophone, true);
    else if (SEPARATORS.has(token)) open = false;
    else end();
  }
  end();
  // A homophone counts only beside a fragment of real digits.
  return runs.flatMap((fragments) => {
    const split: Fragment[][] = [[]];
    fragments.forEach((fragment, i) => {
      const beside =
        !fragment.homophone ||
        [fragments[i - 1], fragments[i + 1]].some(
          (neighbor) => neighbor && !neighbor.homophone,
        );
      const current = split.at(-1);
      if (beside && current) current.push(fragment);
      else split.push([]);
    });
    return split.filter((part) => part.length);
  });
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
        digits += run[j]?.digits ?? "";
        if (digits.length > MAX_DIGITS) break;
        if (digits.length >= MIN_DIGITS) numbers.add(digits);
      }
    }
  return [...numbers];
}
