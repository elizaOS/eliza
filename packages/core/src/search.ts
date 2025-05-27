// Implementation of BM25 and Porter2 stemming
// https://github.com/eilvelia/porter2.js
// https://www.npmjs.com/package/fast-bm25

// The MIT License

// Copyright (c) 2024 eilvelia <hi@eilvelia.cat>

// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:

// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.

// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// MIT License

// Copyright (c) 2024 Vivek Patel <me@patelvivek.dev>.

// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:

// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.

// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

/**
 * Checks if the character code represents a vowel (a, e, i, o, u, y).
 * @param char - The character code.
 * @returns True if the character is a vowel, false otherwise.
 */
const isV = (char: number): boolean => {
  switch (char) {
    case 97:
    case 101:
    case 105:
    case 111:
    case 117:
    case 121:
      return true;
    default:
      return false;
  }
};

/**
 * Checks if the character code is 'w', 'x', 'y', or a vowel.
 * Used in determining short syllables.
 * @param char - The character code.
 * @returns True if the character is w, x, y, or a vowel, false otherwise.
 */
const isWxy = (char: number): boolean => {
  switch (char) {
    case 97:
    case 101:
    case 105:
    case 111:
    case 117:
    case 121:
    case 119:
    case 120:
    case 89:
      return true;
    default:
      return false;
  }
};

/**
 * Checks if the character code is one of the valid endings for Step 1c ('li' rule).
 * Valid endings: c, d, e, g, h, k, m, n, r, t.
 * @param char - The character code.
 * @returns True if the character is a valid 'li' ending, false otherwise.
 */
const isValidLi = (char: number): boolean => {
  switch (char) {
    case 99:
    case 100:
    case 101:
    case 103:
    case 104:
    case 107:
    case 109:
    case 110:
    case 114:
    case 116:
      return true;
    default:
      return false;
  }
};

/**
 * Checks if the character code represents a "double" consonant sound
 * (bb, dd, ff, gg, mm, nn, pp, rr, tt).
 * @param char - The character code.
 * @returns True if the character forms a double consonant, false otherwise.
 */
const isDouble = (char: number): boolean => {
  switch (char) {
    case 98:
    case 100:
    case 102:
    case 103:
    case 109:
    case 110:
    case 112:
    case 114:
    case 116:
      return true;
    default:
      return false;
  }
};

/**
 * Checks if a word ends in a short syllable.
 * A short syllable is defined as:
 * 1. A vowel followed by a non-vowel at the end of the word. (e.g., "hop")
 * 2. A vowel followed by a non-vowel followed by a non-vowel ('w', 'x', 'y' excluded). (e.g., "trap")
 * @param w - Array of character codes representing the word.
 * @param len - The current effective length of the word being considered.
 * @returns True if the word ends in a short syllable, false otherwise.
 */
const isShortV = (w: number[], len: number): boolean => {
  // backwardmode: ( non-v_WXY v non-v ) or ( non-v v atlimit )
  return (
    len >= 2 &&
    isV(w[len - 2]) &&
    ((len === 2 && !isV(w[len - 1])) || (len >= 3 && !isV(w[len - 3]) && !isWxy(w[len - 1])))
  );
};

// #endregion Porter2 Stemmer Helper Functions

// #region Porter2 Stemmer Algorithm

/**
 * Stems a given word using the Porter2 (Snowball English) stemming algorithm.
 *
 * The algorithm works in several steps, applying suffix stripping rules based on
 * regions R1 and R2 within the word.
 * - R1: The region after the first non-vowel following a vowel.
 * - R2: The region after the first non-vowel following a vowel in R1.
 *
 * The steps generally involve:
 * 1. Handling plurals and past participles (-s, -es, -ed, -ing).
 * 2. Turning terminal 'y' to 'i' if there is another vowel in the stem.
 * 3. Mapping double suffixes to single ones (e.g., -ization to -ize).
 * 4. Dealing with suffixes like -full, -ness, etc.
 * 5. Removing suffixes like -ant, -ence, etc.
 * 6. Removing a final -e.
 *
 * @param word - The word to be stemmed.
 * @returns The stemmed version of the word.
 */
const stem = (word: string): string => {
  if (word.length < 3) return word;
  // exception1
  if (word.length <= 6) {
    switch (word) {
      case 'ski':
        return 'ski';
      case 'skies':
        return 'sky';
      case 'dying':
        return 'die';
      case 'lying':
        return 'lie';
      case 'tying':
        return 'tie';
      // special -LY cases
      case 'idly':
        return 'idl';
      case 'gently':
        return 'gentl';
      case 'ugly':
        return 'ugli';
      case 'early':
        return 'earli';
      case 'only':
        return 'onli';
      case 'singly':
        return 'singl';
      // invariant forms
      case 'sky':
      case 'news':
      case 'howe':
      // not plural forms
      case 'atlas':
      case 'cosmos':
      case 'bias':
      case 'andes':
        return word;
    }
  }
  const initialOffset = word.charCodeAt(0) === 39 /* ' */ ? 1 : 0;
  let l = word.length - initialOffset;
  const w = new Array<number>(l);
  let yFound = false;
  for (let i = 0; i < l; ++i) {
    const ch = word.charCodeAt(i + initialOffset);
    if (ch === 121 && (i === 0 || isV(w[i - 1]))) {
      yFound = true;
      w[i] = 89;
      continue;
    }
    w[i] = ch;
  }
  if (w[l - 1] === 39 /* ' */) --l;
  if (l >= 2 && w[l - 2] === 39 /* ' */ && w[l - 1] === 115 /* s */) l -= 2;
  // mark_regions
  let rv = 0;
  // rv is the position after the first vowel
  while (rv < l && !isV(w[rv])) ++rv;
  if (rv < l) ++rv;
  let r1 = rv;
  if (
    l >= 5 &&
    ((w[0] === 103 && w[1] === 101 && w[2] === 110 && w[3] === 101 && w[4] === 114) || // gener
      (w[0] === 97 && w[1] === 114 && w[2] === 115 && w[3] === 101 && w[4] === 110)) // arsen
  )
    r1 = 5;
  else if (
    l >= 6 &&
    w[0] === 99 && // c
    w[1] === 111 && // o
    w[2] === 109 && // m
    w[3] === 109 && // m
    w[4] === 117 && // u
    w[5] === 110 // n
  )
    // commun
    r1 = 6;
  else {
    // > R1 is the region after the first non-vowel following a vowel,
    // > or the end of the word if there is no such non-vowel.
    while (r1 < l && isV(w[r1])) ++r1;
    if (r1 < l) ++r1;
  }
  // > R2 is the region after the first non-vowel following a vowel in R1,
  // > or the end of the word if there is no such non-vowel.
  let r2 = r1;
  while (r2 < l && !isV(w[r2])) ++r2;
  while (r2 < l && isV(w[r2])) ++r2;
  if (r2 < l) ++r2;
  // Step_1a
  if (l >= 3) {
    if (w[l - 1] === 115) {
      // s
      if (l >= 4 && w[l - 2] === 101 && w[l - 3] === 115 && w[l - 4] === 115)
        // sses
        l -= 2; // sses -> ss
      else if (w[l - 2] === 101 && w[l - 3] === 105)
        // ies
        l -= l >= 5 ? 2 : 1; // ies
      else if (w[l - 2] !== 117 && w[l - 2] !== 115 && rv < l - 1)
        // us ss -> <nothing>; s -> "delete if the preceding word part
        // contains a vowel not immediately before the s"
        l -= 1;
    } else if (w[l - 1] === 100 && w[l - 2] === 101 && w[l - 3] === 105) l -= l >= 5 ? 2 : 1; // ied
  }
  // exception2
  if (
    (l === 6 &&
      ((w[0] === 105 && // i
        w[1] === 110 && // n
        w[2] === 110 && // n
        w[3] === 105 && // i
        w[4] === 110 && // n
        w[5] === 103) || // g (inning)
        (w[0] === 111 && // o
          w[1] === 117 && // u
          w[2] === 116 && // t
          w[3] === 105 && // i
          w[4] === 110 && // n
          w[5] === 103) || // g (outing)
        (w[0] === 101 && // e
          w[1] === 120 && // x
          w[2] === 99 && // c
          w[3] === 101 && // e
          w[4] === 101 && // e
          w[5] === 100))) || // d (exceed)
    (l === 7 &&
      ((w[0] === 99 && // c
        w[1] === 97 && // a
        w[2] === 110 && // n
        w[3] === 110 && // n
        w[4] === 105 && // i
        w[5] === 110 && // n
        w[6] === 103) || // g (canning)
        (w[0] === 104 && // h
          w[1] === 101 && // e
          w[2] === 114 && // r
          w[3] === 114 && // r
          w[4] === 105 && // i
          w[5] === 110 && // n
          w[6] === 103) || // g (herring)
        (w[0] === 101 && // e
          w[1] === 97 && // a
          w[2] === 114 && // r
          w[3] === 114 && // r
          w[4] === 105 && // i
          w[5] === 110 && // n
          w[6] === 103) || // g (earring)
        (w[0] === 112 && // p
          w[1] === 114 && // r
          w[2] === 111 && // o
          w[3] === 99 && // c
          w[4] === 101 && // e
          w[5] === 101 && // e
          w[6] === 100) || // d (proceed)
        (w[0] === 115 && // s
          w[1] === 117 && // u
          w[2] === 99 && // c
          w[3] === 99 && // c
          w[4] === 101 && // e
          w[5] === 101 && // e
          w[6] === 100))) // d (succeed)
  ) {
    let exp2Out = '';
    for (let i = 0; i < l; ++i) exp2Out += String.fromCharCode(w[i]);
    return exp2Out;
  }
  // Step_1b
  let ll =
    // l (length) without the -ly ending
    l >= 2 && w[l - 1] === 121 && w[l - 2] === 108 ? l - 2 : l;
  if (ll >= 3) {
    if (w[ll - 3] === 101 && w[ll - 2] === 101 && w[ll - 1] === 100) {
      // eed
      if (ll >= r1 + 3) l = ll - 1; // eed eedly -> ee (if in R1)
    } else {
      // ll without: ed edly ing ingly (-1 if not found)
      if (w[ll - 2] === 101 && w[ll - 1] === 100)
        ll -= 2; // ed
      else if (w[ll - 3] === 105 && w[ll - 2] === 110 && w[ll - 1] === 103)
        ll -= 3; // ing
      else ll = -1;
      if (ll >= 0 && rv <= ll) {
        l = ll;
        if (l >= 2) {
          if (
            (w[l - 1] === 116 && w[l - 2] === 97) || // at
            (w[l - 1] === 108 && w[l - 2] === 98) || // bl
            (w[l - 1] === 122 && w[l - 2] === 105) // iz
          ) {
            // at -> ate   bl -> ble   iz -> ize
            w[l] = 101;
            ++l;
          } else if (w[l - 2] === w[l - 1] && isDouble(w[l - 1])) {
            --l;
          } else if (r1 >= l && isShortV(w, l)) {
            // <shortv> -> e
            w[l] = 101;
            ++l;
          }
        }
      }
    }
  }
  // Step_1c
  if (l >= 3 && (w[l - 1] === 89 || w[l - 1] === 121) && !isV(w[l - 2])) w[l - 1] = 105; // i
  // Step_2
  if (l >= r1 + 2) {
    switch (w[l - 1]) {
      case 108: // l
        if (
          l >= r1 + 6 &&
          w[l - 2] === 97 && // a
          w[l - 3] === 110 && // n
          w[l - 4] === 111 && // o
          w[l - 5] === 105 && // i
          w[l - 6] === 116 // t (tional)
        ) {
          if (l >= 7 && w[l - 7] === 97) {
            // a (ational)
            if (l >= r1 + 7) {
              // ational -> ate
              l -= 4;
              w[l - 1] = 101; // e
            }
          } else {
            l -= 2; // tional -> tion
          }
        }
        break;
      case 110: // n
        if (
          l >= r1 + 5 &&
          w[l - 2] === 111 && // o
          w[l - 3] === 105 && // i
          w[l - 4] === 116 && // t
          w[l - 5] === 97 // a (ation)
        ) {
          if (l >= 7 && w[l - 6] === 122 && w[l - 7] === 105) {
            // iz (ization)
            if (l >= r1 + 7) {
              // ization -> ize
              l -= 4;
              w[l - 1] = 101; // e
            }
          } else {
            // ation -> ate
            l -= 2;
            w[l - 1] = 101; // e
          }
        }
        break;
      case 114: // r
        if (l >= r1 + 4) {
          if (w[l - 2] === 101) {
            // e (er)
            if (w[l - 3] === 122 && w[l - 4] === 105) --l; // izer -> ize
          } else if (w[l - 2] === 111) {
            // o (or)
            if (w[l - 3] === 116 && w[l - 4] === 97) {
              // ator
              --l;
              w[l - 1] = 101; // e
            }
          }
        }
        break;
      case 115: // s
        if (
          l >= r1 + 7 &&
          w[l - 2] === 115 && // s
          w[l - 3] === 101 && // e
          w[l - 4] === 110 && // n (ness)
          ((w[l - 5] === 108 && w[l - 6] === 117 && w[l - 7] === 102) || // fulness
            (w[l - 5] === 115 && w[l - 6] === 117 && w[l - 7] === 111) || // ousness
            (w[l - 5] === 101 && w[l - 6] === 118 && w[l - 7] === 105)) // iveness
        ) {
          l -= 4; // fulness -> ful   ousness -> ous   iveness -> ive
        }
        break;
      case 109: // m
        if (
          l >= r1 + 5 &&
          w[l - 2] === 115 && // s
          w[l - 3] === 105 && // i
          w[l - 4] === 108 && // l
          w[l - 5] === 97 // a (alism)
        )
          l -= 3; // alism -> al
        break;
      case 105: // i
        if (w[l - 2] === 99) {
          // c (ic)
          if (l >= r1 + 4 && (w[l - 4] === 101 || w[l - 4] === 97) && w[l - 3] === 110) {
            // enci anci
            w[l - 1] = 101; // enci -> ence   anci -> ance
          }
        } else if (w[l - 2] === 103) {
          // g (gi)
          if (l >= r1 + 3 && l >= 4 && w[l - 2] === 103 && w[l - 3] === 111 && w[l - 4] === 108)
            // logi
            --l; // ogi -> og (if preceded by l)
        } else if (w[l - 2] === 116) {
          // t (ti)
          if (l >= r1 + 5 && w[l - 3] === 105) {
            // iti
            if (w[l - 4] === 108) {
              // liti
              if (l >= 6 && w[l - 5] === 105 && w[l - 6] === 98) {
                // biliti
                if (l >= r1 + 6) {
                  // biliti -> ble
                  l -= 3;
                  w[l - 2] = 108; // l
                  w[l - 1] = 101; // e
                }
              } else if (w[l - 4] === 108 && w[l - 5] === 97) {
                // aliti
                l -= 3; // aliti -> al
              }
            } else if (w[l - 4] === 118 && w[l - 5] === 105) {
              // iviti
              // iviti -> ive
              l -= 2;
              w[l - 1] = 101; // e
            }
          }
        } else if (w[l - 2] === 108 && l >= 3) {
          // l (li)
          if (w[l - 3] === 98) {
            // bli
            if (l >= 4 && w[l - 4] === 97) {
              // abli
              if (l >= r1 + 4) w[l - 1] = 101; // abli -> able
            } else if (l >= r1 + 3) {
              w[l - 1] = 101; // bli -> ble
            }
          } else {
            // Remove li
            if (w[l - 3] === 108) {
              // lli
              if (l >= 5 && w[l - 4] === 117 && w[l - 5] === 102) {
                // fulli
                if (l >= r1 + 5) l -= 2; // fulli -> ful
              } else if (l >= r1 + 4 && w[l - 4] === 97) {
                // alli
                l -= 2; // alli -> al
              }
            } else if (w[l - 3] === 115) {
              // sli
              if (l >= 6 && w[l - 4] === 115 && w[l - 5] === 101 && w[l - 6] === 108) {
                // lessli
                if (l >= r1 + 6) l -= 2; // lessli -> less
              } else if (l >= r1 + 5 && w[l - 4] === 117 && w[l - 5] === 111) {
                // ousli
                l -= 2; // ousli -> ous
              }
            } else if (l >= 5 && w[l - 3] === 116 && w[l - 4] === 110 && w[l - 5] === 101) {
              // entli
              if (l >= r1 + 5) l -= 2; // entli -> ent
            } else if (isValidLi(w[l - 3])) {
              l -= 2;
            }
          }
        }
    }
  }
  // Step_3
  if (l >= r1 + 3) {
    switch (w[l - 1]) {
      case 108: // l
        if (w[l - 3] === 99) {
          // cal
          if (l >= r1 + 4 && w[l - 4] === 105 && w[l - 2] === 97) l -= 2; // ical -> ic
        } else if (w[l - 3] === 102) {
          // ful
          if (w[l - 2] === 117) l -= 3; // ful -> <delete>
        } else if (w[l - 3] === 110) {
          // nal
          if (
            l >= r1 + 6 &&
            w[l - 2] === 97 && // a
            w[l - 4] === 111 && // o
            w[l - 5] === 105 && // i
            w[l - 6] === 116 // t (tional)
          ) {
            if (l >= 7 && w[l - 7] === 97) {
              // ational
              if (l >= r1 + 7) {
                // ational -> ate
                l -= 4;
                w[l - 1] = 101; // e
              }
            } else {
              l -= 2; // tional -> tion
            }
          }
        }
        break;
      case 101: // e
        if (w[l - 2] === 122) {
          // ze
          if (l >= r1 + 5 && w[l - 3] === 105 && w[l - 4] === 108 && w[l - 5] === 97) l -= 3; // alize -> al
        } else if (w[l - 2] === 116) {
          // te
          if (l >= r1 + 5 && w[l - 3] === 97 && w[l - 4] === 99 && w[l - 5] === 105) l -= 3; // icate -> ic
        } else if (w[l - 2] === 118) {
          // ve
          if (l >= r2 + 5 && w[l - 3] === 105 && w[l - 4] === 116 && w[l - 5] === 97) l -= 5; // ative -> <delete> (if in R2)
        }
        break;
      case 105: // i
        if (
          l >= r1 + 5 &&
          w[l - 2] === 116 && // t
          w[l - 3] === 105 && // i
          w[l - 4] === 99 && // c
          w[l - 5] === 105 // i (iciti)
        )
          l -= 3; // iciti -> ic
        break;
      case 115: // s
        if (l >= r1 + 4 && w[l - 2] === 115 && w[l - 3] === 101 && w[l - 4] === 110) l -= 4; // ness -> <delete>
    }
  }
  // Step_4
  if (l >= r2 + 2) {
    switch (w[l - 1]) {
      case 110: // n
        if (
          l >= r2 + 3 &&
          w[l - 2] === 111 && // o
          w[l - 3] === 105 && // i (ion)
          (w[l - 4] === 115 || w[l - 4] === 116) // s or t
        )
          l -= 3; // ion -> <delete> (if preceded by s or t)
        break;
      case 108: // l
        if (w[l - 2] === 97) l -= 2; // al
        break;
      case 114: // r
        if (w[l - 2] === 101) l -= 2; // er
        break;
      case 99: // c
        if (w[l - 2] === 105) l -= 2; // ic
        break;
      case 109: // m
        if (l >= r2 + 3 && w[l - 2] === 115 && w[l - 3] === 105) l -= 3; // ism
        break;
      case 105: // i
        if (l >= r2 + 3 && w[l - 2] === 116 && w[l - 3] === 105) l -= 3; // iti
        break;
      case 115: // s
        if (l >= r2 + 3 && w[l - 2] === 117 && w[l - 3] === 111) l -= 3; // ous
        break;
      case 116: // t
        if (l >= r2 + 3 && w[l - 2] === 110) {
          // nt
          if (w[l - 3] === 97) {
            // ant
            l -= 3; // ant
          } else if (w[l - 3] === 101) {
            // ent
            if (l >= 4 && w[l - 4] === 109) {
              // ment
              if (l >= 5 && w[l - 5] === 101) {
                // ement
                if (l >= r2 + 5) l -= 5; // ement
              } else if (l >= r2 + 4) {
                l -= 4; // ment
              }
            } else {
              l -= 3; // ent
            }
          }
        }
        break;
      case 101: // e
        if (w[l - 2] === 99) {
          // ce
          if (l >= r2 + 4 && w[l - 3] === 110 && (w[l - 4] === 97 || w[l - 4] === 101)) l -= 4; // ance  ence
        } else if (w[l - 2] === 108) {
          // le
          if (l >= r2 + 4 && w[l - 3] === 98 && (w[l - 4] === 97 || w[l - 4] === 105)) l -= 4; // able  ible
        } else if (w[l - 2] === 116) {
          // te
          if (l >= r2 + 3 && w[l - 3] === 97) l -= 3; // ate
        } else if (l >= r2 + 3 && (w[l - 2] === 118 || w[l - 2] === 122) && w[l - 3] === 105) {
          // ive ize
          l -= 3; // ive  ize
        }
    }
  }
  // Step_5
  if (
    l >= r1 + 1 && // r1 is >= 1
    ((l >= r2 + 1 && w[l - 1] === 108 && w[l - 2] === 108) || // ll
      (w[l - 1] === 101 && (l >= r2 + 1 || !isShortV(w, l - 1)))) // e
  )
    --l;
  let out = '';
  if (yFound) {
    for (let i = 0; i < l; ++i) {
      out += String.fromCharCode(w[i] === 89 ? 121 : w[i]); // Y -> y
    }
  } else {
    for (let i = 0; i < l; ++i) out += String.fromCharCode(w[i]);
  }
  return out;
};

// #endregion Porter2 Stemmer Algorithm

// src/constants.ts
const DEFAULT_OPTIONS = {
  k1: 1.2,
  b: 0.75,
  minLength: 2,
  stopWords: /* @__PURE__ */ new Set<string>([
    'a',
    'an',
    'and',
    'are',
    'as',
    'at',
    'be',
    'by',
    'for',
    'from',
    'has',
    'he',
    'in',
    'is',
    'it',
    'its',
    'of',
    'on',
    'that',
    'the',
    'to',
    'was',
    'were',
    'will',
    'with',
  ]),
  stemming: false,
  stemWords: (word: string): string => word,
};

/**
 * Interface for tokenization statistics.
 */
interface TokenizationStats {
  /** Number of words in the original text before any processing. */
  originalWordCount: number;
  /** Number of words removed because they were identified as stop words. */
  stopWordsRemoved: number;
  /** Number of words that were stemmed (only if stemming is enabled). */
  stemmedWords: number;
  /** Time taken for tokenization in milliseconds. */
  processingTimeMs: number;
}

/**
 * Interface for the result of tokenization.
 */
interface TokenizationResult {
  /** Array of processed tokens (words). */
  tokens: string[];
  /** Optional statistics about the tokenization process. */
  stats?: TokenizationStats;
}

/**
 * Interface for stemming rules.
 */
interface StemmingRule {
  /** A RegExp pattern or string to match suffixes. */
  pattern: RegExp | string;
  /** The replacement string or function. */
  replacement: string | ((substring: string, ...args: any[]) => string);
  /** Optional minimum measure (complexity) of the word stem for the rule to apply. */
  minMeasure?: number;
}

/**
 * Options for configuring the Tokenizer.
 */
interface TokenizerOptions {
  /** A set of words to be ignored during tokenization. Defaults to an empty set. */
  stopWords?: Set<string>;
  /** The minimum length for a token to be kept. Defaults to 2. Numeric tokens are always kept. */
  minLength?: number;
  /** Whether to apply stemming to tokens. Defaults to false. */
  stemming?: boolean;
  /** Custom stemming rules to apply before the default Porter2 stemmer. Defaults to an empty array. */
  stemmingRules?: StemmingRule[];
}

/**
 * Flexible text tokenizer with support for stop words, minimum token length,
 * Unicode normalization, and optional Porter2 stemming with custom rules.
 */
class Tokenizer {
  /** Set of stop words to ignore. */
  readonly stopWords: Set<string>;
  /** Minimum length of tokens to keep. */
  readonly minLength: number;
  /** Flag indicating if stemming is enabled. */
  readonly stemming: boolean;
  /** Custom stemming rules. */
  readonly stemmingRules: {
    pattern: RegExp;
    replacement: string | ((substring: string, ...args: any[]) => string);
    minMeasure?: number;
  }[];

  /** Default options for the Tokenizer. */
  static readonly DEFAULT_OPTIONS: Required<TokenizerOptions> = {
    stopWords: /* @__PURE__ */ new Set<string>(),
    minLength: 2,
    stemming: false,
    stemmingRules: [],
  };

  /**
   * Creates a new tokenizer instance.
   * @param options - Tokenization options including stop words, min length, stemming, and custom rules.
   */
  constructor(options: TokenizerOptions = {}) {
    const mergedOptions = { ...Tokenizer.DEFAULT_OPTIONS, ...options };
    this.stopWords = mergedOptions.stopWords;
    this.minLength = mergedOptions.minLength;
    this.stemming = mergedOptions.stemming;
    // Ensure all rule patterns are RegExp objects
    this.stemmingRules = mergedOptions.stemmingRules.map((rule) => ({
      ...rule,
      pattern: typeof rule.pattern === 'string' ? new RegExp(rule.pattern) : rule.pattern,
    }));
  }

  /**
   * Tokenizes input text into an array of processed terms.
   * Steps:
   * 1. Cleans the text (lowercase, normalize, remove punctuation/symbols).
   * 2. Splits the text into potential tokens.
   * 3. Filters tokens based on `minLength` and `stopWords`.
   * 4. Applies stemming if `stemming` is true (custom rules first, then Porter2).
   * 5. Optionally calculates statistics.
   *
   * @param text - The input text string to tokenize.
   * @param includeStats - If true, returns tokenization statistics along with tokens. Defaults to false.
   * @returns A `TokenizationResult` object containing the array of tokens and optional stats.
   * @throws {Error} If the input text is null, undefined, or empty.
   */
  tokenize(text: string, includeStats = false): TokenizationResult {
    if (!text) {
      throw new Error('Input text cannot be null or empty');
    }
    const startTime = Date.now();
    const originalWords = text.split(/\s+/).filter((word) => word.length > 0);
    const cleaned = this.cleanText(text);
    const tokens = cleaned
      .split(/\s+/)
      .filter((token) => this.isValidToken(token))
      .map((token) => (this.stemming ? this.stemWord(token) : token));
    const stats: TokenizationStats = includeStats
      ? {
          originalWordCount: originalWords.length,
          stopWordsRemoved: originalWords.length - tokens.length, // This might be incorrect if stemming changes token count
          stemmedWords: this.stemming ? tokens.length : 0,
          processingTimeMs: Date.now() - startTime,
        }
      : {
          originalWordCount: 0,
          stopWordsRemoved: 0,
          stemmedWords: 0,
          processingTimeMs: 0,
        };
    return { tokens, stats };
  }

  /**
   * Cleans and normalizes text for tokenization.
   * - Converts to lowercase.
   * - Normalizes Unicode characters (NFKD).
   * - Removes control characters and zero-width spaces.
   * - Removes diacritical marks (accents).
   * - Removes emojis and pictographs.
   * - Removes common symbols (™, ®, ©, ℠, ‼).
   * - Replaces Unicode punctuation with spaces.
   * - Removes characters not matching basic Latin, CJK, Hangul, or whitespace.
   * - Collapses multiple spaces into single spaces.
   * - Trims leading/trailing whitespace.
   *
   * @param text - Input text to clean.
   * @returns Cleaned and normalized text, ready for splitting into tokens.
   *
   * @example
   * cleanText("Hello, World™!") // "hello world"
   * cleanText("héllo 👋") // "hello"
   * cleanText("Hello 世界!") // "hello 世界"
   * cleanText("I'm don't") // "i'm don't" (apostrophes kept by replacing punctuation with space)
   * cleanText("test©2023") // "test 2023"
   */
  cleanText(text: string): string {
    return text
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200D\uFEFF]/g, '') // Control characters & zero-width spaces
      .replace(/[\u0300-\u036f]/g, '') // Diacritical marks
      .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, '') // Emojis and pictographs
      .replace(/[™®©℠‼]/g, '') // Common symbols
      .replace(/[\p{P}]/gu, ' ') // Unicode punctuation to space
      .replace(/[^a-z0-9\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\s]/gu, ' ') // Keep only latin, cjk, hangul, numbers, whitespace
      .replace(/\s+/g, ' ') // Collapse multiple spaces
      .trim();
  }

  /**
   * Checks if a token is valid (meets `minLength` criteria and is not a stop word).
   * Numeric tokens are always considered valid regardless of length.
   * @param token - The token string to validate.
   * @returns `true` if the token is valid, `false` otherwise.
   */
  isValidToken(token: string): boolean {
    const isNumeric = /^\d+$/.test(token);
    return (token.length >= this.minLength || isNumeric) && !this.stopWords.has(token);
  }

  /**
   * Applies stemming to a single word.
   * First, tries to apply custom stemming rules defined in `stemmingRules`.
   * If no custom rule matches, applies the default Porter2 stemming algorithm.
   * Words shorter than 3 characters are not stemmed.
   * @param word - The word to stem.
   * @returns The stemmed word.
   */
  stemWord(word: string): string {
    if (word.length < 3) return word;
    let customRuleApplied = false;
    let stemmed = word;
    for (const rule of this.stemmingRules) {
      const match = stemmed.match(rule.pattern);
      if (match) {
        if (
          !rule.minMeasure ||
          this.measure(stemmed.substring(0, match.index)) >= rule.minMeasure
        ) {
          // Apply replacement
          if (typeof rule.replacement === 'string') {
            stemmed = stemmed.replace(rule.pattern, rule.replacement);
          } else {
            // If replacement is a function, it might need more specific arguments based on its definition.
            // Assuming it takes the matched substring and potentially other match groups.
            stemmed = stemmed.replace(rule.pattern, (...args) =>
              (rule.replacement as Function)(...args)
            );
          }
          customRuleApplied = true; // Mark that a custom rule was (potentially) applied
          // Depending on stemming strategy, might want to break or continue applying rules
        }
      }
    }
    // If a custom rule was applied and modified the word, return it.
    // Otherwise, or if custom rules are meant to precede default stemming, apply Porter2.
    if (customRuleApplied && stemmed !== word) return stemmed; // Return if custom rule changed the word

    // Fallback to Porter2 if no custom rule applied or if custom rules are pre-processing
    return stem(stemmed); // Apply Porter2 to the (potentially already custom-stemmed) word
  }

  /**
   * Checks if the character at a given index in a word is a consonant.
   * Treats 'y' as a consonant if it's the first letter or follows a consonant.
   * @param word - The word string.
   * @param i - The index of the character to check.
   * @returns `true` if the character is a consonant, `false` otherwise.
   */
  isConsonant(word: string, i: number): boolean {
    const char = word[i];
    if ('aeiou'.includes(char)) return false;
    return char !== 'y' || (i === 0 ? true : !this.isConsonant(word, i - 1));
  }

  /**
   * Calculates the "measure" of a word stem (approximates syllable count).
   * The measure (m) is the number of times a sequence of vowels is followed by a
   * sequence of consonants (VC). Used in some stemming rules.
   * Example: measure("tree") = 0, measure("trouble") = 1, measure("private") = 2
   * @param word - The word (or stem) to measure.
   * @returns The measure (m) of the word.
   */
  measure(word: string): number {
    let m = 0;
    let vowelSeen = false;
    for (let i = 0; i < word.length; i++) {
      if (this.isConsonant(word, i)) {
        if (vowelSeen) {
          m++;
          vowelSeen = false;
        }
      } else {
        vowelSeen = true;
      }
    }
    return m;
  }
}

/**
 * BM25 Options Interface.
 * Extends TokenizerOptions and adds BM25 specific parameters.
 */
interface BM25Options extends TokenizerOptions {
  /**
   * Term frequency saturation parameter (k1). Controls how quickly term frequency
   * saturates. Higher values mean TF contributes more significantly even for high counts.
   * Typical values are between 1.2 and 2.0. Default: 1.2.
   */
  k1?: number;
  /**
   * Document length normalization parameter (b). Controls the influence of document
   * length. 0 means no length normalization, 1 means full normalization.
   * Typical values are around 0.75. Default: 0.75.
   */
  b?: number;
  /**
   * A dictionary defining boost factors for specific document fields.
   * Terms found in fields with higher boost factors will contribute more to the score.
   * Example: `{ title: 2, body: 1 }`. Default: `{}` (no boosts).
   */
  fieldBoosts?: { [key: string]: number };
}

/**
 * Represents a search result item.
 */
interface SearchResult {
  /** The index of the matching document in the original document array. */
  index: number;
  /** The BM25 relevance score for the document. Higher scores indicate better relevance. */
  score: number;
  /** The actual document object (optional, depends on how results are retrieved). */
  doc?: any; // Consider using a generic <T> for BM25 class if docs are typed
}

/**
 * Implements the Okapi BM25 (Best Matching 25) ranking function for information retrieval.
 *
 * BM25 ranks documents based on the query terms appearing in each document,
 * considering term frequency (TF) and inverse document frequency (IDF).
 * It improves upon basic TF-IDF by incorporating:
 * - Term Frequency Saturation (k1): Prevents overly frequent terms from dominating the score.
 * - Document Length Normalization (b): Penalizes documents that are longer than average,
 *   assuming longer documents are more likely to contain query terms by chance.
 *
 * Key Components:
 * - Tokenizer: Processes text into terms (words), handles stop words and stemming.
 * - Document Indexing: Stores document lengths, term frequencies per document,
 *   and overall document frequency for each term.
 * - IDF Calculation: Measures the informativeness of a term based on how many documents contain it.
 * - Scoring: Combines TF, IDF, document length, and parameters k1/b to calculate relevance.
 */
export class BM25 {
  /** Term frequency saturation parameter (k1). */
  readonly termFrequencySaturation: number; // k1
  /** Document length normalization factor (b). */
  readonly lengthNormalizationFactor: number; // b
  /** Tokenizer instance used for processing text. */
  readonly tokenizer: Tokenizer;
  /** Array storing the length (number of tokens, adjusted by field boosts) of each document. */
  documentLengths: Uint32Array;
  /** Average length of all documents in the index. */
  averageDocLength: number;
  /** Map from term (string) to its unique integer index. */
  termToIndex: Map<string, number>;
  /** Array storing the document frequency (number of docs containing the term) for each term index. */
  documentFrequency: Uint32Array; // DF for each term index
  /** Map from term index to another map storing `docIndex: termFrequencyInDoc`. */
  termFrequencies: Map<number, Map<number, number>>; // TermIndex -> { DocIndex -> TF }
  /** Boost factors for different fields within documents. */
  readonly fieldBoosts: { [key: string]: number };
  /** Array storing the original documents added to the index. */
  documents: any[]; // Consider using a generic <T>

  /**
   * Creates a new BM25 search instance.
   * @param docs - Optional array of initial documents (objects with string fields) to index.
   * @param options - Configuration options for BM25 parameters (k1, b), tokenizer (stopWords, stemming, minLength), and field boosts.
   */
  constructor(docs?: any[], options: BM25Options = {}) {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    this.termFrequencySaturation = opts.k1!; // Non-null assertion as DEFAULT_OPTIONS provides it
    this.lengthNormalizationFactor = opts.b!; // Non-null assertion
    this.tokenizer = new Tokenizer(opts);
    this.fieldBoosts = opts.fieldBoosts || {};

    // Initialize index structures
    this.documents = [];
    this.documentLengths = new Uint32Array(0);
    this.termToIndex = new Map<string, number>();
    this.documentFrequency = new Uint32Array(0); // Will be sized later
    this.averageDocLength = 0;
    this.termFrequencies = new Map<number, Map<number, number>>(); // TermIndex -> { DocIndex -> TF }

    // Index initial documents if provided
    if (docs && docs.length > 0) {
      this.documents = [...docs]; // Store original documents
      const { documentLengths, termToIndex, documentFrequency, averageDocLength, termFrequencies } =
        this.processDocuments(docs);
      // Assign processed data to instance properties
      this.documentLengths = documentLengths;
      this.termToIndex = termToIndex;
      this.documentFrequency = documentFrequency;
      this.averageDocLength = averageDocLength;
      this.termFrequencies = termFrequencies;
    }
  }

  /**
   * Processes an array of documents to build the initial index structures.
   * Calculates document lengths, term frequencies, document frequencies, and average document length.
   * @param docs - Array of documents to process.
   * @returns An object containing the calculated index data.
   * @internal
   */
  private processDocuments(docs: any[]): {
    documentLengths: Uint32Array;
    termToIndex: Map<string, number>;
    documentFrequency: Uint32Array;
    averageDocLength: number;
    termFrequencies: Map<number, Map<number, number>>;
  } {
    const numDocs = docs.length;
    const documentLengths = new Uint32Array(numDocs);
    const termToIndex = new Map<string, number>();
    const termDocs = new Map<string, Set<number>>(); // Temp map: Term -> Set<DocIndex>
    const termFrequencies = new Map<number, Map<number, number>>(); // TermIndex -> { DocIndex -> TF }
    let totalDocLength = 0;
    let nextTermIndex = 0;

    docs.forEach((doc, docIndex) => {
      let currentDocLength = 0;
      const docTermFrequencies = new Map<number, number>(); // TermIndex -> TF for this doc

      // Iterate through fields of the document
      Object.entries(doc).forEach(([field, content]) => {
        if (typeof content !== 'string') return; // Skip non-string fields

        const fieldBoost = this.fieldBoosts[field] || 1;
        const { tokens } = this.tokenizer.tokenize(content);
        const fieldLength = tokens.length * fieldBoost;
        currentDocLength += fieldLength;

        // Calculate term frequencies within this field/doc
        tokens.forEach((term) => {
          // Assign index to new terms
          if (!termToIndex.has(term)) {
            termToIndex.set(term, nextTermIndex++);
          }
          const termIndexVal = termToIndex.get(term)!;

          // Track which documents contain the term
          if (!termDocs.has(term)) {
            termDocs.set(term, new Set<number>());
          }
          termDocs.get(term)!.add(docIndex);

          // Increment frequency for this term in this document
          const currentFreq = docTermFrequencies.get(termIndexVal) || 0;
          docTermFrequencies.set(termIndexVal, currentFreq + fieldBoost); // TF weighted by boost
        });
      });

      // Store the calculated length for this document
      documentLengths[docIndex] = currentDocLength;
      totalDocLength += currentDocLength;

      // Merge this document's term frequencies into the main structure
      docTermFrequencies.forEach((freq, termIndexVal) => {
        if (!termFrequencies.has(termIndexVal)) {
          termFrequencies.set(termIndexVal, new Map<number, number>());
        }
        termFrequencies.get(termIndexVal)!.set(docIndex, freq);
      });
    });

    // Calculate document frequency (DF) for each term
    const documentFrequency = new Uint32Array(termToIndex.size);
    termDocs.forEach((docsSet, term) => {
      const termIndexVal = termToIndex.get(term)!;
      documentFrequency[termIndexVal] = docsSet.size;
    });

    return {
      documentLengths,
      termToIndex,
      documentFrequency,
      averageDocLength: numDocs > 0 ? totalDocLength / numDocs : 0,
      termFrequencies,
    };
  }

  /**
   * Recalculates the average document length based on the current `documentLengths`.
   * @internal
   */
  private recalculateAverageLength(): void {
    if (this.documentLengths.length === 0) {
      this.averageDocLength = 0;
      return;
    }
    // Use Array.prototype.reduce for compatibility, though typed array reduce might be faster
    const totalLength = Array.prototype.reduce.call(
      this.documentLengths,
      (sum: number, len: number) => sum + len,
      0
    );
    this.averageDocLength = totalLength / this.documentLengths.length;
  }

  /**
   * Searches the indexed documents for a given query string using the BM25 ranking formula.
   *
   * @param query - The search query text.
   * @param topK - The maximum number of top-scoring results to return. Defaults to 10.
   * @returns An array of `SearchResult` objects, sorted by descending BM25 score.
   */
  search(query: string, topK = 10): SearchResult[] {
    const { tokens: queryTokens } = this.tokenizer.tokenize(query); // Tokenize the query
    const scores = new Float32Array(this.documentLengths.length).fill(0); // Initialize scores to 0

    // Accumulate scores for each document based on query terms
    queryTokens.forEach((term) => {
      const termIndex = this.termToIndex.get(term);
      // Ignore terms not found in the index
      if (termIndex === undefined) return;

      const idf = this.calculateIdf(termIndex);
      // Skip terms with non-positive IDF (e.g., term in all docs)
      if (idf <= 0) return;

      const termFreqsInDocs = this.termFrequencies.get(termIndex); // Map<DocIndex, TF>
      if (!termFreqsInDocs) return; // Should not happen if termIndex exists, but check anyway

      // Iterate over documents containing this term
      termFreqsInDocs.forEach((tf, docIndex) => {
        const docLength = this.documentLengths[docIndex];

        // --- BM25 Term Score Calculation ---
        // Normalizes TF based on document length and saturation parameters.
        const numerator = tf * (this.termFrequencySaturation + 1);
        const denominator =
          tf +
          this.termFrequencySaturation *
            (1 -
              this.lengthNormalizationFactor +
              (this.lengthNormalizationFactor * docLength) / this.averageDocLength);

        // Add the weighted score (IDF * normalized TF) for this term to the document's total score
        scores[docIndex] += idf * (numerator / denominator);
      });
    });

    // --- Result Generation ---
    // Create result objects, filter out zero scores, sort, and take top K
    return Array.from({ length: scores.length }, (_, i) => ({
      index: i,
      score: scores[i],
      // Optionally add: doc: this.getDocument(i) // If you want the full doc in results
    }))
      .filter((result) => result.score > 0) // Keep only documents with positive scores
      .sort((a, b) => b.score - a.score) // Sort by score descending
      .slice(0, topK); // Limit to topK results
  }

  /**
   * Searches for an exact phrase within the indexed documents.
   * Ranks documents containing the exact sequence of tokens higher.
   * Note: This is a basic implementation. More sophisticated phrase search might consider proximity.
   *
   * @param phrase - The exact phrase to search for.
   * @param topK - The maximum number of results to return. Defaults to 10.
   * @returns An array of `SearchResult` objects, sorted by score, for documents containing the phrase.
   */
  searchPhrase(phrase: string, topK = 10): SearchResult[] {
    const { tokens: phraseTokens } = this.tokenizer.tokenize(phrase); // Tokenize the phrase
    if (phraseTokens.length === 0) return []; // Cannot search for empty phrase

    // --- Find Candidate Documents ---
    // Start with documents containing the *first* term, then intersect with subsequent terms.
    let candidateDocs: Set<number> | null = null;

    for (const term of phraseTokens) {
      const termIndex = this.termToIndex.get(term);
      if (termIndex === undefined) return []; // Phrase cannot exist if any term is missing

      const docsContainingTermIter = this.termFrequencies.get(termIndex)?.keys();
      if (!docsContainingTermIter) return []; // Should not happen, but check

      const currentTermDocs = new Set(docsContainingTermIter);

      if (candidateDocs === null) {
        // First term initializes the candidates
        candidateDocs = currentTermDocs;
      } else {
        // Intersect: Keep only documents present in both sets
        candidateDocs = new Set([...candidateDocs].filter((docIdx) => currentTermDocs.has(docIdx)));
      }

      // If intersection becomes empty, the phrase cannot exist
      if (candidateDocs.size === 0) return [];
    }

    if (candidateDocs === null || candidateDocs.size === 0) return []; // No candidates found

    // --- Verify Phrase Occurrence and Score ---
    const scores = new Map<number, number>(); // Map<DocIndex, Score>

    candidateDocs.forEach((docIndex) => {
      const doc = this.getDocument(docIndex); // Get the original document content
      let phraseFoundInDoc = false;

      // Check each field for the phrase
      Object.entries(doc).forEach(([field, content]) => {
        if (typeof content !== 'string' || phraseFoundInDoc) return; // Skip non-strings or if already found

        const fieldBoost = this.fieldBoosts[field] || 1;
        // Tokenize the field content using the same settings
        const { tokens: docTokens } = this.tokenizer.tokenize(content);

        // Simple sliding window check for the exact phrase sequence
        for (let i = 0; i <= docTokens.length - phraseTokens.length; i++) {
          let match = true;
          for (let j = 0; j < phraseTokens.length; j++) {
            if (docTokens[i + j] !== phraseTokens[j]) {
              match = false;
              break;
            }
          }
          if (match) {
            // Phrase found! Calculate score for this document based on the phrase terms
            const phraseScoreVal = this.calculatePhraseScore(phraseTokens, docIndex) * fieldBoost;
            scores.set(docIndex, (scores.get(docIndex) || 0) + phraseScoreVal);
            phraseFoundInDoc = true; // Only score once per doc even if phrase repeats
            break; // Move to next document once found in this one
          }
        }
      });
    });

    // --- Format and Sort Results ---
    return Array.from(scores.entries())
      .map(([index, score]) => ({ index, score }))
      .sort((a, b) => b.score - a.score) // Sort by score descending
      .slice(0, topK); // Limit results
  }

  /**
   * Calculates a BM25-like score for a sequence of phrase tokens within a specific document.
   * Sums the individual BM25 scores of the terms in the phrase for that document.
   * @param phraseTokens - The tokenized phrase.
   * @param docIndex - The index of the document to score against.
   * @returns The calculated phrase score for the document.
   * @internal
   */
  private calculatePhraseScore(phraseTokens: string[], docIndex: number): number {
    return phraseTokens.reduce((currentScore, term) => {
      const termIndex = this.termToIndex.get(term);
      // Ignore terms not in index (shouldn't happen if candidate selection worked)
      if (termIndex === undefined) return currentScore;

      const idf = this.calculateIdf(termIndex);
      const tf = this.termFrequencies.get(termIndex)?.get(docIndex) || 0;
      const docLength = this.documentLengths[docIndex];

      // Calculate the BM25 contribution of this single term
      const numerator = tf * (this.termFrequencySaturation + 1);
      const denominator =
        tf +
        this.termFrequencySaturation *
          (1 -
            this.lengthNormalizationFactor +
            (this.lengthNormalizationFactor * docLength) / this.averageDocLength);

      // Add IDF * normalized TF to the total phrase score
      return currentScore + idf * (numerator / denominator);
    }, 0); // Start score at 0
  }

  /**
   * Adds a single new document to the index.
   * Updates all internal index structures incrementally.
   * Note: For adding many documents, `addDocumentsParallel` is generally more efficient.
   *
   * @param doc - The document object (with string fields) to add.
   * @throws {Error} If the document is null or undefined.
   */
  async addDocument(doc: any): Promise<void> {
    if (!doc) throw new Error('Document cannot be null');

    const docIndex = this.documentLengths.length; // Index for the new document

    // --- Update Document List and Lengths ---
    this.documents.push(doc);
    // Resize documentLengths array (simple append)
    const newDocLengths = new Uint32Array(docIndex + 1);
    newDocLengths.set(this.documentLengths, 0); // Copy old lengths
    // Calculate length later...
    this.documentLengths = newDocLengths; // Assign temporarily

    let currentDocLength = 0;
    const docTermFrequencies = new Map<number, number>(); // TermIndex -> TF for this new doc

    // --- Process Fields and Tokens ---
    Object.entries(doc).forEach(([field, content]) => {
      if (typeof content !== 'string') return;

      const fieldBoost = this.fieldBoosts[field] || 1;
      const { tokens } = this.tokenizer.tokenize(content);
      currentDocLength += tokens.length * fieldBoost;

      // Process each token in the field
      tokens.forEach((term) => {
        let termIndexVal: number;
        // Add term to index if new
        if (!this.termToIndex.has(term)) {
          termIndexVal = this.termToIndex.size;
          this.termToIndex.set(term, termIndexVal);

          // Ensure documentFrequency array is large enough
          if (this.documentFrequency.length <= termIndexVal) {
            const oldDf = this.documentFrequency;
            // Grow exponentially, ensure it's at least termIndex + 1
            const newSize = Math.max(termIndexVal + 1, oldDf.length * 2 || 1); // Ensure newSize is at least 1 if oldDf.length is 0
            this.documentFrequency = new Uint32Array(newSize);
            this.documentFrequency.set(oldDf, 0);
          }
          // Initialize DF for new term (will be incremented below)
          this.documentFrequency[termIndexVal] = 0;
        } else {
          termIndexVal = this.termToIndex.get(term)!;
        }

        // Increment frequency for this term in this new document
        const currentFreq = docTermFrequencies.get(termIndexVal) || 0;
        docTermFrequencies.set(termIndexVal, currentFreq + fieldBoost); // Weighted TF
      });
    });

    // --- Update Global Structures ---
    // Set the calculated length for the new document
    this.documentLengths[docIndex] = currentDocLength;

    // Add this document's term frequencies to the main map and update DF
    docTermFrequencies.forEach((freq, termIndexVal) => {
      // Add TF entry
      if (!this.termFrequencies.has(termIndexVal)) {
        this.termFrequencies.set(termIndexVal, new Map<number, number>());
      }
      this.termFrequencies.get(termIndexVal)!.set(docIndex, freq);

      // Increment document frequency for the term
      // Ensure termIndexVal is within bounds of documentFrequency before incrementing
      if (termIndexVal < this.documentFrequency.length) {
        this.documentFrequency[termIndexVal]++;
      } else {
        // This case should ideally not be reached if array was resized correctly
        console.error(
          `Error: termIndexVal ${termIndexVal} is out of bounds for documentFrequency (length ${this.documentFrequency.length}). This indicates an issue with array resizing or term indexing.`
        );
      }
    });

    // Recalculate average document length
    this.recalculateAverageLength(); // Efficiently update average
  }

  /**
   * Calculates the Inverse Document Frequency (IDF) for a given term index.
   * Uses the BM25 IDF formula: log(1 + (N - n + 0.5) / (n + 0.5))
   * where N is the total number of documents and n is the number of documents
   * containing the term. The +1 smooths the logarithm.
   *
   * @param termIndex - The integer index of the term.
   * @returns The IDF score for the term. Returns 0 if the term is not found or has 0 DF.
   */
  calculateIdf(termIndex: number): number {
    // Ensure termIndex is valid
    if (termIndex < 0 || termIndex >= this.documentFrequency.length) {
      return 0; // Term not in index or index out of bounds
    }

    const docFreq = this.documentFrequency[termIndex]; // n: number of docs containing the term
    // If term appears in 0 documents or more docs than exist (error state), return 0 IDF.
    if (docFreq <= 0 || docFreq > this.documentLengths.length) {
      return 0;
    }

    const N = this.documentLengths.length; // Total number of documents
    const numerator = N - docFreq + 0.5;
    const denominator = docFreq + 0.5;

    // Adding 1 inside the log ensures IDF is always non-negative.
    return Math.log(1 + numerator / denominator);
  }

  /**
   * Retrieves the term frequency (TF) for a specific term in a specific document.
   * @param termIndex - The integer index of the term.
   * @param docIndex - The index of the document.
   * @returns The term frequency, or 0 if the term is not in the document or indices are invalid.
   */
  getTermFrequency(termIndex: number, docIndex: number): number {
    return this.termFrequencies.get(termIndex)?.get(docIndex) || 0;
  }

  /**
   * Retrieves the original document object stored at a given index.
   * @param index - The index of the document to retrieve.
   * @returns The document object.
   * @throws {Error} If the index is out of bounds.
   */
  getDocument(index: number): any {
    // Consider using a generic <T>
    if (index < 0 || index >= this.documents.length) {
      throw new Error(`Document index ${index} out of bounds (0-${this.documents.length - 1})`);
    }
    return this.documents[index];
  }

  /**
   * Clears all indexed documents and resets the BM25 instance to its initial state.
   */
  clearDocuments(): void {
    this.documents = [];
    this.documentLengths = new Uint32Array(0);
    this.termToIndex.clear();
    this.documentFrequency = new Uint32Array(0);
    this.averageDocLength = 0;
    this.termFrequencies.clear();
  }

  /**
   * Gets the total number of documents currently indexed.
   * @returns The document count.
   */
  getDocumentCount(): number {
    return this.documents.length;
  }

  /**
   * Adds multiple documents sequentially by calling `addDocument` for each.
   * This method processes documents sequentially in the main thread.
   * @param docs - An array of documents to add.
   */
  async addDocuments(docs: any[]): Promise<void[]> {
    // Allow Promise<void> return type
    // Using Promise.all to potentially run additions concurrently if addDocument becomes async
    // Although the current addDocument is sync, this structure allows future flexibility.
    return Promise.all(docs.map((doc) => this.addDocument(doc)));
    // Note: If addDocument remains purely synchronous, a simple forEach would also work:
    // docs.forEach(doc => this.addDocument(doc));
  }
}
