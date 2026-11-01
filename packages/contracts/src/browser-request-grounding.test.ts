import { domainToUnicode } from "node:url";
import { describe, expect, it } from "vitest";
import {
  authoredBrowserDestination,
  browserDestinationMatches,
  containsWebAddress,
  directBrowserDestination,
  groundBrowserDestination,
} from "./browser-request-grounding.ts";
import { IANA_TLDS } from "./iana-tlds.ts";

describe("strict whole-message open command (fast path)", () => {
  it.each([
    ["open youtube.com", "https://youtube.com/"],
    ["Open youtube.com.", "https://youtube.com/"],
    ["open youtube.com!", "https://youtube.com/"],
    ["open youtube.com!!", "https://youtube.com/"],
    ["open youtube.com?", "https://youtube.com/"],
    ["open youtube.com, please", "https://youtube.com/"],
    ["open youtube.com please", "https://youtube.com/"],
    ["open youtube.com, please.", "https://youtube.com/"],
    ["please open youtube.com", "https://youtube.com/"],
    ["Please, open youtube.com.", "https://youtube.com/"],
    ["open youtube.com, would you?", "https://youtube.com/"],
    ["open youtube.com, could you?", "https://youtube.com/"],
    ["open youtube.com, thanks", "https://youtube.com/"],
    ["open youtube.com, thank you.", "https://youtube.com/"],
    ["open youtube.com for me", "https://youtube.com/"],
    ["visit nytimes.com", "https://nytimes.com/"],
    ["go to nytimes.com", "https://nytimes.com/"],
    ["navigate to nytimes.com", "https://nytimes.com/"],
    ["Hey Eliza, open youtube.com.", "https://youtube.com/"],
    ["Hey Eliza. Open youtube.com.", "https://youtube.com/"],
    ["hey eliza open youtube.com", "https://youtube.com/"],
    ["Eliza, open youtube.com", "https://youtube.com/"],
    ["Eliza open youtube.com", "https://youtube.com/"],
    ["Hey, open youtube.com", "https://youtube.com/"],
    ["ok, open youtube.com", "https://youtube.com/"],
    ["okay eliza, open youtube.com", "https://youtube.com/"],
    ["hi eliza, go to nytimes.com", "https://nytimes.com/"],
    ["open YouTube.com", "https://youtube.com/"],
    ["go to www.example.com", "https://www.example.com/"],
    ["open example.com/dashboard", "https://example.com/dashboard"],
    ["open example.com/a, please", "https://example.com/a"],
    [
      'Please visit "https://example.com/a?q=1#section"',
      "https://example.com/a?q=1#section",
    ],
    ["navigate to 'example.com/path'", "https://example.com/path"],
    ["Open https://example.com/path.", "https://example.com/path."],
    [
      "Open https://example.com/?q=O'Reilly",
      "https://example.com/?q=O%27Reilly",
    ],
    // v1 always opened these; the strict form is their web signal.
    ["open main.py", "https://main.py/"],
    ["open bsky.app", "https://bsky.app/"],
  ])("claims %s", (text, href) =>
    expect(authoredBrowserDestination(text)).toBe(href),
  );

  it.each([
    // Everything else is the model's call, not this grammar's.
    "youtube.com",
    "https://EXAMPLE.com/a?q=1#section",
    "open youtube.com now",
    "open youtube.com in a new tab",
    "can you open youtube.com",
    "can you open youtube.com for me?",
    "pull up nytimes.com",
    "show me nytimes.com",
    "open up youtube.com",
    "open youtube.com !!",
    "Alexa, open youtube.com",
    "Hey Luna, open youtube.com",
    "open youtube.com and read its title",
    "open youtube.com, if you can",
    "Open youtube.com. Tomorrow.",
    // Earlier review rounds' false opens.
    "Tomorrow, open youtube.com",
    "Later, pull up nytimes.com",
    "Tonight, open youtube.com",
    "Maybe, open youtube.com",
    "Hypothetically, open youtube.com",
    "Otherwise, take me to nytimes.com",
    "at 5pm open youtube.com",
    "at 10am, open youtube.com",
    "In five minutes, open youtube.com",
    "is there a way to open youtube.com",
    "do I need to go to irs.gov?",
    "would it make sense to open youtube.com",
    "I used to visit myspace.com",
    "last time you helped me open youtube.com",
    "my mom wants me to open youtube.com",
    "my boss keeps telling me to go to linkedin.com",
    "Step 3: go to example.com",
    "we arent going to open youtube.com",
    "possibly open youtube.com",
    "take me to L.A.",
    "I want to go to L.A.",
    "Hey Eliza, take me to St.Louis",
    "can you open IMG_1234.heic",
    "Hey Eliza, open Recording.m4a",
    "show me 10.5",
    "can you pull up 3.14",
    "can you open Makefile.am",
    "can you open main.py",
    "open up main.py",
    "launch Spotify.app",
    "can you open script.pl",
    "don't open youtube.com",
    "hey eliza don't open youtube.com",
    "ok don't open youtube.com",
    "never, open youtube.com",
    // Not a web address.
    "open L.A.",
    "open IMG_1234.heic",
    "open Recording.m4a",
    "open 3.14",
    "open 10.0.0.5",
    "open localhost:3000",
    "open [::1]",
    "open my_site.com",
    "open LinkedIn",
    "open person@example.com",
    "https://person:secret@example.com/",
    "open javascript:alert(1)",
    "open http://example.com",
    "open example..com",
    "open https://example.com\\@evil.com",
    "open https://example.com\n",
    '"https://example.com"',
    'Explain "open example.com"',
    "The page says open example.com",
    "make another one for breakfast at 11 am",
    "What's the weather?",
  ])("does not claim %s", (text) =>
    expect(authoredBrowserDestination(text)).toBeUndefined(),
  );
});

// Each of these directly negates the open verb or the address: the hard guard
// refuses youtube.com whatever the model proposes.
const NEGATED = [
  // Open verbs joined by or, and, nor, "/" or a list comma are one group.
  "Don't open or visit youtube.com",
  "Do not visit or open youtube.com",
  "never open or go to youtube.com",
  "don't open nor visit youtube.com",
  "don't open or even visit youtube.com",
  "Please don't open or load youtube.com",
  "do not open, visit or load youtube.com",
  "do not open, visit, or load youtube.com",
  "don't go to or open youtube.com",
  "don't navigate to or open youtube.com",
  "never head over to or open youtube.com",
  "don't bring up or show me youtube.com",
  "don't open/visit youtube.com",
  "don't open/visit/load youtube.com",
  "don't open and/or visit youtube.com",
  "don't open & visit youtube.com",
  "do not open and visit youtube.com",
  "don't go and open youtube.com",
  "don't click or open youtube.com",
  "don't open or go to or visit youtube.com",
  "do not open and do not visit youtube.com",
  // "or" and "nor" also join across one object.
  "don't open google.com or visit youtube.com",
  "don't open google.com, or visit youtube.com",
  "don't open it or go to youtube.com",
  "don't open the app or visit youtube.com",
  // Up to four words, or eight after a preposition, with no punctuation.
  "do not under any circumstances open youtube.com",
  "do not under any circumstances go to youtube.com",
  "never under any circumstances visit youtube.com",
  "don't for any reason open youtube.com",
  "do not for any reason open youtube.com",
  "don't at any point open youtube.com",
  "do not ever under any circumstances open youtube.com",
  "Don't you ever under any circumstances open youtube.com",
  "do not under any circumstances at all open youtube.com",
  "don't for any reason at all open youtube.com",
  "do not at any point in time open youtube.com",
  "please do not at all open youtube.com",
  "don't right now open youtube.com",
  "don't today open youtube.com",
  "don't in any case open youtube.com",
  "never in a million years go to youtube.com",
  "dont even think about opening youtube.com",
  "dont even think about it open youtube.com",
  "I really don't think you should open youtube.com",
  // A preposition phrase may end in a comma; asides may use commas, dashes or
  // parentheses.
  "don't under any circumstances, open youtube.com",
  "don't for any reason, open youtube.com",
  "Do not, ever, open youtube.com",
  "do not ever, under any circumstances, open youtube.com",
  "never, under any circumstances, visit youtube.com",
  "do not \u2014 under any circumstances \u2014 open youtube.com",
  "do not (ever) open youtube.com",
  "do not, I repeat, do not open youtube.com",
  // Punctuation alone between the negation and the verb.
  "don't , open youtube.com",
  "don't... open youtube.com",
  "don't… open youtube.com",
  "don't\u2014open youtube.com",
  'don\'t "open" youtube.com',
  "Do not. Open. youtube.com",
  "Do. Not. Open. youtube.com",
  "Don't. Ever. Open youtube.com",
  "Don't. Under any circumstances. Open youtube.com",
  "Hey Eliza. Do not. Open. youtube.com",
  "Listen. Don't. Ever. Open youtube.com",
  // Emphasis marks and emoji.
  "do **not** open youtube.com",
  "*don't* open youtube.com",
  "_never_ open youtube.com",
  "don't ~~ever~~ open youtube.com",
  "don't [open] youtube.com",
  "don't \u{1F645}\u{1F3FD} open youtube.com",
  // Negations other than "not".
  "under no circumstances open youtube.com",
  "under no circumstances should you open youtube.com",
  "at no point visit youtube.com",
  "by no means open youtube.com",
  "avoid opening youtube.com",
  "refrain from visiting youtube.com",
  "stop trying to open youtube.com",
  "quit visiting youtube.com",
  "No opening youtube.com!",
  "no going to youtube.com",
  "there is no need for you to open youtube.com",
  "Not a chance you open youtube.com",
  "let's not open youtube.com",
  "I'd rather you didn't open youtube.com",
  "Don't bother opening youtube.com",
  "never mind opening youtube.com",
  "you can't open youtube.com",
  "Can't you just not open youtube.com",
  "Why don't you never open youtube.com",
  "Don't forget not to open youtube.com",
  "don't forget, don't open youtube.com",
  // Spellings of "don't".
  "DONT OPEN YOUTUBE.COM",
  "do'nt open youtube.com",
  "donot open youtube.com",
  "don‘t open youtube.com",
  "donʼt open youtube.com",
  "don`t open youtube.com",
  "ｄｏｎ＇ｔ ｏｐｅｎ youtube.com",
  "do\u200bn't open youtube.com",
  "don't\u00a0open youtube.com",
  // A negation of the address itself.
  "not youtube.com",
  "never youtube.com",
  "open google.com, not youtube.com",
  "open google.com not youtube.com",
  "neither google.com nor youtube.com",
  "don't open google.com nor youtube.com",
  "don't click youtube.com",
  "Don't use youtube.com",
  // A negation after the address that refuses it.
  "youtube.com, don't open it",
  "youtube.com - do not open",
  "youtube.com (do not visit)",
  "youtube.com: never visit it",
  "youtube.com? Don't.",
  "youtube.com? no, don't open it",
  "youtube.com, please don't go there",
  "youtube.com: stop opening it",
  "youtube.com, don't. Open nytimes.com",
  "youtube.com, don't open it. youtube.com, don't open it.",
  "open youtube.com. Actually, don't open it",
  // A message that ends in a bare "don't" or "never".
  "open youtube.com, don't",
  "Open youtube.com. Just kidding, don't.",
  "Why don't you open youtube.com? Actually don't.",
  // A polite question only at the start of a sentence.
  "that's why don't open youtube.com",
];

// The guard reads these as requests, not as negations of the open.
const NOT_NEGATED = [
  "why don't you open youtube.com",
  "why not open youtube.com",
  "can't you open youtube.com?",
  "won't you open youtube.com?",
  "couldn't you open youtube.com",
  "Don't forget to open youtube.com",
  "don't hesitate to open youtube.com",
  "Never mind, open youtube.com",
  "nevermind open youtube.com",
  "Okay eliza never mind open youtube.com",
  "never mind just go to youtube.com",
  "I can't wait, open youtube.com",
  "Don't worry, open youtube.com",
  "Absolutely not. Open youtube.com instead",
  "It's not working, open youtube.com",
  "Stop! Open youtube.com",
  "Stop what you're doing and open youtube.com",
  "Don't stop, just go to youtube.com",
  "Don't open it, go to youtube.com instead",
  "Never open attachments. Go to youtube.com",
  "Not google.com, open youtube.com",
  "Don't open google.com and visit youtube.com instead",
  "don't open google.com or bing.com, open youtube.com",
  "Don't worry. Open youtube.com",
  "Do not disturb. Open youtube.com",
  "open youtube.com, don't open google.com",
  "Open youtube.com but don't open it in Chrome",
  "open youtube.com and don't open anything else",
  "**Open** youtube.com \u{1F64F}",
  "open youtube.com, no?",
  "No, don't. Open youtube.com instead",
  "Don't check, open youtube.com",
  "don't show me, just open youtube.com",
  "Eliza, why don't you open youtube.com",
  "Eliza, can't you open youtube.com?",
  "Open youtube.com for me, I hope you don't mind",
];

// The same host typed more than once with one occurrence negated. One negated
// occurrence refuses the host, whatever the others ask (fail closed).
const CORRECTED = [
  "Open youtube.com. Actually don't open youtube.com",
  "Open youtube.com. Actually, don't open youtube.com.",
  "open youtube.com... no wait, don't open youtube.com",
  "Go to youtube.com. No, do not go to youtube.com.",
  "Open www.youtube.com. Actually, don't open youtube.com.",
  "Open youtube.com, no, never open youtube.com",
  "open youtube.com - scratch that, do not open youtube.com",
  "Hey Eliza, open youtube.com. Wait. Don't open youtube.com!",
  "Visit youtube.com. On second thought, don't visit youtube.com.",
  "I said open youtube.com but now I'm saying don't open youtube.com",
  "open youtube.com then don't open youtube.com",
  // Other open verbs.
  "Pull up youtube.com. Actually, don't pull up youtube.com.",
  "Show me youtube.com. Wait, don't show me youtube.com.",
  "Load youtube.com. Never load youtube.com.",
  "Navigate to youtube.com. Hmm, do not navigate to youtube.com.",
  "Take me to youtube.com. No, don't take me to youtube.com.",
  // www., letter case, https:// and quotes on either occurrence.
  "Open youtube.com. Actually, don't open www.youtube.com.",
  "Open www.youtube.com. No, never open www.youtube.com.",
  "Open YouTube.com. Actually, don't open YOUTUBE.COM.",
  "Open https://youtube.com. Actually, don't open youtube.com.",
  "Open youtube.com. Actually, don't open https://www.youtube.com/.",
  'Open "youtube.com". Actually, don\'t open "youtube.com".',
  // A negation after the later occurrence.
  "Open youtube.com. youtube.com, don't open it.",
  // Three occurrences.
  "Open youtube.com. Open youtube.com. Actually, don't open youtube.com.",
  "Open youtube.com, then go to youtube.com again. Wait, don't go to youtube.com.",
  "Don't open youtube.com. Open youtube.com. Open youtube.com.",
  // The negation first, then a request: also refused.
  "Don't open youtube.com. Actually, open youtube.com.",
  "Never visit youtube.com. Okay fine, visit youtube.com.",
  "Do not go to youtube.com. Never mind, go to youtube.com.",
  "Not youtube.com. Open youtube.com.",
  // "www." is ignored, so this refuses youtube.com too.
  "Open youtube.com, not www.youtube.com",
  // The correction in a form no address is read from: markup, another scheme,
  // attached punctuation or emoji, or a dot a URL also reads. Such a word never
  // opens the host, but it refuses it.
  "Open youtube.com. Actually, don't open **youtube.com**.",
  "Open youtube.com. Actually, don't open `youtube.com`.",
  "Open youtube.com. Actually, don't open http://youtube.com.",
  "Open youtube.com. Actually, don't open youtube.com\u2026",
  "Open youtube.com. Actually, don't open [youtube.com](https://youtube.com).",
  "Open youtube.com. Actually, don't open *youtube.com*.",
  "Open youtube.com. Actually, don't open _youtube.com_.",
  "Open youtube.com. Actually, don't open ~~youtube.com~~.",
  "Open youtube.com. Actually, don't open {youtube.com}.",
  "Open youtube.com. Actually, don't open youtube.com\u2014seriously.",
  "Open youtube.com. Actually, don't open youtube.com\u{1F64F}",
  "Open youtube.com. Actually, don't open youtube.com,thanks",
  "Open youtube.com. Actually, don't open youtube.com./",
  "Open youtube.com. Actually, don't open youtube.com-",
  "Open youtube.com. Actually, don't open YOUTUBE\uFF0ECOM.",
  "Open youtube.com. Actually, don't open youtube\u3002com.",
  "Open youtube.com. Actually, don't open youtube\uFF61com.",
  "Open youtube.com. Actually, don't open youtube\u2024com.",
];

// [the user's current message, the model's proposed URL, what opens]
const GROUNDING: [string, string, string | undefined][] = [
  ...NEGATED.map((text): [string, string, undefined] => [
    text,
    "https://youtube.com",
    undefined,
  ]),
  ...NOT_NEGATED.map((text): [string, string, string] => [
    text,
    "https://www.youtube.com/",
    "https://youtube.com/",
  ]),
  ...CORRECTED.flatMap((text): [string, string, undefined][] => [
    [text, "https://youtube.com", undefined],
    [text, "https://www.youtube.com/", undefined],
  ]),
  // A negated occurrence refuses its host on any path or port.
  [
    "Open youtube.com/watch?v=abc. Actually, don't open youtube.com/watch?v=abc.",
    "https://youtube.com/watch?v=abc",
    undefined,
  ],
  [
    "Open youtube.com/watch?v=abc. Actually, don't open youtube.com.",
    "https://www.youtube.com/watch?v=abc",
    undefined,
  ],
  [
    "Open example.com/dashboard. No, don't open example.com/dashboard.",
    "https://example.com/dashboard",
    undefined,
  ],
  [
    "Open example.com/a. Actually, don't open example.com/b.",
    "https://example.com/a",
    undefined,
  ],
  [
    "Visit example.com:8443/admin. Actually, don't visit example.com.",
    "https://example.com:8443/admin",
    undefined,
  ],
  [
    "Open www.lib.rs. Actually, don't open lib.rs.",
    "https://www.lib.rs/",
    undefined,
  ],
  // It refuses only that host.
  [
    "Open youtube.com and nytimes.com. Actually, don't open youtube.com.",
    "https://nytimes.com",
    "https://nytimes.com/",
  ],
  [
    "Open youtube.com. Actually, don't open nytimes.com.",
    "https://youtube.com",
    "https://youtube.com/",
  ],
  // A word names the host only with a label boundary on each side.
  [
    "Open youtube.com. Actually, don't open **m.youtube.com**.",
    "https://youtube.com",
    "https://youtube.com/",
  ],
  [
    "Open youtube.com, not youtube.com.au",
    "https://youtube.com",
    "https://youtube.com/",
  ],
  [
    "Open youtube.com, not my-youtube.com",
    "https://youtube.com",
    "https://youtube.com/",
  ],
  // A word that names the host refuses it only when the guard refuses it.
  [
    "Open youtube.com. I love **youtube.com**!",
    "https://youtube.com",
    "https://youtube.com/",
  ],
  // An internationalized host is named as a URL reads it.
  [
    "Open münchen.de. Actually, don't open **MÜNCHEN.DE**.",
    "https://xn--mnchen-3ya.de/",
    undefined,
  ],
  // A negation refuses only the address it governs.
  [
    "youtube.com, don't open it. Open nytimes.com",
    "https://nytimes.com",
    "https://nytimes.com/",
  ],
  // Typed and proposed hosts agree; the user's spelling always opens.
  ["open youtube.com", "https://youtube.com", "https://youtube.com/"],
  ["open youtube.com", "https://www.youtube.com/", "https://youtube.com/"],
  ["open youtube.com", "youtube.com", "https://youtube.com/"],
  ["open youtube.com", "https://YouTube.com/", "https://youtube.com/"],
  ["Open YouTube.com", "https://www.youtube.com", "https://youtube.com/"],
  ["go to www.youtube.com", "https://youtube.com/", "https://www.youtube.com/"],
  ["go to WWW.YouTube.COM", "https://youtube.com/", "https://www.youtube.com/"],
  [
    "can you open youtube.com for me?",
    "https://www.youtube.com/",
    "https://youtube.com/",
  ],
  [
    "Hey Eliza, could you pull up nytimes.com?",
    "https://www.nytimes.com/",
    "https://nytimes.com/",
  ],
  [
    "show me nytimes.com real quick",
    "https://nytimes.com",
    "https://nytimes.com/",
  ],
  ["youtube.com", "https://youtube.com", "https://youtube.com/"],
  ["youtube.com please", "https://www.youtube.com", "https://youtube.com/"],
  [
    "open youtube.com, please",
    "https://www.youtube.com",
    "https://youtube.com/",
  ],
  ["open youtube.com!", "https://youtube.com", "https://youtube.com/"],
  [
    "Hey Eliza. Open youtube.com.",
    "https://www.youtube.com",
    "https://youtube.com/",
  ],
  ['open "youtube.com"', "https://youtube.com", "https://youtube.com/"],
  ["open (youtube.com)", "https://youtube.com", "https://youtube.com/"],
  [
    "youtube.com's homepage please",
    "https://youtube.com",
    "https://youtube.com/",
  ],
  [
    "open the youtube.com website",
    "https://youtube.com",
    "https://youtube.com/",
  ],
  [
    "take me to https://example.com/a?q=1#x",
    "https://example.com/a?q=1#x",
    "https://example.com/a?q=1#x",
  ],
  [
    "open https://EXAMPLE.com/a?q=1#section",
    "https://example.com/a?q=1#section",
    "https://example.com/a?q=1#section",
  ],
  [
    "open example.com/dashboard",
    "https://www.example.com/dashboard",
    "https://example.com/dashboard",
  ],
  [
    "open example.com/dashboard/",
    "https://example.com/dashboard",
    "https://example.com/dashboard/",
  ],
  [
    "visit example.com:8443/admin",
    "https://example.com:8443/admin",
    "https://example.com:8443/admin",
  ],
  ["open bbc.co.uk", "https://www.bbc.co.uk/", "https://bbc.co.uk/"],
  [
    "open en.wikipedia.org/wiki/Cat",
    "https://en.wikipedia.org/wiki/Cat",
    "https://en.wikipedia.org/wiki/Cat",
  ],
  [
    "open münchen.de",
    "https://xn--mnchen-3ya.de/",
    "https://xn--mnchen-3ya.de/",
  ],
  // A model path on a host typed without one opens the typed address only.
  [
    "open youtube.com",
    "https://youtube.com/watch?v=abc",
    "https://youtube.com/",
  ],
  [
    "open youtube.com/watch?v=abc",
    "https://www.youtube.com/watch?v=abc",
    "https://youtube.com/watch?v=abc",
  ],
  [
    "open example.com/a#one",
    "https://example.com/a#two",
    "https://example.com/a#one",
  ],
  [
    "open https://example.com/path.",
    "https://example.com/path",
    "https://example.com/path",
  ],
  [
    "open https://example.com/path.",
    "https://example.com/path.",
    "https://example.com/path.",
  ],
  [
    "open https://example.com/?q=O'Reilly",
    "https://example.com/?q=O'Reilly",
    "https://example.com/?q=O%27Reilly",
  ],
  // Several typed addresses: the model picks which; code checks it was typed.
  [
    "open youtube.com and nytimes.com",
    "https://nytimes.com",
    "https://nytimes.com/",
  ],
  [
    "open youtube.com and nytimes.com",
    "https://www.youtube.com",
    "https://youtube.com/",
  ],
  [
    "open youtube.com and www.youtube.com",
    "https://www.youtube.com/",
    "https://www.youtube.com/",
  ],
  [
    "open youtube.com and www.youtube.com",
    "https://youtube.com/",
    "https://youtube.com/",
  ],
  [
    "open example.com and example.com/a",
    "https://example.com/a",
    "https://example.com/a",
  ],
  [
    "open example.com and example.com/a",
    "https://example.com/b",
    "https://example.com/",
  ],
  [
    "open example.com/a and example.com/b",
    "https://example.com/b",
    "https://example.com/b",
  ],
  // Whether these are for now is the model's call, not a word list's.
  [
    "I want to read the news on nytimes.com",
    "https://nytimes.com/",
    "https://nytimes.com/",
  ],
  ["at 5pm open youtube.com", "https://youtube.com", "https://youtube.com/"],
  [
    "I don't know, open youtube.com",
    "https://youtube.com",
    "https://youtube.com/",
  ],
  [
    "Don't forget to open youtube.com",
    "https://youtube.com",
    "https://youtube.com/",
  ],
  [
    "Never mind, open youtube.com",
    "https://youtube.com",
    "https://youtube.com/",
  ],
  [
    "No, open youtube.com instead",
    "https://youtube.com",
    "https://youtube.com/",
  ],

  // Model-invented or rewritten hosts never open.
  ["open YouTube", "https://youtube.com", undefined],
  ["open the New York Times", "https://nytimes.com", undefined],
  [
    "make another one for breakfast at 11 am",
    "https://example.com/dashboard",
    undefined,
  ],
  ["search for cat videos", "https://youtube.com", undefined],
  ["What's the weather?", "https://weather.com", undefined],
  ["open youtube.com", "https://evil.com", undefined],
  ["open youtube.com", "https://youtube.com.evil.com", undefined],
  ["open youtube.com", "https://evil.com/youtube.com", undefined],
  ["open youtube.com", "https://m.youtube.com", undefined],
  ["open youtube.com", "https://youtu.be", undefined],
  ["open youtube.com", "https://youtube.co", undefined],
  ["open nytimes.com", "https://nytimes.com.au", undefined],
  [
    "open en.wikipedia.org/wiki/Cat",
    "https://en.m.wikipedia.org/wiki/Cat",
    undefined,
  ],
  ["visit example.com:8443", "https://example.com/", undefined],
  ["visit example.com", "https://example.com:8443/", undefined],
  ["email person@example.com", "https://example.com", undefined],
  [
    "open https://person:secret@example.com/",
    "https://example.com/",
    undefined,
  ],
  ["open http://example.com", "https://example.com", undefined],
  ["open youtube.com", "http://youtube.com", undefined],
  ["open youtube.com", "javascript:alert(1)", undefined],
  ["open youtube.com", "", undefined],
  ["open example.com\nopen evil.com", "https://example.com", undefined],
  ["open https://example.com\\@evil.com", "https://example.com", undefined],
  ["open example..com", "https://example..com", undefined],

  // A typed path must be the proposed path.
  ["open example.com/a", "https://example.com/b", undefined],
  ["open example.com/different", "https://example.com/dashboard", undefined],
  ["open example.com/a?q=1", "https://example.com/a?q=2", undefined],
  ["open example.com/a?q=1", "https://example.com/a", undefined],
  ["open example.com/A", "https://example.com/a", undefined],
  ["open example.com/a and example.com/b", "https://example.com/", undefined],
  ["open youtube.com/watch?v=abc", "https://youtube.com/", undefined],

  // Only a real web host on a real IANA top-level domain.
  ["take me to L.A.", "https://l.a", undefined],
  ["open L.A.", "https://l.a/", undefined],
  ["I want to go to U.S.A.", "https://u.s.a", undefined],
  ["navigate to St.Louis", "https://st.louis", undefined],
  ["can you open IMG_1234.heic", "https://img_1234.heic", undefined],
  ["open IMG_1234.heic", "https://img_1234.heic", undefined],
  ["Hey Eliza, open Recording.m4a", "https://recording.m4a", undefined],
  ["show me 3.14", "https://3.14", undefined],
  ["load 10.0.0.5", "https://10.0.0.5", undefined],
  ["open 192.168.1.1", "https://192.168.1.1/", undefined],
  ["open localhost:3000", "https://localhost:3000", undefined],
  ["open [::1]", "https://[::1]/", undefined],
  ["open my_site.com", "https://my_site.com", undefined],
  ["open example.notatld", "https://example.notatld", undefined],
  ["open photo.jpg", "https://photo.jpg", undefined],
  ["open report.pdf", "https://report.pdf", undefined],
  ["pull up a.m.", "https://a.m", undefined],
  ["open nic.museum", "https://nic.museum", "https://nic.museum/"],
  ["open example.co.uk", "https://example.co.uk", "https://example.co.uk/"],
  ["can you pull up claude.ai", "https://claude.ai/", "https://claude.ai/"],
  ["show me example.dev", "https://example.dev", "https://example.dev/"],

  // A file-type top-level domain needs a web signal or the strict command.
  ["can you open Makefile.am", "https://makefile.am", undefined],
  ["open Makefile.am", "https://makefile.am", "https://makefile.am/"],
  ["can you open main.py", "https://main.py", undefined],
  ["open main.py", "https://main.py", "https://main.py/"],
  ["can you open bsky.app", "https://bsky.app", undefined],
  ["open bsky.app", "https://bsky.app", "https://bsky.app/"],
  ["bsky.app", "https://bsky.app", undefined],
  ["can you open https://bsky.app", "https://bsky.app", "https://bsky.app/"],
  ["can you open www.bsky.app", "https://bsky.app", "https://www.bsky.app/"],
  [
    "can you open the bsky.app website",
    "https://bsky.app",
    "https://bsky.app/",
  ],
  ["pull up the website bsky.app", "https://bsky.app", "https://bsky.app/"],
  ["show me the site at docs.rs", "https://docs.rs/", "https://docs.rs/"],
  ["open bsky.app's website", "https://bsky.app", "https://bsky.app/"],
  ["open the docs.rs web site please", "https://docs.rs", "https://docs.rs/"],
  ["can you open notes.one", "https://notes.one", undefined],
  ["pull up report.pub", "https://report.pub", undefined],
  ["can you open file.download", "https://file.download", undefined],
  ["show me README.md", "https://readme.md", undefined],
  ["launch Spotify.app", "https://spotify.app", undefined],
  ["can you open script.pl", "https://script.pl", undefined],
  ["can you open messages.mo", "https://messages.mo", undefined],
  ["pull up build.mk", "https://build.mk", undefined],
  ["can you open lib.la", "https://lib.la", undefined],
  ["can you open prog.st", "https://prog.st", undefined],
  ["can you open main.cr", "https://main.cr", undefined],
  ["can you open data.nc", "https://data.nc", undefined],
  ["can you open code.gs", "https://code.gs", undefined],
  ["can you open Makefile.in", "https://makefile.in", undefined],
  ["can you open archive.zip", "https://archive.zip", undefined],
  ["can you open clip.mov", "https://clip.mov", undefined],
  ["run install.sh", "https://install.sh", undefined],
  ["can you open lib.rs", "https://lib.rs", undefined],
  ["can you open www.lib.rs", "https://lib.rs", "https://www.lib.rs/"],
  ["can you visit amazon.in", "https://amazon.in", undefined],
  ["can you open configure.ac", "https://configure.ac", undefined],
  ["can you open activity.fit", "https://activity.fit", undefined],
  ["can you open player.gd", "https://player.gd", undefined],
  ["can you open build.ninja", "https://build.ninja", undefined],
  ["can you open app.js.map", "https://app.js.map", undefined],
  ["can you open top.sv", "https://top.sv", undefined],
  [
    "can you open the site build.ninja",
    "https://build.ninja",
    "https://build.ninja/",
  ],
  // Real sites on these top-level domains stay open without a signal.
  ["can you open claude.ai", "https://claude.ai", "https://claude.ai/"],
  ["can you open bit.ly/abc", "https://bit.ly/abc", "https://bit.ly/abc"],
  [
    "can you visit https://amazon.in",
    "https://www.amazon.in/",
    "https://amazon.in/",
  ],
  ["visit amazon.in", "https://amazon.in", "https://amazon.in/"],

  // A negation that directly governs the open verb refuses that address.
  ["don't open youtube.com", "https://youtube.com", undefined],
  ["Don’t open youtube.com", "https://youtube.com", undefined],
  ["dont open youtube.com", "https://youtube.com", undefined],
  ["do not go to youtube.com", "https://youtube.com", undefined],
  ["DO NOT visit youtube.com", "https://youtube.com", undefined],
  ["never visit youtube.com", "https://youtube.com", undefined],
  ["never, ever go to youtube.com", "https://youtube.com", undefined],
  ["not open youtube.com", "https://youtube.com", undefined],
  ["please don't open youtube.com", "https://youtube.com", undefined],
  ["stop opening youtube.com", "https://youtube.com", undefined],
  ["don't ever open youtube.com", "https://youtube.com", undefined],
  ["I don't want to go to youtube.com", "https://youtube.com", undefined],
  ["you shouldn't open youtube.com", "https://youtube.com", undefined],
  ["you shouldnt open youtube.com", "https://youtube.com", undefined],
  ["Hey Eliza, don't open youtube.com", "https://youtube.com", undefined],
  ["can you not open youtube.com", "https://youtube.com", undefined],
  [
    "Do not, under any circumstances, open youtube.com",
    "https://youtube.com",
    undefined,
  ],
  [
    "please don't, for any reason, go to youtube.com",
    "https://youtube.com",
    undefined,
  ],
  [
    "I don't know, honestly, open youtube.com",
    "https://youtube.com",
    "https://youtube.com/",
  ],
  [
    "Not sure, but open youtube.com",
    "https://youtube.com",
    "https://youtube.com/",
  ],
  ["don't show me nytimes.com", "https://nytimes.com", undefined],
  ["Don't open youtube.com or nytimes.com", "https://nytimes.com", undefined],
  [
    "don't open youtube.com, open nytimes.com instead",
    "https://youtube.com",
    undefined,
  ],
  [
    "don't open youtube.com, open nytimes.com instead",
    "https://nytimes.com",
    "https://nytimes.com/",
  ],
  [
    "Don't open youtube.com. Open nytimes.com.",
    "https://nytimes.com",
    "https://nytimes.com/",
  ],
];

describe("grounding a model browser proposal in the typed address", () => {
  it("covers every rule with a large table", () =>
    expect(GROUNDING.length).toBeGreaterThanOrEqual(120));

  it.each(GROUNDING)("%s + model %s opens %s", (text, proposed, opened) =>
    expect(groundBrowserDestination(text, proposed)).toBe(opened),
  );

  it.each(GROUNDING)(
    "the phone recheck accepts exactly what the server stores: %s + model %s",
    (text, proposed, opened) => {
      const phoneAllows = (url: string) =>
        browserDestinationMatches(
          { type: "browser_navigate", url },
          groundBrowserDestination(text, url),
        );
      if (opened) {
        // The server stores the grounded address, which the phone accepts.
        expect(groundBrowserDestination(text, opened)).toBe(opened);
        expect(phoneAllows(opened)).toBe(true);
      }
      // A model spelling that was not stored as-is never passes the phone.
      if (
        !browserDestinationMatches(
          { type: "browser_navigate", url: proposed },
          opened,
        )
      )
        expect(phoneAllows(proposed)).toBe(false);
    },
  );

  it("never opens an address that is not in the user's words", () => {
    for (const [text, proposed] of GROUNDING) {
      const opened = groundBrowserDestination(text, proposed);
      if (!opened) continue;
      expect(text.toLowerCase()).toContain(
        domainToUnicode(new URL(opened).hostname),
      );
    }
  });

  it("knows when the user typed any address, for refusal copy", () => {
    expect(containsWebAddress("open YouTube")).toBe(false);
    expect(containsWebAddress("open IMG_1234.heic")).toBe(false);
    expect(containsWebAddress("make another one for breakfast")).toBe(false);
    expect(containsWebAddress("don't open youtube.com")).toBe(true);
    expect(containsWebAddress("can you open main.py")).toBe(true);
    // A multiline message is never grounded, but its address was typed.
    expect(containsWebAddress("Hey Eliza\nopen youtube.com")).toBe(true);
    expect(
      groundBrowserDestination(
        "Hey Eliza\nopen youtube.com",
        "https://youtube.com",
      ),
    ).toBeUndefined();
  });

  it("stays linear on long adversarial input", () => {
    for (const text of [
      `open ${"a.".repeat(4000)}com`,
      `don't ${"to ".repeat(2700)}open youtube.com`,
      `${"not ".repeat(2000)}open youtube.com`,
      `open ${".".repeat(4000)}a`,
      `${"x ".repeat(4000)}youtube.com`,
    ]) {
      const started = performance.now();
      groundBrowserDestination(text, "https://youtube.com");
      authoredBrowserDestination(text);
      expect(performance.now() - started).toBeLessThan(250);
    }
  });
});

describe("embedded IANA top-level domain list", () => {
  it("holds real TLDs only, lowercased", () => {
    expect(IANA_TLDS.size).toBeGreaterThan(1400);
    for (const tld of ["com", "org", "uk", "de", "app", "museum", "xn--p1ai"])
      expect(IANA_TLDS.has(tld)).toBe(true);
    for (const tld of ["a", "louis", "heic", "m4a", "14", "localhost", "COM"])
      expect(IANA_TLDS.has(tld)).toBe(false);
  });
});

describe("exact destination comparison", () => {
  it("compares the entire normalized destination", () => {
    const href = groundBrowserDestination(
      "open https://example.com/a?q=1#one",
      "https://example.com/a?q=1#one",
    );
    expect(
      browserDestinationMatches(
        { type: "browser_navigate", url: "https://EXAMPLE.com/a?q=1#one" },
        href,
      ),
    ).toBe(true);
    for (const url of [
      "https://example.com/b?q=1#one",
      "https://example.com/a?q=2#one",
      "https://example.com/a?q=1#two",
      "https://evil.com/a?q=1#one",
    ])
      expect(
        browserDestinationMatches({ type: "browser_navigate", url }, href),
      ).toBe(false);
    expect(
      browserDestinationMatches({ type: "open_view", url: href }, href),
    ).toBe(false);
  });
});


describe("direct client navigation requires a whole request", () => {
  it.each([
    "Can you explain https://example.com/dashboard",
    "The page says open https://example.com/dashboard",
    "'https://example.com/dashboard'",
    "Open https://example.com/dashboard then move my event",
    "Open https://example.com/dashboard or https://other.example/",
  ])("does not turn a typed model-grounded address into direct authority: %s", (text) => {
    expect(groundBrowserDestination(text, "https://example.com/dashboard")).toBe("https://example.com/dashboard");
    expect(directBrowserDestination(text)).toBeUndefined();
  });
  it.each([
    "https://example.com/dashboard",
    "example.com/dashboard",
    "Open https://example.com/dashboard",
    'Open "https://example.com/dashboard"',
  ])("retains the exact direct destination: %s", (text) => {
    expect(directBrowserDestination(text)).toBe("https://example.com/dashboard");
  });
});


describe("direct bare addresses preserve the file-name boundary", () => {
  it.each(["main.py", "notes.one", "archive.zip", "\"main.py\"", "'notes.one'"])("does not auto-open a file-like name: %s", (text) => {
    expect(directBrowserDestination(text)).toBeUndefined();
  });
  it.each([
    ["https://main.py", "https://main.py/"],
    ["www.main.py", "https://www.main.py/"],
    ["Open main.py", "https://main.py/"],
    ["notes.com", "https://notes.com/"],
  ])("keeps explicit websites and ordinary bare hosts: %s", (text, expected) => {
    expect(directBrowserDestination(text)).toBe(expected);
  });
});


describe("direct polite requests keep the existing file-name distinction", () => {
  it.each([
    ["Hey Eliza, can you open youtube.com for me?", "https://youtube.com/"],
    ["could you visit https://example.com/path", "https://example.com/path"],
    ["can you open the main.py website", "https://main.py/"],
    ["can you open main.py", undefined],
    ["The page says can you open youtube.com", undefined],
    ["Can you explain youtube.com", undefined],
    ["Can you open youtube.com then move my event", undefined],
  ])("preserves direct intent and refuses narrated or compound requests: %s", (text, expected) => {
    expect(directBrowserDestination(text)).toBe(expected);
  });
});
