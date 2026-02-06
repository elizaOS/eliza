import Diacritics from "diacritic";
import { customAlphabet } from "nanoid";
export {
  isItemInsideElement,
  getItemElement,
  pointInItem,
  fastItemIntersect,
} from "./item";

const cleanWord = (word) => Diacritics.clean(word).toLowerCase();

export const search = (term, string) => {
  let strings = string;
  if (typeof string === "string") {
    strings = [string];
  }
  const cleanedTerm = cleanWord(term);
  return strings.some((s) => cleanWord(s).includes(cleanedTerm));
};

export const hasClass = (element, className) =>
  element.classList && element.classList.contains(className);

export const insideClass = (element, className) => {
  if (hasClass(element, className)) {
    return element;
  }
  if (!element.parentNode) {
    return false;
  }
  return insideClass(element.parentNode, className);
};

/**
 * Shuffles array in place.
 * @param {Array} a An array containing the items.
 */
export const shuffle = (a) => {
  // eslint-disable-next-line no-plusplus
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    // eslint-disable-next-line no-param-reassign
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

export const randInt = (min, max) =>
  Math.floor(Math.random() * (max - min + 1)) + min;

const alpha = "23456789ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz";

// Custom uid generator
export const uid = customAlphabet(alpha, 10);

// Custom small uid generator
export const smallUid = customAlphabet(alpha, 5);

export const objectIntersection = (o1, o2) => {
  const keys = [...new Set([...Object.keys(o1), ...Object.keys(o2)])];
  return keys.reduce((prev, key) => {
    if (
      prev[key] !== o2[key] &&
      JSON.stringify(prev[key]) !== JSON.stringify(o2[key])
    ) {
      delete prev[key];
    }
    return prev;
  }, JSON.parse(JSON.stringify(o1)));
};

export const objectDiff = (o1, o2) => {
  const keys = [...new Set([...Object.keys(o1), ...Object.keys(o2)])];
  const result = keys.reduce((diff, key) => {
    if (o1[key] === o2[key]) return diff;
    if (JSON.stringify(o1[key]) === JSON.stringify(o2[key])) return diff;
    return {
      ...diff,
      [key]: o2[key],
    };
  }, {});

  if (Object.keys(result).length === 0) {
    return null;
  }

  return result;
};

export const retry = (fn, condition, delay) => {
  if (condition()) {
    setTimeout(() => retry(fn, condition, delay), delay);
  } else {
    fn();
  }
};

const audioFiles = {};

export const preloadAudio = (urls) => {
  urls.forEach((url) => {
    if (!audioFiles[url]) {
      audioFiles[url] = new Audio(url);
      audioFiles[url].load();
    }
  });
};

export const playAudio = (url, volume = 1) => {
  if (!audioFiles[url]) {
    audioFiles[url] = new Audio(url);
    audioFiles[url].load();
  }

  if (!audioFiles[url].paused) {
    audioFiles[url].pause();
    audioFiles[url].load();
  }
  audioFiles[url].volume = volume;

  audioFiles[url].play().catch((e) => console.log("Fail to play audio", e));
};

export const triggerFileDownload = (url, filename) => {
  const link = document.createElement("a");
  link.href = url;
  link.setAttribute("download", filename);
  document.body.appendChild(link);
  link.click();

  // Clean up and remove the link
  link.parentNode.removeChild(link);
};
