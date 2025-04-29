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

// import { Worker } from 'worker_threads'; // REMOVE STATIC IMPORT
// import os from 'os'; // REMOVE STATIC IMPORT

// #region Porter2 Stemmer Helper Functions

/**
 * Checks if the character code represents a vowel (a, e, i, o, u, y).
 * @param char - The character code.
 * @returns True if the character is a vowel, false otherwise.
 */
const is_v = (char: number) => {
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
const is_wxy = (char: number) => {
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
const is_valid_li = (char: number) => {
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
const is_double = (char: number) => {
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
const is_shortv = (w: number[], len: number) => {
  // backwardmode: ( non-v_WXY v non-v ) or ( non-v v atlimit )
  return (
    len >= 2 &&
    is_v(w[len - 2]) &&
    ((len === 2 && !is_v(w[len - 1])) || (len >= 3 && !is_v(w[len - 3]) && !is_wxy(w[len - 1])))
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
const stem = (word: string) => {
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
  var initial_offset = word.charCodeAt(0) === 39 /* ' */ ? 1 : 0;
  var l = word.length - initial_offset;
  var w = new Array(l);
  var y_found = false;
  for (var i = 0; i < l; ++i) {
    // var ch = word[i + initial_offset]
    var ch = word.charCodeAt(i + initial_offset);
    if (ch === 121 && (i === 0 || is_v(w[i - 1]))) {
      y_found = true;
      w[i] = 89;
      continue;
    }
    w[i] = ch;
  }
  if (w[l - 1] === 39) --l;
  if (l >= 2 && w[l - 2] === 39 && w[l - 1] === 115) l -= 2;
  // mark_regions
  var rv = 0;
  // rv is the position after the first vowel
  while (rv < l && !is_v(w[rv])) ++rv;
  if (rv < l) ++rv;
  var r1 = rv;
  if (
    l >= 5 &&
    ((w[0] === 103 && w[1] === 101 && w[2] === 110 && w[3] === 101 && w[4] === 114) ||
      (w[0] === 97 && w[1] === 114 && w[2] === 115 && w[3] === 101 && w[4] === 110))
  )
    r1 = 5;
  else if (
    l >= 6 &&
    w[0] === 99 &&
    w[1] === 111 &&
    w[2] === 109 &&
    w[3] === 109 &&
    w[4] === 117 &&
    w[5] === 110
  )
    r1 = 6;
  else {
    // > R1 is the region after the first non-vowel following a vowel,
    // > or the end of the word if there is no such non-vowel.
    while (r1 < l && is_v(w[r1])) ++r1;
    if (r1 < l) ++r1;
  }
  // > R2 is the region after the first non-vowel following a vowel in R1,
  // > or the end of the word if there is no such non-vowel.
  var r2 = r1;
  var found_v = false;
  while (r2 < l && !is_v(w[r2])) ++r2;
  while (r2 < l && is_v(w[r2])) ++r2;
  if (r2 < l) ++r2;
  // Step_1a
  if (l >= 3) {
    if (w[l - 1] === 115) {
      if (l >= 4 && w[l - 2] === 101 && w[l - 3] === 115 && w[l - 4] === 115)
        l -= 2; // sses -> ss
      else if (w[l - 2] === 101 && w[l - 3] === 105)
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
      ((w[0] === 105 &&
        w[1] === 110 &&
        w[2] === 110 &&
        w[3] === 105 &&
        w[4] === 110 &&
        w[5] === 103) ||
        (w[0] === 111 &&
          w[1] === 117 &&
          w[2] === 116 &&
          w[3] === 105 &&
          w[4] === 110 &&
          w[5] === 103) ||
        (w[0] === 101 &&
          w[1] === 120 &&
          w[2] === 99 &&
          w[3] === 101 &&
          w[4] === 101 &&
          w[5] === 100))) ||
    (l === 7 &&
      ((w[0] === 99 &&
        w[1] === 97 &&
        w[2] === 110 &&
        w[3] === 110 &&
        w[4] === 105 &&
        w[5] === 110 &&
        w[6] === 103) ||
        (w[0] === 104 &&
          w[1] === 101 &&
          w[2] === 114 &&
          w[3] === 114 &&
          w[4] === 105 &&
          w[5] === 110 &&
          w[6] === 103) ||
        (w[0] === 101 &&
          w[1] === 97 &&
          w[2] === 114 &&
          w[3] === 114 &&
          w[4] === 105 &&
          w[5] === 110 &&
          w[6] === 103) ||
        (w[0] === 112 &&
          w[1] === 114 &&
          w[2] === 111 &&
          w[3] === 99 &&
          w[4] === 101 &&
          w[5] === 101 &&
          w[6] === 100) ||
        (w[0] === 115 &&
          w[1] === 117 &&
          w[2] === 99 &&
          w[3] === 99 &&
          w[4] === 101 &&
          w[5] === 101 &&
          w[6] === 100)))
  ) {
    var exp2_out = '';
    for (var i = 0; i < l; ++i)
      // exp2_out += w[i]
      exp2_out += String.fromCharCode(w[i]);
    return exp2_out;
  }
  // Step_1b
  var ll =
    // l (length) without the -ly ending
    l >= 2 && w[l - 1] === 121 && w[l - 2] === 108 ? l - 2 : l;
  if (ll >= 3) {
    if (w[ll - 3] === 101 && w[ll - 2] === 101 && w[ll - 1] === 100) {
      if (ll >= r1 + 3) l = ll - 1; // eed eedly -> ee (if in R1)
    } else {
      // ll without: ed edly ing ingly (-1 if not found)
      if (w[ll - 2] === 101 && w[ll - 1] === 100) ll -= 2;
      else if (w[ll - 3] === 105 && w[ll - 2] === 110 && w[ll - 1] === 103) ll -= 3;
      else ll = -1;
      if (ll >= 0 && rv <= ll) {
        l = ll;
        if (l >= 2) {
          if (
            (w[l - 1] === 116 && w[l - 2] === 97) ||
            (w[l - 1] === 108 && w[l - 2] === 98) ||
            (w[l - 1] === 122 && w[l - 2] === 105)
          ) {
            // at -> ate   bl -> ble   iz -> ize
            w[l] = 101;
            ++l;
          } else if (w[l - 2] === w[l - 1] && is_double(w[l - 1])) {
            --l;
          } else if (r1 >= l && is_shortv(w, l)) {
            // <shortv> -> e
            w[l] = 101;
            ++l;
          }
        }
      }
    }
  }
  // Step_1c
  if (l >= 3 && (w[l - 1] === 89 || w[l - 1] === 121) && !is_v(w[l - 2])) w[l - 1] = 105;
  // Step_2
  if (l >= r1 + 2) {
    switch (w[l - 1]) {
      case 108:
        if (
          l >= r1 + 6 &&
          w[l - 2] === 97 &&
          w[l - 3] === 110 &&
          w[l - 4] === 111 &&
          w[l - 5] === 105 &&
          w[l - 6] === 116
        ) {
          if (l >= 7 && w[l - 7] === 97) {
            if (l >= r1 + 7) {
              // ational -> ate
              l -= 4;
              w[l - 1] = 101;
            }
          } else {
            l -= 2; // tional -> tion
          }
        }
        break;
      case 110:
        if (
          l >= r1 + 5 &&
          w[l - 2] === 111 &&
          w[l - 3] === 105 &&
          w[l - 4] === 116 &&
          w[l - 5] === 97
        ) {
          if (l >= 7 && w[l - 6] === 122 && w[l - 7] === 105) {
            if (l >= r1 + 7) {
              // ization -> ize
              l -= 4;
              w[l - 1] = 101;
            }
          } else {
            // ation -> ate
            l -= 2;
            w[l - 1] = 101;
          }
        }
        break;
      case 114:
        if (l >= r1 + 4) {
          if (w[l - 2] === 101) {
            if (w[l - 3] === 122 && w[l - 4] === 105) --l; // izer -> ize
          } else if (w[l - 2] === 111) {
            if (w[l - 3] === 116 && w[l - 4] === 97) {
              --l;
              w[l - 1] = 101;
            }
          }
        }
        break;
      case 115:
        if (
          l >= r1 + 7 &&
          w[l - 2] === 115 &&
          w[l - 3] === 101 &&
          w[l - 4] === 110 &&
          ((w[l - 5] === 108 && w[l - 6] === 117 && w[l - 7] === 102) ||
            (w[l - 5] === 115 && w[l - 6] === 117 && w[l - 7] === 111) ||
            (w[l - 5] === 101 && w[l - 6] === 118 && w[l - 7] === 105))
        ) {
          l -= 4; // fulness -> ful   ousness -> ous   iveness -> ive
        }
        break;
      case 109:
        if (
          l >= r1 + 5 &&
          w[l - 2] === 115 &&
          w[l - 3] === 105 &&
          w[l - 4] === 108 &&
          w[l - 5] === 97
        )
          l -= 3; // alism -> al
        break;
      case 105:
        if (w[l - 2] === 99) {
          if (l >= r1 + 4 && (w[l - 4] === 101 || w[l - 4] === 97) && w[l - 3] === 110) {
            w[l - 1] = 101; // enci -> ence   anci -> ance
          }
        } else if (w[l - 2] === 103) {
          if (l >= r1 + 3 && l >= 4 && w[l - 2] === 103 && w[l - 3] === 111 && w[l - 4] === 108)
            --l; // ogi -> og (if preceded by l)
        } else if (w[l - 2] === 116) {
          if (l >= r1 + 5 && w[l - 3] === 105) {
            if (w[l - 4] === 108) {
              if (l >= 6 && w[l - 5] === 105 && w[l - 6] === 98) {
                if (l >= r1 + 6) {
                  // biliti -> ble
                  l -= 3;
                  w[l - 2] = 108;
                  w[l - 1] = 101;
                }
              } else if (w[l - 4] === 108 && w[l - 5] === 97) {
                l -= 3; // aliti -> al
              }
            } else if (w[l - 4] === 118 && w[l - 5] === 105) {
              // iviti -> ive
              l -= 2;
              w[l - 1] = 101;
            }
          }
        } else if (w[l - 2] === 108 && l >= 3) {
          if (w[l - 3] === 98) {
            if (l >= 4 && w[l - 4] === 97) {
              if (l >= r1 + 4) w[l - 1] = 101; // abli -> able
            } else if (l >= r1 + 3) {
              w[l - 1] = 101; // bli -> ble
            }
          } else {
            // Remove li
            if (w[l - 3] === 108) {
              if (l >= 5 && w[l - 4] === 117 && w[l - 5] === 102) {
                if (l >= r1 + 5) l -= 2; // fulli -> ful
              } else if (l >= r1 + 4 && w[l - 4] === 97) {
                l -= 2; // alli -> al
              }
            } else if (w[l - 3] === 115) {
              if (l >= 6 && w[l - 4] === 115 && w[l - 5] === 101 && w[l - 6] === 108) {
                if (l >= r1 + 6) l -= 2; // lessli -> less
              } else if (l >= r1 + 5 && w[l - 4] === 117 && w[l - 5] === 111) {
                l -= 2; // ousli -> ous
              }
            } else if (l >= 5 && w[l - 3] === 116 && w[l - 4] === 110 && w[l - 5] === 101) {
              if (l >= r1 + 5) l -= 2; // entli -> ent
            } else if (is_valid_li(w[l - 3])) {
              l -= 2;
            }
          }
        }
    }
  }
  // Step_3
  if (l >= r1 + 3) {
    switch (w[l - 1]) {
      case 108:
        if (w[l - 3] === 99) {
          if (l >= r1 + 4 && w[l - 4] === 105 && w[l - 2] === 97) l -= 2; // ical -> ic
        } else if (w[l - 3] === 102) {
          if (w[l - 2] === 117) l -= 3; // ful -> <delete>
        } else if (w[l - 3] === 110) {
          if (
            l >= r1 + 6 &&
            w[l - 2] === 97 &&
            w[l - 4] === 111 &&
            w[l - 5] === 105 &&
            w[l - 6] === 116
          ) {
            if (l >= 7 && w[l - 7] === 97) {
              if (l >= r1 + 7) {
                // ational -> ate
                l -= 4;
                w[l - 1] = 101;
              }
            } else {
              l -= 2; // tional -> tion
            }
          }
        }
        break;
      case 101:
        if (w[l - 2] === 122) {
          if (l >= r1 + 5 && w[l - 3] === 105 && w[l - 4] === 108 && w[l - 5] === 97) l -= 3; // alize -> al
        } else if (w[l - 2] === 116) {
          if (l >= r1 + 5 && w[l - 3] === 97 && w[l - 4] === 99 && w[l - 5] === 105) l -= 3; // icate -> ic
        } else if (w[l - 2] === 118) {
          if (l >= r2 + 5 && w[l - 3] === 105 && w[l - 4] === 116 && w[l - 5] === 97) l -= 5; // ative -> <delete> (if in R2)
        }
        break;
      case 105:
        if (
          l >= r1 + 5 &&
          w[l - 2] === 116 &&
          w[l - 3] === 105 &&
          w[l - 4] === 99 &&
          w[l - 5] === 105
        )
          l -= 3; // iciti -> ic
        break;
      case 115:
        if (l >= r1 + 4 && w[l - 2] === 115 && w[l - 3] === 101 && w[l - 4] === 110) l -= 4; // ness -> <delete>
    }
  }
  // Step_4
  if (l >= r2 + 2) {
    switch (w[l - 1]) {
      case 110:
        if (
          l >= r2 + 3 &&
          w[l - 2] === 111 &&
          w[l - 3] === 105 &&
          (w[l - 4] === 115 || w[l - 4] === 116)
        )
          l -= 3; // ion -> <delete> (if preceded by s or t)
        break;
      case 108:
        if (w[l - 2] === 97) l -= 2; // al
        break;
      case 114:
        if (w[l - 2] === 101) l -= 2; // er
        break;
      case 99:
        if (w[l - 2] === 105) l -= 2; // ic
        break;
      case 109:
        if (l >= r2 + 3 && w[l - 2] === 115 && w[l - 3] === 105) l -= 3; // ism
        break;
      case 105:
        if (l >= r2 + 3 && w[l - 2] === 116 && w[l - 3] === 105) l -= 3; // iti
        break;
      case 115:
        if (l >= r2 + 3 && w[l - 2] === 117 && w[l - 3] === 111) l -= 3; // ous
        break;
      case 116:
        if (l >= r2 + 3 && w[l - 2] === 110) {
          if (w[l - 3] === 97) {
            l -= 3; // ant
          } else if (w[l - 3] === 101) {
            if (l >= 4 && w[l - 4] === 109) {
              if (l >= 5 && w[l - 5] === 101) {
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
      case 101:
        if (w[l - 2] === 99) {
          if (l >= r2 + 4 && w[l - 3] === 110 && (w[l - 4] === 97 || w[l - 4] === 101)) l -= 4; // ance  ence
        } else if (w[l - 2] === 108) {
          if (l >= r2 + 4 && w[l - 3] === 98 && (w[l - 4] === 97 || w[l - 4] === 105)) l -= 4; // able  ible
        } else if (w[l - 2] === 116) {
          if (l >= r2 + 3 && w[l - 3] === 97) l -= 3; // ate
        } else if (l >= r2 + 3 && (w[l - 2] === 118 || w[l - 2] === 122) && w[l - 3] === 105) {
          l -= 3; // ive  ize
        }
    }
  }
  // Step_5
  if (
    l >= r1 + 1 && // r1 is >= 1
    ((l >= r2 + 1 && w[l - 1] === 108 && w[l - 2] === 108) ||
      (w[l - 1] === 101 && (l >= r2 + 1 || !is_shortv(w, l - 1))))
  )
    --l;
  var out = '';
  if (y_found) {
    for (var i = 0; i < l; ++i) {
      out += String.fromCharCode(w[i] === 89 ? 121 : w[i]);
    }
  } else {
    for (var i = 0; i < l; ++i)
      // out += w[i]
      out += String.fromCharCode(w[i]);
  }
  return out;
};

// #endregion Porter2 Stemmer Algorithm

// src/constants.ts
const DEFAULT_OPTIONS = {
  k1: 1.2,
  b: 0.75,
  minLength: 2,
  stopWords: /* @__PURE__ */ new Set([
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
  stemWords: (word) => word,
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
  stopWords: Set<string>;
  /** Minimum length of tokens to keep. */
  minLength: number;
  /** Flag indicating if stemming is enabled. */
  stemming: boolean;
  /** Custom stemming rules. */
  stemmingRules: {
    pattern: RegExp;
    replacement: string | ((substring: string, ...args: any[]) => string);
    minMeasure?: number;
  }[];

  /** Default options for the Tokenizer. */
  static DEFAULT_OPTIONS: Required<TokenizerOptions> = {
    stopWords: /* @__PURE__ */ new Set(),
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
    const stats = includeStats
      ? {
          originalWordCount: originalWords.length,
          stopWordsRemoved: originalWords.length - tokens.length,
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
      .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200D\uFEFF]/g, '')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, '')
      .replace(/[™®©℠‼]/g, '')
      .replace(/[\p{P}]/gu, ' ')
      .replace(/[^a-z0-9\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\s]/gu, ' ')
      .replace(/\s+/g, ' ')
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
    let customRule = false;
    let stemmed = word;
    for (const rule of this.stemmingRules) {
      const match = stemmed.match(rule.pattern);
      if (match) {
        customRule = true;
        if (!rule.minMeasure || this.measure(stemmed) >= rule.minMeasure) {
          if (typeof rule.replacement === 'string') {
            stemmed = stemmed.replace(rule.pattern, rule.replacement);
          } else {
            stemmed = stemmed.replace(rule.pattern, rule.replacement);
          }
        }
      }
    }
    if (customRule) return stemmed;
    stemmed = stem(stemmed);
    return stemmed;
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
export interface BM25Options extends TokenizerOptions {
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
export interface SearchResult {
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
  termFrequencySaturation: number; // k1
  /** Document length normalization factor (b). */
  lengthNormalizationFactor: number; // b
  /** Tokenizer instance used for processing text. */
  tokenizer: Tokenizer;
  /** Array storing the length (number of tokens, adjusted by field boosts) of each document. */
  documentLengths: Uint32Array;
  /** Average length of all documents in the index. */
  averageDocLength: number;
  /** Map from term (string) to its unique integer index. */
  termToIndex: Map<string, number>;
  /** Array storing the document frequency (number of docs containing the term) for each term index. */
  documentFrequency: Uint32Array; // DF for each term index
  /** Map from term index to another map storing { docIndex: termFrequencyInDoc }. */
  termFrequencies: Map<number, Map<number, number>>; // TermIndex -> { DocIndex -> TF }
  /** Boost factors for different fields within documents. */
  fieldBoosts: { [key: string]: number };
  /** Array storing the original documents added to the index. */
  documents: any[]; // Consider using a generic <T>

  /**
   * Creates a new BM25 search instance.
   * @param docs - Optional array of initial documents (objects with string fields) to index.
   * @param options - Configuration options for BM25 parameters (k1, b), tokenizer (stopWords, stemming, minLength), and field boosts.
   */
  constructor(docs?: any[], options: BM25Options = {}) {
    console.log('*** docs', docs);
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
      console.log('doing indexing');
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
  private processDocuments(docs: any[]) {
    console.log('*** processing documents');
    const numDocs = docs.length;
    const documentLengths = new Uint32Array(numDocs);
    const termToIndex = new Map<string, number>();
    const termDocs = new Map<string, Set<number>>(); // Temp map: Term -> Set<DocIndex>
    const termFrequencies = new Map<number, Map<number, number>>(); // TermIndex -> { DocIndex -> TF }
    let totalLength = 0;
    let nextTermIndex = 0;

    docs.forEach((doc, docIndex) => {
      console.log('*** doc', doc);
      let docLength = 0;
      const docTermFrequencies = new Map<number, number>(); // TermIndex -> TF for this doc

      // Iterate through fields of the document
      Object.entries(doc).forEach(([field, content]) => {
        if (typeof content !== 'string') return; // Skip non-string fields

        const fieldBoost = this.fieldBoosts[field] || 1;
        const { tokens } = this.tokenizer.tokenize(content);
        const fieldLength = tokens.length * fieldBoost;
        docLength += fieldLength;

        // Calculate term frequencies within this field/doc
        tokens.forEach((term) => {
          // Assign index to new terms
          if (!termToIndex.has(term)) {
            termToIndex.set(term, nextTermIndex++);
          }
          const termIndex = termToIndex.get(term)!;

          // Track which documents contain the term
          if (!termDocs.has(term)) {
            termDocs.set(term, new Set<number>());
          }
          termDocs.get(term)!.add(docIndex);

          // Increment frequency for this term in this document
          const currentFreq = docTermFrequencies.get(termIndex) || 0;
          docTermFrequencies.set(termIndex, currentFreq + fieldBoost); // TF weighted by boost
        });
      });

      // Store the calculated length for this document
      documentLengths[docIndex] = docLength;
      totalLength += docLength;

      // Merge this document's term frequencies into the main structure
      docTermFrequencies.forEach((freq, termIndex) => {
        if (!termFrequencies.has(termIndex)) {
          termFrequencies.set(termIndex, new Map<number, number>());
        }
        termFrequencies.get(termIndex)!.set(docIndex, freq);
      });
    });

    // Calculate document frequency (DF) for each term
    const documentFrequency = new Uint32Array(termToIndex.size);
    termDocs.forEach((docsSet, term) => {
      const termIndex = termToIndex.get(term)!;
      documentFrequency[termIndex] = docsSet.size;
    });

    return {
      documentLengths,
      termToIndex,
      documentFrequency,
      averageDocLength: numDocs > 0 ? totalLength / numDocs : 0,
      termFrequencies,
    };
  }

  /**
   * Adds multiple documents to the index using parallel processing with worker threads.
   * This is efficient for adding large batches of documents.
   * @param docs - Array of documents to add.
   * @experimental Worker thread usage might need adjustments based on environment.
   */
  async addDocumentsParallel(docs: any[]) {
    if (!docs || docs.length === 0) return;

    // --- Environment Check ---
    // worker_threads and os are Node.js specific. Throw error in browser environments.
    // Check if we are *not* in a typical Node.js environment
    // const isNode = typeof process === 'object' && process.release?.name === 'node';
    // if (!isNode) {
    //   // Add a check for browser-like environments for extra safety, though lack of Node is the primary indicator
    //   const isBrowserLike = typeof self !== 'undefined' && typeof self.document !== 'undefined';
    //   if (isBrowserLike) {
    //     throw new Error(
    //       '`addDocumentsParallel` is not supported in browser environments. Use `addDocuments` or `addDocument` instead.'
    //     );
    //   } else {
    //     // Environment is not Node.js and not clearly a browser (e.g., Deno, Bun, other workers)
    //     // worker_threads might not be available here either.
    //      throw new Error(
    //        '`addDocumentsParallel` requires a Node.js environment with `worker_threads` support.'
    //      );
    //   }
    // }

    // --- Dynamic Imports for Node.js Environment ---
    // Attempt dynamic import; failure indicates an incompatible environment (non-Node.js, etc.)
    let Worker: typeof import('worker_threads').Worker;
    let os: typeof import('os');
    try {
      // Dynamically import Node.js modules only when needed
      const workerThreads = await import('worker_threads');
      Worker = workerThreads.Worker;
      os = await import('os');
    } catch (e) {
      // Handle potential import errors (e.g., environment where dynamic import fails or module missing)
      console.error(
        'Failed to load Node.js modules for parallel processing (worker_threads, os):',
        e
      );
      throw new Error(
        '`addDocumentsParallel` failed to load required Node.js modules. This method is likely not supported in the current environment (e.g., browser, Deno, Bun worker without --allow-node-builtins).'
      );
    }

    const numWorkers = Math.max(1, Math.floor(os.cpus().length / 2)); // Use half the cores, min 1
    const batchSize = Math.ceil(docs.length / numWorkers);
    const workers: import('worker_threads').Worker[] = []; // Use the imported type

    try {
      // Create worker promises
      const workerPromises = Array.from({ length: numWorkers }, (_, i) => {
        const start = i * batchSize;
        const end = Math.min(start + batchSize, docs.length);
        if (start >= end) return Promise.resolve(null); // Skip if batch is empty

        // Pass necessary context to worker (needs relative path for worker code)
        // Ensure ./worker.js exists relative to the built output of bm25.ts
        const worker = new Worker(new URL('./worker.js', import.meta.url), {
          workerData: {
            docs: docs.slice(start, end),
            tokenizerOptions: {
              // Pass relevant tokenizer config
              stopWords: Array.from(this.tokenizer.stopWords), // Convert Set to Array for serialization
              minLength: this.tokenizer.minLength,
              stemming: this.tokenizer.stemming,
              stemmingRules: this.tokenizer.stemmingRules.map((r) => ({
                ...r,
                pattern: r.pattern.toString(),
              })), // Serialize RegExp
            },
            fieldBoosts: this.fieldBoosts,
            startIndex: this.documents.length + start, // Global start index for this batch
          },
        });

        workers.push(worker);

        return new Promise((resolve, reject) => {
          worker.on('message', (message) => {
            // Rehydrate RegExp patterns
            if (message && message.termFrequencies) {
              // Ensure correct types after dynamic import
              message.termFrequencies = new Map(
                message.termFrequencies.map(
                  ([termIndex, docFreqs]: [number, [number, number][]]) => [
                    termIndex,
                    new Map(docFreqs),
                  ]
                )
              );
            }
            if (message && message.termToIndex) {
              message.termToIndex = new Map(message.termToIndex);
            }
            resolve(message);
          });
          worker.on('error', reject);
          worker.on('exit', (code) => {
            if (code !== 0) reject(new Error(`Worker stopped with exit code ${code}`));
          });
        });
      });

      // Wait for all workers to finish and get results
      const results = (await Promise.all(workerPromises)).filter((r) => r !== null) as any[]; // Filter out empty batches

      // --- Merge results from workers ---
      const originalDocCount = this.documentLengths.length;
      const totalNewDocs = docs.length;

      // Resize documentLengths array
      const newDocLengths = new Uint32Array(originalDocCount + totalNewDocs);
      newDocLengths.set(this.documentLengths, 0); // Copy existing lengths

      // Add new documents to the main list
      this.documents.push(...docs);

      // Merge data from each worker result
      results.forEach((result) => {
        if (!result) return; // Should not happen due to filter, but check anyway

        // Merge document lengths (result.docLengths is Uint32Array)
        // result.startIndex is the global index where this worker's results should start
        newDocLengths.set(result.documentLengths, result.startIndex);

        // Merge termToIndex and termFrequencies
        result.termToIndex.forEach((termIndex: number, term: string) => {
          let globalTermIndex: number;
          if (!this.termToIndex.has(term)) {
            // New term encountered
            globalTermIndex = this.termToIndex.size;
            this.termToIndex.set(term, globalTermIndex);
          } else {
            globalTermIndex = this.termToIndex.get(term)!;
          }

          // Merge frequencies for this term
          const workerTermFreqs = result.termFrequencies.get(termIndex); // This is Map<docIndexOffset, freq>
          if (workerTermFreqs) {
            if (!this.termFrequencies.has(globalTermIndex)) {
              this.termFrequencies.set(globalTermIndex, new Map<number, number>());
            }
            const globalFreqMap = this.termFrequencies.get(globalTermIndex)!;
            // workerDocIndex here is relative to the START of the entire batch `docs`
            // We need the global doc index: result.startIndex + workerDocIndex
            workerTermFreqs.forEach((freq: number, workerDocIndex: number) => {
              globalFreqMap.set(workerDocIndex, freq); // workerDocIndex is already the global index from worker
            });
          }
        });
      });

      this.documentLengths = newDocLengths;

      // Update global statistics
      this.updateDocumentFrequency(); // Recalculate DF based on merged termFrequencies
      this.recalculateAverageLength(); // Recalculate average length
    } finally {
      // Ensure all workers are terminated
      workers.forEach((worker) => worker.terminate());
    }
  }

  /**
   * Recalculates the document frequency (DF) for all terms based on the current `termFrequencies`.
   * Requires resizing the `documentFrequency` array if new terms were added.
   * @internal
   */
  private updateDocumentFrequency() {
    const newSize = this.termToIndex.size;
    // Resize if necessary, preserving existing values
    if (this.documentFrequency.length < newSize) {
      const oldDf = this.documentFrequency;
      this.documentFrequency = new Uint32Array(Math.max(newSize, oldDf.length * 2)); // Grow exponentially
      this.documentFrequency.set(oldDf, 0);
    } else if (this.documentFrequency.length > newSize) {
      // This might happen if documents were removed (not implemented yet)
      // For now, we just use the needed size. Could potentially shrink later.
      // Or simply zero out unused entries. Let's zero out.
      this.documentFrequency.fill(0, newSize);
    }

    // Recalculate DF for all terms
    this.termFrequencies.forEach((docFreqsMap, termIndex) => {
      this.documentFrequency[termIndex] = docFreqsMap.size;
    });
    // Ensure DF for terms no longer present (if removal happens) is 0
    for (let i = this.termFrequencies.size; i < this.documentFrequency.length; i++) {
      this.documentFrequency[i] = 0;
    }
  }

  /**
   * Recalculates the average document length based on the current `documentLengths`.
   * @internal
   */
  private recalculateAverageLength() {
    if (this.documentLengths.length === 0) {
      this.averageDocLength = 0;
      return;
    }
    // Use Array.prototype.reduce for compatibility, though typed array reduce might be faster
    const totalLength = Array.prototype.reduce.call(
      this.documentLengths,
      (sum, len) => sum + len,
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

      const idf = this.calculateIDF(termIndex);
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

      const docsContainingTerm = this.termFrequencies.get(termIndex)?.keys();
      if (!docsContainingTerm) return []; // Should not happen, but check

      const currentTermDocs = new Set(docsContainingTerm);

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
            const phraseScore = this.calculatePhraseScore(phraseTokens, docIndex) * fieldBoost;
            scores.set(docIndex, (scores.get(docIndex) || 0) + phraseScore);
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
    return phraseTokens.reduce((score, term) => {
      const termIndex = this.termToIndex.get(term);
      // Ignore terms not in index (shouldn't happen if candidate selection worked)
      if (termIndex === undefined) return score;

      const idf = this.calculateIDF(termIndex);
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
      return score + idf * (numerator / denominator);
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
  async addDocument(doc: any) {
    // Allow Promise<void> return for potential future async ops
    if (!doc) throw new Error('Document cannot be null');

    const docIndex = this.documentLengths.length; // Index for the new document

    // --- Update Document List and Lengths ---
    this.documents.push(doc);
    // Resize documentLengths array (simple append)
    const newDocLengths = new Uint32Array(docIndex + 1);
    newDocLengths.set(this.documentLengths, 0); // Copy old lengths
    // Calculate length later...
    this.documentLengths = newDocLengths; // Assign temporarily

    let docLength = 0;
    const docTermFrequencies = new Map<number, number>(); // TermIndex -> TF for this new doc

    // --- Process Fields and Tokens ---
    Object.entries(doc).forEach(([field, content]) => {
      if (typeof content !== 'string') return;

      const fieldBoost = this.fieldBoosts[field] || 1;
      const { tokens } = this.tokenizer.tokenize(content);
      docLength += tokens.length * fieldBoost;

      // Process each token in the field
      tokens.forEach((term) => {
        let termIndex: number;
        // Add term to index if new
        if (!this.termToIndex.has(term)) {
          termIndex = this.termToIndex.size;
          this.termToIndex.set(term, termIndex);

          // Ensure documentFrequency array is large enough
          if (this.documentFrequency.length <= termIndex) {
            const oldDf = this.documentFrequency;
            // Grow exponentially, ensure it's at least termIndex + 1
            const newSize = Math.max(termIndex + 1, oldDf.length * 2);
            this.documentFrequency = new Uint32Array(newSize);
            this.documentFrequency.set(oldDf, 0);
          }
          // Initialize DF for new term (will be incremented below)
          this.documentFrequency[termIndex] = 0;
        } else {
          termIndex = this.termToIndex.get(term)!;
        }

        // Increment frequency for this term in this new document
        const currentFreq = docTermFrequencies.get(termIndex) || 0;
        docTermFrequencies.set(termIndex, currentFreq + fieldBoost); // Weighted TF
      });
    });

    // --- Update Global Structures ---
    // Set the calculated length for the new document
    this.documentLengths[docIndex] = docLength;

    // Add this document's term frequencies to the main map and update DF
    docTermFrequencies.forEach((freq, termIndex) => {
      // Add TF entry
      if (!this.termFrequencies.has(termIndex)) {
        this.termFrequencies.set(termIndex, new Map<number, number>());
      }
      this.termFrequencies.get(termIndex)!.set(docIndex, freq);

      // Increment document frequency for the term
      this.documentFrequency[termIndex]++;
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
  calculateIDF(termIndex: number): number {
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
   * For large batches, `addDocumentsParallel` is recommended if available/suitable.
   * @param docs - An array of documents to add.
   */
  async addDocuments(docs: any[]) {
    // Allow Promise<void> return type
    // Using Promise.all to potentially run additions concurrently if addDocument becomes async
    // Although the current addDocument is sync, this structure allows future flexibility.
    await Promise.all(docs.map((doc) => this.addDocument(doc)));
    // Note: If addDocument remains purely synchronous, a simple forEach would also work:
    // docs.forEach(doc => this.addDocument(doc));
  }
}
