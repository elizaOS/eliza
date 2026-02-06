var __create = Object.create;
var __getProtoOf = Object.getPrototypeOf;
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __toESM = (mod, isNodeMode, target) => {
  target = mod != null ? __create(__getProtoOf(mod)) : {};
  const to = isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target;
  for (let key of __getOwnPropNames(mod))
    if (!__hasOwnProp.call(to, key))
      __defProp(to, key, {
        get: () => mod[key],
        enumerable: true
      });
  return to;
};
var __commonJS = (cb, mod) => () => (mod || cb((mod = { exports: {} }).exports, mod), mod.exports);

// ../../node_modules/unique-names-generator/dist/index.js
var require_dist = __commonJS((exports) => {
  var a = (a2) => {
    a2 = 1831565813 + (a2 |= 0) | 0;
    let e2 = Math.imul(a2 ^ a2 >>> 15, 1 | a2);
    return e2 = e2 + Math.imul(e2 ^ e2 >>> 7, 61 | e2) ^ e2, ((e2 ^ e2 >>> 14) >>> 0) / 4294967296;
  };

  class e {
    constructor(a2) {
      this.dictionaries = undefined, this.length = undefined, this.separator = undefined, this.style = undefined, this.seed = undefined;
      const { length: e2, separator: i2, dictionaries: n, style: l, seed: r } = a2;
      this.dictionaries = n, this.separator = i2, this.length = e2, this.style = l, this.seed = r;
    }
    generate() {
      if (!this.dictionaries)
        throw new Error('Cannot find any dictionary. Please provide at least one, or leave the "dictionary" field empty in the config object');
      if (this.length <= 0)
        throw new Error("Invalid length provided");
      if (this.length > this.dictionaries.length)
        throw new Error(`The length cannot be bigger than the number of dictionaries.
Length provided: ${this.length}. Number of dictionaries provided: ${this.dictionaries.length}`);
      let e2 = this.seed;
      return this.dictionaries.slice(0, this.length).reduce((i2, n) => {
        let l;
        e2 ? (l = ((e3) => {
          if (typeof e3 == "string") {
            const i3 = e3.split("").map((a2) => a2.charCodeAt(0)).reduce((a2, e4) => a2 + e4, 1), n2 = Math.floor(Number(i3));
            return a(n2);
          }
          return a(e3);
        })(e2), e2 = 4294967296 * l) : l = Math.random();
        let r = n[Math.floor(l * n.length)] || "";
        if (this.style === "lowerCase")
          r = r.toLowerCase();
        else if (this.style === "capital") {
          const [a2, ...e3] = r.split("");
          r = a2.toUpperCase() + e3.join("");
        } else
          this.style === "upperCase" && (r = r.toUpperCase());
        return i2 ? `${i2}${this.separator}${r}` : `${r}`;
      }, "");
    }
  }
  var i = { separator: "_", dictionaries: [] };
  exports.NumberDictionary = class {
    static generate(a2 = {}) {
      let e2 = a2.min || 1, i2 = a2.max || 999;
      if (a2.length) {
        const n = Math.pow(10, a2.length);
        return e2 = n / 10, i2 = n - 1, [`${Math.floor(Math.random() * (i2 - e2)) + e2}`];
      }
      return [`${Math.floor(Math.random() * (i2 - e2)) + e2}`];
    }
  }, exports.adjectives = ["able", "above", "absent", "absolute", "abstract", "abundant", "academic", "acceptable", "accepted", "accessible", "accurate", "accused", "active", "actual", "acute", "added", "additional", "adequate", "adjacent", "administrative", "adorable", "advanced", "adverse", "advisory", "aesthetic", "afraid", "aggregate", "aggressive", "agreeable", "agreed", "agricultural", "alert", "alive", "alleged", "allied", "alone", "alright", "alternative", "amateur", "amazing", "ambitious", "amused", "ancient", "angry", "annoyed", "annual", "anonymous", "anxious", "appalling", "apparent", "applicable", "appropriate", "arbitrary", "architectural", "armed", "arrogant", "artificial", "artistic", "ashamed", "asleep", "assistant", "associated", "atomic", "attractive", "automatic", "autonomous", "available", "average", "awake", "aware", "awful", "awkward", "back", "bad", "balanced", "bare", "basic", "beautiful", "beneficial", "better", "bewildered", "big", "binding", "biological", "bitter", "bizarre", "blank", "blind", "blonde", "bloody", "blushing", "boiling", "bold", "bored", "boring", "bottom", "brainy", "brave", "breakable", "breezy", "brief", "bright", "brilliant", "broad", "broken", "bumpy", "burning", "busy", "calm", "capable", "capitalist", "careful", "casual", "causal", "cautious", "central", "certain", "changing", "characteristic", "charming", "cheap", "cheerful", "chemical", "chief", "chilly", "chosen", "christian", "chronic", "chubby", "circular", "civic", "civil", "civilian", "classic", "classical", "clean", "clear", "clever", "clinical", "close", "closed", "cloudy", "clumsy", "coastal", "cognitive", "coherent", "cold", "collective", "colonial", "colorful", "colossal", "coloured", "colourful", "combative", "combined", "comfortable", "coming", "commercial", "common", "communist", "compact", "comparable", "comparative", "compatible", "competent", "competitive", "complete", "complex", "complicated", "comprehensive", "compulsory", "conceptual", "concerned", "concrete", "condemned", "confident", "confidential", "confused", "conscious", "conservation", "conservative", "considerable", "consistent", "constant", "constitutional", "contemporary", "content", "continental", "continued", "continuing", "continuous", "controlled", "controversial", "convenient", "conventional", "convinced", "convincing", "cooing", "cool", "cooperative", "corporate", "correct", "corresponding", "costly", "courageous", "crazy", "creative", "creepy", "criminal", "critical", "crooked", "crowded", "crucial", "crude", "cruel", "cuddly", "cultural", "curious", "curly", "current", "curved", "cute", "daily", "damaged", "damp", "dangerous", "dark", "dead", "deaf", "deafening", "dear", "decent", "decisive", "deep", "defeated", "defensive", "defiant", "definite", "deliberate", "delicate", "delicious", "delighted", "delightful", "democratic", "dependent", "depressed", "desirable", "desperate", "detailed", "determined", "developed", "developing", "devoted", "different", "difficult", "digital", "diplomatic", "direct", "dirty", "disabled", "disappointed", "disastrous", "disciplinary", "disgusted", "distant", "distinct", "distinctive", "distinguished", "disturbed", "disturbing", "diverse", "divine", "dizzy", "domestic", "dominant", "double", "doubtful", "drab", "dramatic", "dreadful", "driving", "drunk", "dry", "dual", "due", "dull", "dusty", "dutch", "dying", "dynamic", "eager", "early", "eastern", "easy", "economic", "educational", "eerie", "effective", "efficient", "elaborate", "elated", "elderly", "eldest", "electoral", "electric", "electrical", "electronic", "elegant", "eligible", "embarrassed", "embarrassing", "emotional", "empirical", "empty", "enchanting", "encouraging", "endless", "energetic", "enormous", "enthusiastic", "entire", "entitled", "envious", "environmental", "equal", "equivalent", "essential", "established", "estimated", "ethical", "ethnic", "eventual", "everyday", "evident", "evil", "evolutionary", "exact", "excellent", "exceptional", "excess", "excessive", "excited", "exciting", "exclusive", "existing", "exotic", "expected", "expensive", "experienced", "experimental", "explicit", "extended", "extensive", "external", "extra", "extraordinary", "extreme", "exuberant", "faint", "fair", "faithful", "familiar", "famous", "fancy", "fantastic", "far", "fascinating", "fashionable", "fast", "fat", "fatal", "favourable", "favourite", "federal", "fellow", "female", "feminist", "few", "fierce", "filthy", "final", "financial", "fine", "firm", "fiscal", "fit", "fixed", "flaky", "flat", "flexible", "fluffy", "fluttering", "flying", "following", "fond", "foolish", "foreign", "formal", "formidable", "forthcoming", "fortunate", "forward", "fragile", "frail", "frantic", "free", "frequent", "fresh", "friendly", "frightened", "front", "frozen", "full", "fun", "functional", "fundamental", "funny", "furious", "future", "fuzzy", "gastric", "gay", "general", "generous", "genetic", "gentle", "genuine", "geographical", "giant", "gigantic", "given", "glad", "glamorous", "gleaming", "global", "glorious", "golden", "good", "gorgeous", "gothic", "governing", "graceful", "gradual", "grand", "grateful", "greasy", "great", "grieving", "grim", "gross", "grotesque", "growing", "grubby", "grumpy", "guilty", "handicapped", "handsome", "happy", "hard", "harsh", "head", "healthy", "heavy", "helpful", "helpless", "hidden", "high", "hilarious", "hissing", "historic", "historical", "hollow", "holy", "homeless", "homely", "hon", "honest", "horizontal", "horrible", "hostile", "hot", "huge", "human", "hungry", "hurt", "hushed", "husky", "icy", "ideal", "identical", "ideological", "ill", "illegal", "imaginative", "immediate", "immense", "imperial", "implicit", "important", "impossible", "impressed", "impressive", "improved", "inadequate", "inappropriate", "inc", "inclined", "increased", "increasing", "incredible", "independent", "indirect", "individual", "industrial", "inevitable", "influential", "informal", "inherent", "initial", "injured", "inland", "inner", "innocent", "innovative", "inquisitive", "instant", "institutional", "insufficient", "intact", "integral", "integrated", "intellectual", "intelligent", "intense", "intensive", "interested", "interesting", "interim", "interior", "intermediate", "internal", "international", "intimate", "invisible", "involved", "irrelevant", "isolated", "itchy", "jealous", "jittery", "joint", "jolly", "joyous", "judicial", "juicy", "junior", "just", "keen", "key", "kind", "known", "labour", "large", "late", "latin", "lazy", "leading", "left", "legal", "legislative", "legitimate", "lengthy", "lesser", "level", "lexical", "liable", "liberal", "light", "like", "likely", "limited", "linear", "linguistic", "liquid", "literary", "little", "live", "lively", "living", "local", "logical", "lonely", "long", "loose", "lost", "loud", "lovely", "low", "loyal", "ltd", "lucky", "mad", "magic", "magnetic", "magnificent", "main", "major", "male", "mammoth", "managerial", "managing", "manual", "many", "marginal", "marine", "marked", "married", "marvellous", "marxist", "mass", "massive", "mathematical", "mature", "maximum", "mean", "meaningful", "mechanical", "medical", "medieval", "melodic", "melted", "mental", "mere", "metropolitan", "mid", "middle", "mighty", "mild", "military", "miniature", "minimal", "minimum", "ministerial", "minor", "miserable", "misleading", "missing", "misty", "mixed", "moaning", "mobile", "moderate", "modern", "modest", "molecular", "monetary", "monthly", "moral", "motionless", "muddy", "multiple", "mushy", "musical", "mute", "mutual", "mysterious", "naked", "narrow", "nasty", "national", "native", "natural", "naughty", "naval", "near", "nearby", "neat", "necessary", "negative", "neighbouring", "nervous", "net", "neutral", "new", "nice", "noble", "noisy", "normal", "northern", "nosy", "notable", "novel", "nuclear", "numerous", "nursing", "nutritious", "nutty", "obedient", "objective", "obliged", "obnoxious", "obvious", "occasional", "occupational", "odd", "official", "ok", "okay", "old", "olympic", "only", "open", "operational", "opposite", "optimistic", "oral", "ordinary", "organic", "organisational", "original", "orthodox", "other", "outdoor", "outer", "outrageous", "outside", "outstanding", "overall", "overseas", "overwhelming", "painful", "pale", "panicky", "parallel", "parental", "parliamentary", "partial", "particular", "passing", "passive", "past", "patient", "payable", "peaceful", "peculiar", "perfect", "permanent", "persistent", "personal", "petite", "philosophical", "physical", "plain", "planned", "plastic", "pleasant", "pleased", "poised", "polite", "political", "poor", "popular", "positive", "possible", "potential", "powerful", "practical", "precious", "precise", "preferred", "pregnant", "preliminary", "premier", "prepared", "present", "presidential", "pretty", "previous", "prickly", "primary", "prime", "primitive", "principal", "printed", "prior", "private", "probable", "productive", "professional", "profitable", "profound", "progressive", "prominent", "promising", "proper", "proposed", "prospective", "protective", "protestant", "proud", "provincial", "psychiatric", "psychological", "public", "puny", "pure", "purring", "puzzled", "quaint", "qualified", "quarrelsome", "querulous", "quick", "quickest", "quiet", "quintessential", "quixotic", "racial", "radical", "rainy", "random", "rapid", "rare", "raspy", "rational", "ratty", "raw", "ready", "real", "realistic", "rear", "reasonable", "recent", "reduced", "redundant", "regional", "registered", "regular", "regulatory", "related", "relative", "relaxed", "relevant", "reliable", "relieved", "religious", "reluctant", "remaining", "remarkable", "remote", "renewed", "representative", "repulsive", "required", "resident", "residential", "resonant", "respectable", "respective", "responsible", "resulting", "retail", "retired", "revolutionary", "rich", "ridiculous", "right", "rigid", "ripe", "rising", "rival", "roasted", "robust", "rolling", "romantic", "rotten", "rough", "round", "royal", "rubber", "rude", "ruling", "running", "rural", "sacred", "sad", "safe", "salty", "satisfactory", "satisfied", "scared", "scary", "scattered", "scientific", "scornful", "scrawny", "screeching", "secondary", "secret", "secure", "select", "selected", "selective", "selfish", "semantic", "senior", "sensible", "sensitive", "separate", "serious", "severe", "sexual", "shaggy", "shaky", "shallow", "shared", "sharp", "sheer", "shiny", "shivering", "shocked", "short", "shrill", "shy", "sick", "significant", "silent", "silky", "silly", "similar", "simple", "single", "skilled", "skinny", "sleepy", "slight", "slim", "slimy", "slippery", "slow", "small", "smart", "smiling", "smoggy", "smooth", "social", "socialist", "soft", "solar", "sole", "solid", "sophisticated", "sore", "sorry", "sound", "sour", "southern", "soviet", "spare", "sparkling", "spatial", "special", "specific", "specified", "spectacular", "spicy", "spiritual", "splendid", "spontaneous", "sporting", "spotless", "spotty", "square", "squealing", "stable", "stale", "standard", "static", "statistical", "statutory", "steady", "steep", "sticky", "stiff", "still", "stingy", "stormy", "straight", "straightforward", "strange", "strategic", "strict", "striking", "striped", "strong", "structural", "stuck", "stupid", "subjective", "subsequent", "substantial", "subtle", "successful", "successive", "sudden", "sufficient", "suitable", "sunny", "super", "superb", "superior", "supporting", "supposed", "supreme", "sure", "surprised", "surprising", "surrounding", "surviving", "suspicious", "sweet", "swift", "symbolic", "sympathetic", "systematic", "tall", "tame", "tart", "tasteless", "tasty", "technical", "technological", "teenage", "temporary", "tender", "tense", "terrible", "territorial", "testy", "then", "theoretical", "thick", "thin", "thirsty", "thorough", "thoughtful", "thoughtless", "thundering", "tight", "tiny", "tired", "top", "tory", "total", "tough", "toxic", "traditional", "tragic", "tremendous", "tricky", "tropical", "troubled", "typical", "ugliest", "ugly", "ultimate", "unable", "unacceptable", "unaware", "uncertain", "unchanged", "uncomfortable", "unconscious", "underground", "underlying", "unemployed", "uneven", "unexpected", "unfair", "unfortunate", "unhappy", "uniform", "uninterested", "unique", "united", "universal", "unknown", "unlikely", "unnecessary", "unpleasant", "unsightly", "unusual", "unwilling", "upper", "upset", "uptight", "urban", "urgent", "used", "useful", "useless", "usual", "vague", "valid", "valuable", "variable", "varied", "various", "varying", "vast", "verbal", "vertical", "very", "vicarious", "vicious", "victorious", "violent", "visible", "visiting", "visual", "vital", "vitreous", "vivacious", "vivid", "vocal", "vocational", "voiceless", "voluminous", "voluntary", "vulnerable", "wandering", "warm", "wasteful", "watery", "weak", "wealthy", "weary", "wee", "weekly", "weird", "welcome", "well", "western", "wet", "whispering", "whole", "wicked", "wide", "widespread", "wild", "wilful", "willing", "willowy", "wily", "wise", "wispy", "wittering", "witty", "wonderful", "wooden", "working", "worldwide", "worried", "worrying", "worthwhile", "worthy", "written", "wrong", "xenacious", "xenial", "xenogeneic", "xenophobic", "xeric", "xerothermic", "yabbering", "yammering", "yappiest", "yappy", "yawning", "yearling", "yearning", "yeasty", "yelling", "yelping", "yielding", "yodelling", "young", "youngest", "youthful", "ytterbic", "yucky", "yummy", "zany", "zealous", "zeroth", "zestful", "zesty", "zippy", "zonal", "zoophagous", "zygomorphic", "zygotic"], exports.animals = ["aardvark", "aardwolf", "albatross", "alligator", "alpaca", "amphibian", "anaconda", "angelfish", "anglerfish", "ant", "anteater", "antelope", "antlion", "ape", "aphid", "armadillo", "asp", "baboon", "badger", "bandicoot", "barnacle", "barracuda", "basilisk", "bass", "bat", "bear", "beaver", "bedbug", "bee", "beetle", "bird", "bison", "blackbird", "boa", "boar", "bobcat", "bobolink", "bonobo", "booby", "bovid", "bug", "butterfly", "buzzard", "camel", "canid", "canidae", "capybara", "cardinal", "caribou", "carp", "cat", "caterpillar", "catfish", "catshark", "cattle", "centipede", "cephalopod", "chameleon", "cheetah", "chickadee", "chicken", "chimpanzee", "chinchilla", "chipmunk", "cicada", "clam", "clownfish", "cobra", "cockroach", "cod", "condor", "constrictor", "coral", "cougar", "cow", "coyote", "crab", "crane", "crawdad", "crayfish", "cricket", "crocodile", "crow", "cuckoo", "damselfly", "deer", "dingo", "dinosaur", "dog", "dolphin", "donkey", "dormouse", "dove", "dragon", "dragonfly", "duck", "eagle", "earthworm", "earwig", "echidna", "eel", "egret", "elephant", "elk", "emu", "ermine", "falcon", "felidae", "ferret", "finch", "firefly", "fish", "flamingo", "flea", "fly", "flyingfish", "fowl", "fox", "frog", "galliform", "gamefowl", "gayal", "gazelle", "gecko", "gerbil", "gibbon", "giraffe", "goat", "goldfish", "goose", "gopher", "gorilla", "grasshopper", "grouse", "guan", "guanaco", "guineafowl", "gull", "guppy", "haddock", "halibut", "hamster", "hare", "harrier", "hawk", "hedgehog", "heron", "herring", "hippopotamus", "hookworm", "hornet", "horse", "hoverfly", "hummingbird", "hyena", "iguana", "impala", "jackal", "jaguar", "jay", "jellyfish", "junglefowl", "kangaroo", "kingfisher", "kite", "kiwi", "koala", "koi", "krill", "ladybug", "lamprey", "landfowl", "lark", "leech", "lemming", "lemur", "leopard", "leopon", "limpet", "lion", "lizard", "llama", "lobster", "locust", "loon", "louse", "lungfish", "lynx", "macaw", "mackerel", "magpie", "mammal", "manatee", "mandrill", "marlin", "marmoset", "marmot", "marsupial", "marten", "mastodon", "meadowlark", "meerkat", "mink", "minnow", "mite", "mockingbird", "mole", "mollusk", "mongoose", "monkey", "moose", "mosquito", "moth", "mouse", "mule", "muskox", "narwhal", "newt", "nightingale", "ocelot", "octopus", "opossum", "orangutan", "orca", "ostrich", "otter", "owl", "ox", "panda", "panther", "parakeet", "parrot", "parrotfish", "partridge", "peacock", "peafowl", "pelican", "penguin", "perch", "pheasant", "pig", "pigeon", "pike", "pinniped", "piranha", "planarian", "platypus", "pony", "porcupine", "porpoise", "possum", "prawn", "primate", "ptarmigan", "puffin", "puma", "python", "quail", "quelea", "quokka", "rabbit", "raccoon", "rat", "rattlesnake", "raven", "reindeer", "reptile", "rhinoceros", "roadrunner", "rodent", "rook", "rooster", "roundworm", "sailfish", "salamander", "salmon", "sawfish", "scallop", "scorpion", "seahorse", "shark", "sheep", "shrew", "shrimp", "silkworm", "silverfish", "skink", "skunk", "sloth", "slug", "smelt", "snail", "snake", "snipe", "sole", "sparrow", "spider", "spoonbill", "squid", "squirrel", "starfish", "stingray", "stoat", "stork", "sturgeon", "swallow", "swan", "swift", "swordfish", "swordtail", "tahr", "takin", "tapir", "tarantula", "tarsier", "termite", "tern", "thrush", "tick", "tiger", "tiglon", "toad", "tortoise", "toucan", "trout", "tuna", "turkey", "turtle", "tyrannosaurus", "unicorn", "urial", "vicuna", "viper", "vole", "vulture", "wallaby", "walrus", "warbler", "wasp", "weasel", "whale", "whippet", "whitefish", "wildcat", "wildebeest", "wildfowl", "wolf", "wolverine", "wombat", "woodpecker", "worm", "wren", "xerinae", "yak", "zebra"], exports.colors = ["amaranth", "amber", "amethyst", "apricot", "aqua", "aquamarine", "azure", "beige", "black", "blue", "blush", "bronze", "brown", "chocolate", "coffee", "copper", "coral", "crimson", "cyan", "emerald", "fuchsia", "gold", "gray", "green", "harlequin", "indigo", "ivory", "jade", "lavender", "lime", "magenta", "maroon", "moccasin", "olive", "orange", "peach", "pink", "plum", "purple", "red", "rose", "salmon", "sapphire", "scarlet", "silver", "tan", "teal", "tomato", "turquoise", "violet", "white", "yellow"], exports.countries = ["Afghanistan", "Åland Islands", "Albania", "Algeria", "American Samoa", "Andorra", "Angola", "Anguilla", "Antarctica", "Antigua & Barbuda", "Argentina", "Armenia", "Aruba", "Ascension Island", "Australia", "Austria", "Azerbaijan", "Bahamas", "Bahrain", "Bangladesh", "Barbados", "Belarus", "Belgium", "Belize", "Benin", "Bermuda", "Bhutan", "Bolivia", "Bosnia & Herzegovina", "Botswana", "Brazil", "British Indian Ocean Territory", "British Virgin Islands", "Brunei", "Bulgaria", "Burkina Faso", "Burundi", "Cambodia", "Cameroon", "Canada", "Canary Islands", "Cape Verde", "Caribbean Netherlands", "Cayman Islands", "Central African Republic", "Ceuta & Melilla", "Chad", "Chile", "China", "Christmas Island", "Cocos Islands", "Colombia", "Comoros", "Congo", "Cook Islands", "Costa Rica", "Côte d'Ivoire", "Croatia", "Cuba", "Curaçao", "Cyprus", "Czechia", "Denmark", "Diego Garcia", "Djibouti", "Dominica", "Dominican Republic", "Ecuador", "Egypt", "El Salvador", "Equatorial Guinea", "Eritrea", "Estonia", "Ethiopia", "Eurozone", "Falkland Islands", "Faroe Islands", "Fiji", "Finland", "France", "French Guiana", "French Polynesia", "French Southern Territories", "Gabon", "Gambia", "Georgia", "Germany", "Ghana", "Gibraltar", "Greece", "Greenland", "Grenada", "Guadeloupe", "Guam", "Guatemala", "Guernsey", "Guinea", "Guinea-Bissau", "Guyana", "Haiti", "Honduras", "Hong Kong SAR China", "Hungary", "Iceland", "India", "Indonesia", "Iran", "Iraq", "Ireland", "Isle of Man", "Israel", "Italy", "Jamaica", "Japan", "Jersey", "Jordan", "Kazakhstan", "Kenya", "Kiribati", "Kosovo", "Kuwait", "Kyrgyzstan", "Laos", "Latvia", "Lebanon", "Lesotho", "Liberia", "Libya", "Liechtenstein", "Lithuania", "Luxembourg", "Macau SAR China", "Macedonia", "Madagascar", "Malawi", "Malaysia", "Maldives", "Mali", "Malta", "Marshall Islands", "Martinique", "Mauritania", "Mauritius", "Mayotte", "Mexico", "Micronesia", "Moldova", "Monaco", "Mongolia", "Montenegro", "Montserrat", "Morocco", "Mozambique", "Myanmar", "Namibia", "Nauru", "Nepal", "Netherlands", "New Caledonia", "New Zealand", "Nicaragua", "Niger", "Nigeria", "Niue", "Norfolk Island", "North Korea", "Northern Mariana Islands", "Norway", "Oman", "Pakistan", "Palau", "Palestinian Territories", "Panama", "Papua New Guinea", "Paraguay", "Peru", "Philippines", "Pitcairn Islands", "Poland", "Portugal", "Puerto Rico", "Qatar", "Réunion", "Romania", "Russia", "Rwanda", "Samoa", "San Marino", "São Tomé & Príncipe", "Saudi Arabia", "Senegal", "Serbia", "Seychelles", "Sierra Leone", "Singapore", "Sint Maarten", "Slovakia", "Slovenia", "Solomon Islands", "Somalia", "South Africa", "South Georgia & South Sandwich Islands", "South Korea", "South Sudan", "Spain", "Sri Lanka", "St. Barthélemy", "St. Helena", "St. Kitts & Nevis", "St. Lucia", "St. Martin", "St. Pierre & Miquelon", "St. Vincent & Grenadines", "Sudan", "Suriname", "Svalbard & Jan Mayen", "Swaziland", "Sweden", "Switzerland", "Syria", "Taiwan", "Tajikistan", "Tanzania", "Thailand", "Timor-Leste", "Togo", "Tokelau", "Tonga", "Trinidad & Tobago", "Tristan da Cunha", "Tunisia", "Turkey", "Turkmenistan", "Turks & Caicos Islands", "Tuvalu", "U.S. Outlying Islands", "U.S. Virgin Islands", "Uganda", "Ukraine", "United Arab Emirates", "United Kingdom", "United Nations", "United States", "Uruguay", "Uzbekistan", "Vanuatu", "Vatican City", "Venezuela", "Vietnam", "Wallis & Futuna", "Western Sahara", "Yemen", "Zambia", "Zimbabwe"], exports.languages = ["Akan", "Amharic", "Arabic", "Assamese", "Awadhi", "Azerbaijani", "Balochi", "Belarusian", "Bengali", "Bhojpuri", "Burmese", "Cebuano", "Chewa", "Chhattisgarhi", "Chittagonian", "Czech", "Deccan", "Dhundhari", "Dutch", "English", "French", "Fula", "Gan", "German", "Greek", "Gujarati", "Hakka", "Haryanvi", "Hausa", "Hiligaynon", "Hindi", "Hmong", "Hungarian", "Igbo", "Ilocano", "Italian", "Japanese", "Javanese", "Jin", "Kannada", "Kazakh", "Khmer", "Kinyarwanda", "Kirundi", "Konkani", "Korean", "Kurdish", "Madurese", "Magahi", "Maithili", "Malagasy", "Malay", "Malayalam", "Mandarin", "Marathi", "Marwari", "Min", "Mossi", "Nepali", "Odia", "Oromo", "Pashto", "Persian", "Polish", "Portuguese", "Punjabi", "Quechua", "Romanian", "Russian", "Saraiki", "Shona", "Sindhi", "Sinhala", "Somali", "Spanish", "Sundanese", "Swedish", "Sylheti", "Tagalog", "Tamil", "Telugu", "Thai", "Turkish", "Turkmen", "Ukrainian", "Urdu", "Uyghur", "Uzbek", "Vietnamese", "Wu", "Xhosa", "Xiang", "Yoruba", "Yue", "Zhuang", "Zulu"], exports.names = ["Aaren", "Aarika", "Abagael", "Abagail", "Abbe", "Abbey", "Abbi", "Abbie", "Abby", "Abbye", "Abigael", "Abigail", "Abigale", "Abra", "Ada", "Adah", "Adaline", "Adan", "Adara", "Adda", "Addi", "Addia", "Addie", "Addy", "Adel", "Adela", "Adelaida", "Adelaide", "Adele", "Adelheid", "Adelice", "Adelina", "Adelind", "Adeline", "Adella", "Adelle", "Adena", "Adey", "Adi", "Adiana", "Adina", "Adora", "Adore", "Adoree", "Adorne", "Adrea", "Adria", "Adriaens", "Adrian", "Adriana", "Adriane", "Adrianna", "Adrianne", "Adriena", "Adrienne", "Aeriel", "Aeriela", "Aeriell", "Afton", "Ag", "Agace", "Agata", "Agatha", "Agathe", "Aggi", "Aggie", "Aggy", "Agna", "Agnella", "Agnes", "Agnese", "Agnesse", "Agneta", "Agnola", "Agretha", "Aida", "Aidan", "Aigneis", "Aila", "Aile", "Ailee", "Aileen", "Ailene", "Ailey", "Aili", "Ailina", "Ailis", "Ailsun", "Ailyn", "Aime", "Aimee", "Aimil", "Aindrea", "Ainslee", "Ainsley", "Ainslie", "Ajay", "Alaine", "Alameda", "Alana", "Alanah", "Alane", "Alanna", "Alayne", "Alberta", "Albertina", "Albertine", "Albina", "Alecia", "Aleda", "Aleece", "Aleen", "Alejandra", "Alejandrina", "Alena", "Alene", "Alessandra", "Aleta", "Alethea", "Alex", "Alexa", "Alexandra", "Alexandrina", "Alexi", "Alexia", "Alexina", "Alexine", "Alexis", "Alfi", "Alfie", "Alfreda", "Alfy", "Ali", "Alia", "Alica", "Alice", "Alicea", "Alicia", "Alida", "Alidia", "Alie", "Alika", "Alikee", "Alina", "Aline", "Alis", "Alisa", "Alisha", "Alison", "Alissa", "Alisun", "Alix", "Aliza", "Alla", "Alleen", "Allegra", "Allene", "Alli", "Allianora", "Allie", "Allina", "Allis", "Allison", "Allissa", "Allix", "Allsun", "Allx", "Ally", "Allyce", "Allyn", "Allys", "Allyson", "Alma", "Almeda", "Almeria", "Almeta", "Almira", "Almire", "Aloise", "Aloisia", "Aloysia", "Alta", "Althea", "Alvera", "Alverta", "Alvina", "Alvinia", "Alvira", "Alyce", "Alyda", "Alys", "Alysa", "Alyse", "Alysia", "Alyson", "Alyss", "Alyssa", "Amabel", "Amabelle", "Amalea", "Amalee", "Amaleta", "Amalia", "Amalie", "Amalita", "Amalle", "Amanda", "Amandi", "Amandie", "Amandy", "Amara", "Amargo", "Amata", "Amber", "Amberly", "Ambur", "Ame", "Amelia", "Amelie", "Amelina", "Ameline", "Amelita", "Ami", "Amie", "Amii", "Amil", "Amitie", "Amity", "Ammamaria", "Amy", "Amye", "Ana", "Anabal", "Anabel", "Anabella", "Anabelle", "Analiese", "Analise", "Anallese", "Anallise", "Anastasia", "Anastasie", "Anastassia", "Anatola", "Andee", "Andeee", "Anderea", "Andi", "Andie", "Andra", "Andrea", "Andreana", "Andree", "Andrei", "Andria", "Andriana", "Andriette", "Andromache", "Andy", "Anestassia", "Anet", "Anett", "Anetta", "Anette", "Ange", "Angel", "Angela", "Angele", "Angelia", "Angelica", "Angelika", "Angelina", "Angeline", "Angelique", "Angelita", "Angelle", "Angie", "Angil", "Angy", "Ania", "Anica", "Anissa", "Anita", "Anitra", "Anjanette", "Anjela", "Ann", "Ann-marie", "Anna", "Anna-diana", "Anna-diane", "Anna-maria", "Annabal", "Annabel", "Annabela", "Annabell", "Annabella", "Annabelle", "Annadiana", "Annadiane", "Annalee", "Annaliese", "Annalise", "Annamaria", "Annamarie", "Anne", "Anne-corinne", "Anne-marie", "Annecorinne", "Anneliese", "Annelise", "Annemarie", "Annetta", "Annette", "Anni", "Annice", "Annie", "Annis", "Annissa", "Annmaria", "Annmarie", "Annnora", "Annora", "Anny", "Anselma", "Ansley", "Anstice", "Anthe", "Anthea", "Anthia", "Anthiathia", "Antoinette", "Antonella", "Antonetta", "Antonia", "Antonie", "Antonietta", "Antonina", "Anya", "Appolonia", "April", "Aprilette", "Ara", "Arabel", "Arabela", "Arabele", "Arabella", "Arabelle", "Arda", "Ardath", "Ardeen", "Ardelia", "Ardelis", "Ardella", "Ardelle", "Arden", "Ardene", "Ardenia", "Ardine", "Ardis", "Ardisj", "Ardith", "Ardra", "Ardyce", "Ardys", "Ardyth", "Aretha", "Ariadne", "Ariana", "Aridatha", "Ariel", "Ariela", "Ariella", "Arielle", "Arlana", "Arlee", "Arleen", "Arlen", "Arlena", "Arlene", "Arleta", "Arlette", "Arleyne", "Arlie", "Arliene", "Arlina", "Arlinda", "Arline", "Arluene", "Arly", "Arlyn", "Arlyne", "Aryn", "Ashely", "Ashia", "Ashien", "Ashil", "Ashla", "Ashlan", "Ashlee", "Ashleigh", "Ashlen", "Ashley", "Ashli", "Ashlie", "Ashly", "Asia", "Astra", "Astrid", "Astrix", "Atalanta", "Athena", "Athene", "Atlanta", "Atlante", "Auberta", "Aubine", "Aubree", "Aubrette", "Aubrey", "Aubrie", "Aubry", "Audi", "Audie", "Audra", "Audre", "Audrey", "Audrie", "Audry", "Audrye", "Audy", "Augusta", "Auguste", "Augustina", "Augustine", "Aundrea", "Aura", "Aurea", "Aurel", "Aurelea", "Aurelia", "Aurelie", "Auria", "Aurie", "Aurilia", "Aurlie", "Auroora", "Aurora", "Aurore", "Austin", "Austina", "Austine", "Ava", "Aveline", "Averil", "Averyl", "Avie", "Avis", "Aviva", "Avivah", "Avril", "Avrit", "Ayn", "Bab", "Babara", "Babb", "Babbette", "Babbie", "Babette", "Babita", "Babs", "Bambi", "Bambie", "Bamby", "Barb", "Barbabra", "Barbara", "Barbara-anne", "Barbaraanne", "Barbe", "Barbee", "Barbette", "Barbey", "Barbi", "Barbie", "Barbra", "Barby", "Bari", "Barrie", "Barry", "Basia", "Bathsheba", "Batsheva", "Bea", "Beatrice", "Beatrisa", "Beatrix", "Beatriz", "Bebe", "Becca", "Becka", "Becki", "Beckie", "Becky", "Bee", "Beilul", "Beitris", "Bekki", "Bel", "Belia", "Belicia", "Belinda", "Belita", "Bell", "Bella", "Bellanca", "Belle", "Bellina", "Belva", "Belvia", "Bendite", "Benedetta", "Benedicta", "Benedikta", "Benetta", "Benita", "Benni", "Bennie", "Benny", "Benoite", "Berenice", "Beret", "Berget", "Berna", "Bernadene", "Bernadette", "Bernadina", "Bernadine", "Bernardina", "Bernardine", "Bernelle", "Bernete", "Bernetta", "Bernette", "Berni", "Bernice", "Bernie", "Bernita", "Berny", "Berri", "Berrie", "Berry", "Bert", "Berta", "Berte", "Bertha", "Berthe", "Berti", "Bertie", "Bertina", "Bertine", "Berty", "Beryl", "Beryle", "Bess", "Bessie", "Bessy", "Beth", "Bethanne", "Bethany", "Bethena", "Bethina", "Betsey", "Betsy", "Betta", "Bette", "Bette-ann", "Betteann", "Betteanne", "Betti", "Bettina", "Bettine", "Betty", "Bettye", "Beulah", "Bev", "Beverie", "Beverlee", "Beverley", "Beverlie", "Beverly", "Bevvy", "Bianca", "Bianka", "Bibbie", "Bibby", "Bibbye", "Bibi", "Biddie", "Biddy", "Bidget", "Bili", "Bill", "Billi", "Billie", "Billy", "Billye", "Binni", "Binnie", "Binny", "Bird", "Birdie", "Birgit", "Birgitta", "Blair", "Blaire", "Blake", "Blakelee", "Blakeley", "Blanca", "Blanch", "Blancha", "Blanche", "Blinni", "Blinnie", "Blinny", "Bliss", "Blisse", "Blithe", "Blondell", "Blondelle", "Blondie", "Blondy", "Blythe", "Bobbe", "Bobbee", "Bobbette", "Bobbi", "Bobbie", "Bobby", "Bobbye", "Bobette", "Bobina", "Bobine", "Bobinette", "Bonita", "Bonnee", "Bonni", "Bonnibelle", "Bonnie", "Bonny", "Brana", "Brandais", "Brande", "Brandea", "Brandi", "Brandice", "Brandie", "Brandise", "Brandy", "Breanne", "Brear", "Bree", "Breena", "Bren", "Brena", "Brenda", "Brenn", "Brenna", "Brett", "Bria", "Briana", "Brianna", "Brianne", "Bride", "Bridget", "Bridgette", "Bridie", "Brier", "Brietta", "Brigid", "Brigida", "Brigit", "Brigitta", "Brigitte", "Brina", "Briney", "Brinn", "Brinna", "Briny", "Brit", "Brita", "Britney", "Britni", "Britt", "Britta", "Brittan", "Brittaney", "Brittani", "Brittany", "Britte", "Britteny", "Brittne", "Brittney", "Brittni", "Brook", "Brooke", "Brooks", "Brunhilda", "Brunhilde", "Bryana", "Bryn", "Bryna", "Brynn", "Brynna", "Brynne", "Buffy", "Bunni", "Bunnie", "Bunny", "Cacilia", "Cacilie", "Cahra", "Cairistiona", "Caitlin", "Caitrin", "Cal", "Calida", "Calla", "Calley", "Calli", "Callida", "Callie", "Cally", "Calypso", "Cam", "Camala", "Camel", "Camella", "Camellia", "Cami", "Camila", "Camile", "Camilla", "Camille", "Cammi", "Cammie", "Cammy", "Candace", "Candi", "Candice", "Candida", "Candide", "Candie", "Candis", "Candra", "Candy", "Caprice", "Cara", "Caralie", "Caren", "Carena", "Caresa", "Caressa", "Caresse", "Carey", "Cari", "Caria", "Carie", "Caril", "Carilyn", "Carin", "Carina", "Carine", "Cariotta", "Carissa", "Carita", "Caritta", "Carla", "Carlee", "Carleen", "Carlen", "Carlene", "Carley", "Carlie", "Carlin", "Carlina", "Carline", "Carlita", "Carlota", "Carlotta", "Carly", "Carlye", "Carlyn", "Carlynn", "Carlynne", "Carma", "Carmel", "Carmela", "Carmelia", "Carmelina", "Carmelita", "Carmella", "Carmelle", "Carmen", "Carmencita", "Carmina", "Carmine", "Carmita", "Carmon", "Caro", "Carol", "Carol-jean", "Carola", "Carolan", "Carolann", "Carole", "Carolee", "Carolin", "Carolina", "Caroline", "Caroljean", "Carolyn", "Carolyne", "Carolynn", "Caron", "Carree", "Carri", "Carrie", "Carrissa", "Carroll", "Carry", "Cary", "Caryl", "Caryn", "Casandra", "Casey", "Casi", "Casie", "Cass", "Cassandra", "Cassandre", "Cassandry", "Cassaundra", "Cassey", "Cassi", "Cassie", "Cassondra", "Cassy", "Catarina", "Cate", "Caterina", "Catha", "Catharina", "Catharine", "Cathe", "Cathee", "Catherin", "Catherina", "Catherine", "Cathi", "Cathie", "Cathleen", "Cathlene", "Cathrin", "Cathrine", "Cathryn", "Cathy", "Cathyleen", "Cati", "Catie", "Catina", "Catlaina", "Catlee", "Catlin", "Catrina", "Catriona", "Caty", "Caye", "Cayla", "Cecelia", "Cecil", "Cecile", "Ceciley", "Cecilia", "Cecilla", "Cecily", "Ceil", "Cele", "Celene", "Celesta", "Celeste", "Celestia", "Celestina", "Celestine", "Celestyn", "Celestyna", "Celia", "Celie", "Celina", "Celinda", "Celine", "Celinka", "Celisse", "Celka", "Celle", "Cesya", "Chad", "Chanda", "Chandal", "Chandra", "Channa", "Chantal", "Chantalle", "Charil", "Charin", "Charis", "Charissa", "Charisse", "Charita", "Charity", "Charla", "Charlean", "Charleen", "Charlena", "Charlene", "Charline", "Charlot", "Charlotta", "Charlotte", "Charmain", "Charmaine", "Charmane", "Charmian", "Charmine", "Charmion", "Charo", "Charyl", "Chastity", "Chelsae", "Chelsea", "Chelsey", "Chelsie", "Chelsy", "Cher", "Chere", "Cherey", "Cheri", "Cherianne", "Cherice", "Cherida", "Cherie", "Cherilyn", "Cherilynn", "Cherin", "Cherise", "Cherish", "Cherlyn", "Cherri", "Cherrita", "Cherry", "Chery", "Cherye", "Cheryl", "Cheslie", "Chiarra", "Chickie", "Chicky", "Chiquia", "Chiquita", "Chlo", "Chloe", "Chloette", "Chloris", "Chris", "Chrissie", "Chrissy", "Christa", "Christabel", "Christabella", "Christal", "Christalle", "Christan", "Christean", "Christel", "Christen", "Christi", "Christian", "Christiana", "Christiane", "Christie", "Christin", "Christina", "Christine", "Christy", "Christye", "Christyna", "Chrysa", "Chrysler", "Chrystal", "Chryste", "Chrystel", "Cicely", "Cicily", "Ciel", "Cilka", "Cinda", "Cindee", "Cindelyn", "Cinderella", "Cindi", "Cindie", "Cindra", "Cindy", "Cinnamon", "Cissiee", "Cissy", "Clair", "Claire", "Clara", "Clarabelle", "Clare", "Claresta", "Clareta", "Claretta", "Clarette", "Clarey", "Clari", "Claribel", "Clarice", "Clarie", "Clarinda", "Clarine", "Clarissa", "Clarisse", "Clarita", "Clary", "Claude", "Claudelle", "Claudetta", "Claudette", "Claudia", "Claudie", "Claudina", "Claudine", "Clea", "Clem", "Clemence", "Clementia", "Clementina", "Clementine", "Clemmie", "Clemmy", "Cleo", "Cleopatra", "Clerissa", "Clio", "Clo", "Cloe", "Cloris", "Clotilda", "Clovis", "Codee", "Codi", "Codie", "Cody", "Coleen", "Colene", "Coletta", "Colette", "Colleen", "Collen", "Collete", "Collette", "Collie", "Colline", "Colly", "Con", "Concettina", "Conchita", "Concordia", "Conni", "Connie", "Conny", "Consolata", "Constance", "Constancia", "Constancy", "Constanta", "Constantia", "Constantina", "Constantine", "Consuela", "Consuelo", "Cookie", "Cora", "Corabel", "Corabella", "Corabelle", "Coral", "Coralie", "Coraline", "Coralyn", "Cordelia", "Cordelie", "Cordey", "Cordi", "Cordie", "Cordula", "Cordy", "Coreen", "Corella", "Corenda", "Corene", "Coretta", "Corette", "Corey", "Cori", "Corie", "Corilla", "Corina", "Corine", "Corinna", "Corinne", "Coriss", "Corissa", "Corliss", "Corly", "Cornela", "Cornelia", "Cornelle", "Cornie", "Corny", "Correna", "Correy", "Corri", "Corrianne", "Corrie", "Corrina", "Corrine", "Corrinne", "Corry", "Cortney", "Cory", "Cosetta", "Cosette", "Costanza", "Courtenay", "Courtnay", "Courtney", "Crin", "Cris", "Crissie", "Crissy", "Crista", "Cristabel", "Cristal", "Cristen", "Cristi", "Cristie", "Cristin", "Cristina", "Cristine", "Cristionna", "Cristy", "Crysta", "Crystal", "Crystie", "Cthrine", "Cyb", "Cybil", "Cybill", "Cymbre", "Cynde", "Cyndi", "Cyndia", "Cyndie", "Cyndy", "Cynthea", "Cynthia", "Cynthie", "Cynthy", "Dacey", "Dacia", "Dacie", "Dacy", "Dael", "Daffi", "Daffie", "Daffy", "Dagmar", "Dahlia", "Daile", "Daisey", "Daisi", "Daisie", "Daisy", "Dale", "Dalenna", "Dalia", "Dalila", "Dallas", "Daloris", "Damara", "Damaris", "Damita", "Dana", "Danell", "Danella", "Danette", "Dani", "Dania", "Danica", "Danice", "Daniela", "Daniele", "Daniella", "Danielle", "Danika", "Danila", "Danit", "Danita", "Danna", "Danni", "Dannie", "Danny", "Dannye", "Danya", "Danyelle", "Danyette", "Daphene", "Daphna", "Daphne", "Dara", "Darb", "Darbie", "Darby", "Darcee", "Darcey", "Darci", "Darcie", "Darcy", "Darda", "Dareen", "Darell", "Darelle", "Dari", "Daria", "Darice", "Darla", "Darleen", "Darlene", "Darline", "Darlleen", "Daron", "Darrelle", "Darryl", "Darsey", "Darsie", "Darya", "Daryl", "Daryn", "Dasha", "Dasi", "Dasie", "Dasya", "Datha", "Daune", "Daveen", "Daveta", "Davida", "Davina", "Davine", "Davita", "Dawn", "Dawna", "Dayle", "Dayna", "Ddene", "De", "Deana", "Deane", "Deanna", "Deanne", "Deb", "Debbi", "Debbie", "Debby", "Debee", "Debera", "Debi", "Debor", "Debora", "Deborah", "Debra", "Dede", "Dedie", "Dedra", "Dee", "Deeann", "Deeanne", "Deedee", "Deena", "Deerdre", "Deeyn", "Dehlia", "Deidre", "Deina", "Deirdre", "Del", "Dela", "Delcina", "Delcine", "Delia", "Delila", "Delilah", "Delinda", "Dell", "Della", "Delly", "Delora", "Delores", "Deloria", "Deloris", "Delphine", "Delphinia", "Demeter", "Demetra", "Demetria", "Demetris", "Dena", "Deni", "Denice", "Denise", "Denna", "Denni", "Dennie", "Denny", "Deny", "Denys", "Denyse", "Deonne", "Desdemona", "Desirae", "Desiree", "Desiri", "Deva", "Devan", "Devi", "Devin", "Devina", "Devinne", "Devon", "Devondra", "Devonna", "Devonne", "Devora", "Di", "Diahann", "Dian", "Diana", "Diandra", "Diane", "Diane-marie", "Dianemarie", "Diann", "Dianna", "Dianne", "Diannne", "Didi", "Dido", "Diena", "Dierdre", "Dina", "Dinah", "Dinnie", "Dinny", "Dion", "Dione", "Dionis", "Dionne", "Dita", "Dix", "Dixie", "Dniren", "Dode", "Dodi", "Dodie", "Dody", "Doe", "Doll", "Dolley", "Dolli", "Dollie", "Dolly", "Dolores", "Dolorita", "Doloritas", "Domeniga", "Dominga", "Domini", "Dominica", "Dominique", "Dona", "Donella", "Donelle", "Donetta", "Donia", "Donica", "Donielle", "Donna", "Donnamarie", "Donni", "Donnie", "Donny", "Dora", "Doralia", "Doralin", "Doralyn", "Doralynn", "Doralynne", "Dore", "Doreen", "Dorelia", "Dorella", "Dorelle", "Dorena", "Dorene", "Doretta", "Dorette", "Dorey", "Dori", "Doria", "Dorian", "Dorice", "Dorie", "Dorine", "Doris", "Dorisa", "Dorise", "Dorita", "Doro", "Dorolice", "Dorolisa", "Dorotea", "Doroteya", "Dorothea", "Dorothee", "Dorothy", "Dorree", "Dorri", "Dorrie", "Dorris", "Dorry", "Dorthea", "Dorthy", "Dory", "Dosi", "Dot", "Doti", "Dotti", "Dottie", "Dotty", "Dre", "Dreddy", "Dredi", "Drona", "Dru", "Druci", "Drucie", "Drucill", "Drucy", "Drusi", "Drusie", "Drusilla", "Drusy", "Dulce", "Dulcea", "Dulci", "Dulcia", "Dulciana", "Dulcie", "Dulcine", "Dulcinea", "Dulcy", "Dulsea", "Dusty", "Dyan", "Dyana", "Dyane", "Dyann", "Dyanna", "Dyanne", "Dyna", "Dynah", "Eachelle", "Eada", "Eadie", "Eadith", "Ealasaid", "Eartha", "Easter", "Eba", "Ebba", "Ebonee", "Ebony", "Eda", "Eddi", "Eddie", "Eddy", "Ede", "Edee", "Edeline", "Eden", "Edi", "Edie", "Edin", "Edita", "Edith", "Editha", "Edithe", "Ediva", "Edna", "Edwina", "Edy", "Edyth", "Edythe", "Effie", "Eileen", "Eilis", "Eimile", "Eirena", "Ekaterina", "Elaina", "Elaine", "Elana", "Elane", "Elayne", "Elberta", "Elbertina", "Elbertine", "Eleanor", "Eleanora", "Eleanore", "Electra", "Eleen", "Elena", "Elene", "Eleni", "Elenore", "Eleonora", "Eleonore", "Elfie", "Elfreda", "Elfrida", "Elfrieda", "Elga", "Elianora", "Elianore", "Elicia", "Elie", "Elinor", "Elinore", "Elisa", "Elisabet", "Elisabeth", "Elisabetta", "Elise", "Elisha", "Elissa", "Elita", "Eliza", "Elizabet", "Elizabeth", "Elka", "Elke", "Ella", "Elladine", "Elle", "Ellen", "Ellene", "Ellette", "Elli", "Ellie", "Ellissa", "Elly", "Ellyn", "Ellynn", "Elmira", "Elna", "Elnora", "Elnore", "Eloisa", "Eloise", "Elonore", "Elora", "Elsa", "Elsbeth", "Else", "Elset", "Elsey", "Elsi", "Elsie", "Elsinore", "Elspeth", "Elsy", "Elva", "Elvera", "Elvina", "Elvira", "Elwira", "Elyn", "Elyse", "Elysee", "Elysha", "Elysia", "Elyssa", "Em", "Ema", "Emalee", "Emalia", "Emelda", "Emelia", "Emelina", "Emeline", "Emelita", "Emelyne", "Emera", "Emilee", "Emili", "Emilia", "Emilie", "Emiline", "Emily", "Emlyn", "Emlynn", "Emlynne", "Emma", "Emmalee", "Emmaline", "Emmalyn", "Emmalynn", "Emmalynne", "Emmeline", "Emmey", "Emmi", "Emmie", "Emmy", "Emmye", "Emogene", "Emyle", "Emylee", "Engracia", "Enid", "Enrica", "Enrichetta", "Enrika", "Enriqueta", "Eolanda", "Eolande", "Eran", "Erda", "Erena", "Erica", "Ericha", "Ericka", "Erika", "Erin", "Erina", "Erinn", "Erinna", "Erma", "Ermengarde", "Ermentrude", "Ermina", "Erminia", "Erminie", "Erna", "Ernaline", "Ernesta", "Ernestine", "Ertha", "Eryn", "Esma", "Esmaria", "Esme", "Esmeralda", "Essa", "Essie", "Essy", "Esta", "Estel", "Estele", "Estell", "Estella", "Estelle", "Ester", "Esther", "Estrella", "Estrellita", "Ethel", "Ethelda", "Ethelin", "Ethelind", "Etheline", "Ethelyn", "Ethyl", "Etta", "Etti", "Ettie", "Etty", "Eudora", "Eugenia", "Eugenie", "Eugine", "Eula", "Eulalie", "Eunice", "Euphemia", "Eustacia", "Eva", "Evaleen", "Evangelia", "Evangelin", "Evangelina", "Evangeline", "Evania", "Evanne", "Eve", "Eveleen", "Evelina", "Eveline", "Evelyn", "Evey", "Evie", "Evita", "Evonne", "Evvie", "Evvy", "Evy", "Eyde", "Eydie", "Ezmeralda", "Fae", "Faina", "Faith", "Fallon", "Fan", "Fanchette", "Fanchon", "Fancie", "Fancy", "Fanechka", "Fania", "Fanni", "Fannie", "Fanny", "Fanya", "Fara", "Farah", "Farand", "Farica", "Farra", "Farrah", "Farrand", "Faun", "Faunie", "Faustina", "Faustine", "Fawn", "Fawne", "Fawnia", "Fay", "Faydra", "Faye", "Fayette", "Fayina", "Fayre", "Fayth", "Faythe", "Federica", "Fedora", "Felecia", "Felicdad", "Felice", "Felicia", "Felicity", "Felicle", "Felipa", "Felisha", "Felita", "Feliza", "Fenelia", "Feodora", "Ferdinanda", "Ferdinande", "Fern", "Fernanda", "Fernande", "Fernandina", "Ferne", "Fey", "Fiann", "Fianna", "Fidela", "Fidelia", "Fidelity", "Fifi", "Fifine", "Filia", "Filide", "Filippa", "Fina", "Fiona", "Fionna", "Fionnula", "Fiorenze", "Fleur", "Fleurette", "Flo", "Flor", "Flora", "Florance", "Flore", "Florella", "Florence", "Florencia", "Florentia", "Florenza", "Florette", "Flori", "Floria", "Florida", "Florie", "Florina", "Florinda", "Floris", "Florri", "Florrie", "Florry", "Flory", "Flossi", "Flossie", "Flossy", "Flss", "Fran", "Francene", "Frances", "Francesca", "Francine", "Francisca", "Franciska", "Francoise", "Francyne", "Frank", "Frankie", "Franky", "Franni", "Frannie", "Franny", "Frayda", "Fred", "Freda", "Freddi", "Freddie", "Freddy", "Fredelia", "Frederica", "Fredericka", "Frederique", "Fredi", "Fredia", "Fredra", "Fredrika", "Freida", "Frieda", "Friederike", "Fulvia", "Gabbey", "Gabbi", "Gabbie", "Gabey", "Gabi", "Gabie", "Gabriel", "Gabriela", "Gabriell", "Gabriella", "Gabrielle", "Gabriellia", "Gabrila", "Gaby", "Gae", "Gael", "Gail", "Gale", "Galina", "Garland", "Garnet", "Garnette", "Gates", "Gavra", "Gavrielle", "Gay", "Gaye", "Gayel", "Gayla", "Gayle", "Gayleen", "Gaylene", "Gaynor", "Gelya", "Gena", "Gene", "Geneva", "Genevieve", "Genevra", "Genia", "Genna", "Genni", "Gennie", "Gennifer", "Genny", "Genovera", "Genvieve", "George", "Georgeanna", "Georgeanne", "Georgena", "Georgeta", "Georgetta", "Georgette", "Georgia", "Georgiana", "Georgianna", "Georgianne", "Georgie", "Georgina", "Georgine", "Geralda", "Geraldine", "Gerda", "Gerhardine", "Geri", "Gerianna", "Gerianne", "Gerladina", "Germain", "Germaine", "Germana", "Gerri", "Gerrie", "Gerrilee", "Gerry", "Gert", "Gerta", "Gerti", "Gertie", "Gertrud", "Gertruda", "Gertrude", "Gertrudis", "Gerty", "Giacinta", "Giana", "Gianina", "Gianna", "Gigi", "Gilberta", "Gilberte", "Gilbertina", "Gilbertine", "Gilda", "Gilemette", "Gill", "Gillan", "Gilli", "Gillian", "Gillie", "Gilligan", "Gilly", "Gina", "Ginelle", "Ginevra", "Ginger", "Ginni", "Ginnie", "Ginnifer", "Ginny", "Giorgia", "Giovanna", "Gipsy", "Giralda", "Gisela", "Gisele", "Gisella", "Giselle", "Giuditta", "Giulia", "Giulietta", "Giustina", "Gizela", "Glad", "Gladi", "Gladys", "Gleda", "Glen", "Glenda", "Glenine", "Glenn", "Glenna", "Glennie", "Glennis", "Glori", "Gloria", "Gloriana", "Gloriane", "Glory", "Glyn", "Glynda", "Glynis", "Glynnis", "Gnni", "Godiva", "Golda", "Goldarina", "Goldi", "Goldia", "Goldie", "Goldina", "Goldy", "Grace", "Gracia", "Gracie", "Grata", "Gratia", "Gratiana", "Gray", "Grayce", "Grazia", "Greer", "Greta", "Gretal", "Gretchen", "Grete", "Gretel", "Grethel", "Gretna", "Gretta", "Grier", "Griselda", "Grissel", "Guendolen", "Guenevere", "Guenna", "Guglielma", "Gui", "Guillema", "Guillemette", "Guinevere", "Guinna", "Gunilla", "Gus", "Gusella", "Gussi", "Gussie", "Gussy", "Gusta", "Gusti", "Gustie", "Gusty", "Gwen", "Gwendolen", "Gwendolin", "Gwendolyn", "Gweneth", "Gwenette", "Gwenneth", "Gwenni", "Gwennie", "Gwenny", "Gwenora", "Gwenore", "Gwyn", "Gwyneth", "Gwynne", "Gypsy", "Hadria", "Hailee", "Haily", "Haleigh", "Halette", "Haley", "Hali", "Halie", "Halimeda", "Halley", "Halli", "Hallie", "Hally", "Hana", "Hanna", "Hannah", "Hanni", "Hannie", "Hannis", "Hanny", "Happy", "Harlene", "Harley", "Harli", "Harlie", "Harmonia", "Harmonie", "Harmony", "Harri", "Harrie", "Harriet", "Harriett", "Harrietta", "Harriette", "Harriot", "Harriott", "Hatti", "Hattie", "Hatty", "Hayley", "Hazel", "Heath", "Heather", "Heda", "Hedda", "Heddi", "Heddie", "Hedi", "Hedvig", "Hedvige", "Hedwig", "Hedwiga", "Hedy", "Heida", "Heidi", "Heidie", "Helaina", "Helaine", "Helen", "Helen-elizabeth", "Helena", "Helene", "Helenka", "Helga", "Helge", "Helli", "Heloise", "Helsa", "Helyn", "Hendrika", "Henka", "Henrie", "Henrieta", "Henrietta", "Henriette", "Henryetta", "Hephzibah", "Hermia", "Hermina", "Hermine", "Herminia", "Hermione", "Herta", "Hertha", "Hester", "Hesther", "Hestia", "Hetti", "Hettie", "Hetty", "Hilary", "Hilda", "Hildagard", "Hildagarde", "Hilde", "Hildegaard", "Hildegarde", "Hildy", "Hillary", "Hilliary", "Hinda", "Holli", "Hollie", "Holly", "Holly-anne", "Hollyanne", "Honey", "Honor", "Honoria", "Hope", "Horatia", "Hortense", "Hortensia", "Hulda", "Hyacinth", "Hyacintha", "Hyacinthe", "Hyacinthia", "Hyacinthie", "Hynda", "Ianthe", "Ibbie", "Ibby", "Ida", "Idalia", "Idalina", "Idaline", "Idell", "Idelle", "Idette", "Ileana", "Ileane", "Ilene", "Ilise", "Ilka", "Illa", "Ilsa", "Ilse", "Ilysa", "Ilyse", "Ilyssa", "Imelda", "Imogen", "Imogene", "Imojean", "Ina", "Indira", "Ines", "Inesita", "Inessa", "Inez", "Inga", "Ingaberg", "Ingaborg", "Inge", "Ingeberg", "Ingeborg", "Inger", "Ingrid", "Ingunna", "Inna", "Iolande", "Iolanthe", "Iona", "Iormina", "Ira", "Irena", "Irene", "Irina", "Iris", "Irita", "Irma", "Isa", "Isabel", "Isabelita", "Isabella", "Isabelle", "Isadora", "Isahella", "Iseabal", "Isidora", "Isis", "Isobel", "Issi", "Issie", "Issy", "Ivett", "Ivette", "Ivie", "Ivonne", "Ivory", "Ivy", "Izabel", "Jacenta", "Jacinda", "Jacinta", "Jacintha", "Jacinthe", "Jackelyn", "Jacki", "Jackie", "Jacklin", "Jacklyn", "Jackquelin", "Jackqueline", "Jacky", "Jaclin", "Jaclyn", "Jacquelin", "Jacqueline", "Jacquelyn", "Jacquelynn", "Jacquenetta", "Jacquenette", "Jacquetta", "Jacquette", "Jacqui", "Jacquie", "Jacynth", "Jada", "Jade", "Jaime", "Jaimie", "Jaine", "Jami", "Jamie", "Jamima", "Jammie", "Jan", "Jana", "Janaya", "Janaye", "Jandy", "Jane", "Janean", "Janeczka", "Janeen", "Janel", "Janela", "Janella", "Janelle", "Janene", "Janenna", "Janessa", "Janet", "Janeta", "Janetta", "Janette", "Janeva", "Janey", "Jania", "Janice", "Janie", "Janifer", "Janina", "Janine", "Janis", "Janith", "Janka", "Janna", "Jannel", "Jannelle", "Janot", "Jany", "Jaquelin", "Jaquelyn", "Jaquenetta", "Jaquenette", "Jaquith", "Jasmin", "Jasmina", "Jasmine", "Jayme", "Jaymee", "Jayne", "Jaynell", "Jazmin", "Jean", "Jeana", "Jeane", "Jeanelle", "Jeanette", "Jeanie", "Jeanine", "Jeanna", "Jeanne", "Jeannette", "Jeannie", "Jeannine", "Jehanna", "Jelene", "Jemie", "Jemima", "Jemimah", "Jemmie", "Jemmy", "Jen", "Jena", "Jenda", "Jenelle", "Jeni", "Jenica", "Jeniece", "Jenifer", "Jeniffer", "Jenilee", "Jenine", "Jenn", "Jenna", "Jennee", "Jennette", "Jenni", "Jennica", "Jennie", "Jennifer", "Jennilee", "Jennine", "Jenny", "Jeralee", "Jere", "Jeri", "Jermaine", "Jerrie", "Jerrilee", "Jerrilyn", "Jerrine", "Jerry", "Jerrylee", "Jess", "Jessa", "Jessalin", "Jessalyn", "Jessamine", "Jessamyn", "Jesse", "Jesselyn", "Jessi", "Jessica", "Jessie", "Jessika", "Jessy", "Jewel", "Jewell", "Jewelle", "Jill", "Jillana", "Jillane", "Jillayne", "Jilleen", "Jillene", "Jilli", "Jillian", "Jillie", "Jilly", "Jinny", "Jo", "Jo-ann", "Jo-anne", "Joan", "Joana", "Joane", "Joanie", "Joann", "Joanna", "Joanne", "Joannes", "Jobey", "Jobi", "Jobie", "Jobina", "Joby", "Jobye", "Jobyna", "Jocelin", "Joceline", "Jocelyn", "Jocelyne", "Jodee", "Jodi", "Jodie", "Jody", "Joeann", "Joela", "Joelie", "Joell", "Joella", "Joelle", "Joellen", "Joelly", "Joellyn", "Joelynn", "Joete", "Joey", "Johanna", "Johannah", "Johna", "Johnath", "Johnette", "Johnna", "Joice", "Jojo", "Jolee", "Joleen", "Jolene", "Joletta", "Joli", "Jolie", "Joline", "Joly", "Jolyn", "Jolynn", "Jonell", "Joni", "Jonie", "Jonis", "Jordain", "Jordan", "Jordana", "Jordanna", "Jorey", "Jori", "Jorie", "Jorrie", "Jorry", "Joscelin", "Josee", "Josefa", "Josefina", "Josepha", "Josephina", "Josephine", "Josey", "Josi", "Josie", "Josselyn", "Josy", "Jourdan", "Joy", "Joya", "Joyan", "Joyann", "Joyce", "Joycelin", "Joye", "Jsandye", "Juana", "Juanita", "Judi", "Judie", "Judith", "Juditha", "Judy", "Judye", "Juieta", "Julee", "Juli", "Julia", "Juliana", "Juliane", "Juliann", "Julianna", "Julianne", "Julie", "Julienne", "Juliet", "Julieta", "Julietta", "Juliette", "Julina", "Juline", "Julissa", "Julita", "June", "Junette", "Junia", "Junie", "Junina", "Justina", "Justine", "Justinn", "Jyoti", "Kacey", "Kacie", "Kacy", "Kaela", "Kai", "Kaia", "Kaila", "Kaile", "Kailey", "Kaitlin", "Kaitlyn", "Kaitlynn", "Kaja", "Kakalina", "Kala", "Kaleena", "Kali", "Kalie", "Kalila", "Kalina", "Kalinda", "Kalindi", "Kalli", "Kally", "Kameko", "Kamila", "Kamilah", "Kamillah", "Kandace", "Kandy", "Kania", "Kanya", "Kara", "Kara-lynn", "Karalee", "Karalynn", "Kare", "Karee", "Karel", "Karen", "Karena", "Kari", "Karia", "Karie", "Karil", "Karilynn", "Karin", "Karina", "Karine", "Kariotta", "Karisa", "Karissa", "Karita", "Karla", "Karlee", "Karleen", "Karlen", "Karlene", "Karlie", "Karlotta", "Karlotte", "Karly", "Karlyn", "Karmen", "Karna", "Karol", "Karola", "Karole", "Karolina", "Karoline", "Karoly", "Karon", "Karrah", "Karrie", "Karry", "Kary", "Karyl", "Karylin", "Karyn", "Kasey", "Kass", "Kassandra", "Kassey", "Kassi", "Kassia", "Kassie", "Kat", "Kata", "Katalin", "Kate", "Katee", "Katerina", "Katerine", "Katey", "Kath", "Katha", "Katharina", "Katharine", "Katharyn", "Kathe", "Katherina", "Katherine", "Katheryn", "Kathi", "Kathie", "Kathleen", "Kathlin", "Kathrine", "Kathryn", "Kathryne", "Kathy", "Kathye", "Kati", "Katie", "Katina", "Katine", "Katinka", "Katleen", "Katlin", "Katrina", "Katrine", "Katrinka", "Katti", "Kattie", "Katuscha", "Katusha", "Katy", "Katya", "Kay", "Kaycee", "Kaye", "Kayla", "Kayle", "Kaylee", "Kayley", "Kaylil", "Kaylyn", "Keeley", "Keelia", "Keely", "Kelcey", "Kelci", "Kelcie", "Kelcy", "Kelila", "Kellen", "Kelley", "Kelli", "Kellia", "Kellie", "Kellina", "Kellsie", "Kelly", "Kellyann", "Kelsey", "Kelsi", "Kelsy", "Kendra", "Kendre", "Kenna", "Keri", "Keriann", "Kerianne", "Kerri", "Kerrie", "Kerrill", "Kerrin", "Kerry", "Kerstin", "Kesley", "Keslie", "Kessia", "Kessiah", "Ketti", "Kettie", "Ketty", "Kevina", "Kevyn", "Ki", "Kiah", "Kial", "Kiele", "Kiersten", "Kikelia", "Kiley", "Kim", "Kimberlee", "Kimberley", "Kimberli", "Kimberly", "Kimberlyn", "Kimbra", "Kimmi", "Kimmie", "Kimmy", "Kinna", "Kip", "Kipp", "Kippie", "Kippy", "Kira", "Kirbee", "Kirbie", "Kirby", "Kiri", "Kirsten", "Kirsteni", "Kirsti", "Kirstin", "Kirstyn", "Kissee", "Kissiah", "Kissie", "Kit", "Kitti", "Kittie", "Kitty", "Kizzee", "Kizzie", "Klara", "Klarika", "Klarrisa", "Konstance", "Konstanze", "Koo", "Kora", "Koral", "Koralle", "Kordula", "Kore", "Korella", "Koren", "Koressa", "Kori", "Korie", "Korney", "Korrie", "Korry", "Kris", "Krissie", "Krissy", "Krista", "Kristal", "Kristan", "Kriste", "Kristel", "Kristen", "Kristi", "Kristien", "Kristin", "Kristina", "Kristine", "Kristy", "Kristyn", "Krysta", "Krystal", "Krystalle", "Krystle", "Krystyna", "Kyla", "Kyle", "Kylen", "Kylie", "Kylila", "Kylynn", "Kym", "Kynthia", "Kyrstin", "Lacee", "Lacey", "Lacie", "Lacy", "Ladonna", "Laetitia", "Laina", "Lainey", "Lana", "Lanae", "Lane", "Lanette", "Laney", "Lani", "Lanie", "Lanita", "Lanna", "Lanni", "Lanny", "Lara", "Laraine", "Lari", "Larina", "Larine", "Larisa", "Larissa", "Lark", "Laryssa", "Latashia", "Latia", "Latisha", "Latrena", "Latrina", "Laura", "Lauraine", "Laural", "Lauralee", "Laure", "Lauree", "Laureen", "Laurel", "Laurella", "Lauren", "Laurena", "Laurene", "Lauretta", "Laurette", "Lauri", "Laurianne", "Laurice", "Laurie", "Lauryn", "Lavena", "Laverna", "Laverne", "Lavina", "Lavinia", "Lavinie", "Layla", "Layne", "Layney", "Lea", "Leah", "Leandra", "Leann", "Leanna", "Leanor", "Leanora", "Lebbie", "Leda", "Lee", "Leeann", "Leeanne", "Leela", "Leelah", "Leena", "Leesa", "Leese", "Legra", "Leia", "Leigh", "Leigha", "Leila", "Leilah", "Leisha", "Lela", "Lelah", "Leland", "Lelia", "Lena", "Lenee", "Lenette", "Lenka", "Lenna", "Lenora", "Lenore", "Leodora", "Leoine", "Leola", "Leoline", "Leona", "Leonanie", "Leone", "Leonelle", "Leonie", "Leonora", "Leonore", "Leontine", "Leontyne", "Leora", "Leshia", "Lesley", "Lesli", "Leslie", "Lesly", "Lesya", "Leta", "Lethia", "Leticia", "Letisha", "Letitia", "Letizia", "Letta", "Letti", "Lettie", "Letty", "Lexi", "Lexie", "Lexine", "Lexis", "Lexy", "Leyla", "Lezlie", "Lia", "Lian", "Liana", "Liane", "Lianna", "Lianne", "Lib", "Libbey", "Libbi", "Libbie", "Libby", "Licha", "Lida", "Lidia", "Liesa", "Lil", "Lila", "Lilah", "Lilas", "Lilia", "Lilian", "Liliane", "Lilias", "Lilith", "Lilla", "Lilli", "Lillian", "Lillis", "Lilllie", "Lilly", "Lily", "Lilyan", "Lin", "Lina", "Lind", "Linda", "Lindi", "Lindie", "Lindsay", "Lindsey", "Lindsy", "Lindy", "Linea", "Linell", "Linet", "Linette", "Linn", "Linnea", "Linnell", "Linnet", "Linnie", "Linzy", "Lira", "Lisa", "Lisabeth", "Lisbeth", "Lise", "Lisetta", "Lisette", "Lisha", "Lishe", "Lissa", "Lissi", "Lissie", "Lissy", "Lita", "Liuka", "Liv", "Liva", "Livia", "Livvie", "Livvy", "Livvyy", "Livy", "Liz", "Liza", "Lizabeth", "Lizbeth", "Lizette", "Lizzie", "Lizzy", "Loella", "Lois", "Loise", "Lola", "Loleta", "Lolita", "Lolly", "Lona", "Lonee", "Loni", "Lonna", "Lonni", "Lonnie", "Lora", "Lorain", "Loraine", "Loralee", "Loralie", "Loralyn", "Loree", "Loreen", "Lorelei", "Lorelle", "Loren", "Lorena", "Lorene", "Lorenza", "Loretta", "Lorette", "Lori", "Loria", "Lorianna", "Lorianne", "Lorie", "Lorilee", "Lorilyn", "Lorinda", "Lorine", "Lorita", "Lorna", "Lorne", "Lorraine", "Lorrayne", "Lorri", "Lorrie", "Lorrin", "Lorry", "Lory", "Lotta", "Lotte", "Lotti", "Lottie", "Lotty", "Lou", "Louella", "Louisa", "Louise", "Louisette", "Loutitia", "Lu", "Luce", "Luci", "Lucia", "Luciana", "Lucie", "Lucienne", "Lucila", "Lucilia", "Lucille", "Lucina", "Lucinda", "Lucine", "Lucita", "Lucky", "Lucretia", "Lucy", "Ludovika", "Luella", "Luelle", "Luisa", "Luise", "Lula", "Lulita", "Lulu", "Lura", "Lurette", "Lurleen", "Lurlene", "Lurline", "Lusa", "Luz", "Lyda", "Lydia", "Lydie", "Lyn", "Lynda", "Lynde", "Lyndel", "Lyndell", "Lyndsay", "Lyndsey", "Lyndsie", "Lyndy", "Lynea", "Lynelle", "Lynett", "Lynette", "Lynn", "Lynna", "Lynne", "Lynnea", "Lynnell", "Lynnelle", "Lynnet", "Lynnett", "Lynnette", "Lynsey", "Lyssa", "Mab", "Mabel", "Mabelle", "Mable", "Mada", "Madalena", "Madalyn", "Maddalena", "Maddi", "Maddie", "Maddy", "Madel", "Madelaine", "Madeleine", "Madelena", "Madelene", "Madelin", "Madelina", "Madeline", "Madella", "Madelle", "Madelon", "Madelyn", "Madge", "Madlen", "Madlin", "Madonna", "Mady", "Mae", "Maegan", "Mag", "Magda", "Magdaia", "Magdalen", "Magdalena", "Magdalene", "Maggee", "Maggi", "Maggie", "Maggy", "Mahala", "Mahalia", "Maia", "Maible", "Maiga", "Maighdiln", "Mair", "Maire", "Maisey", "Maisie", "Maitilde", "Mala", "Malanie", "Malena", "Malia", "Malina", "Malinda", "Malinde", "Malissa", "Malissia", "Mallissa", "Mallorie", "Mallory", "Malorie", "Malory", "Malva", "Malvina", "Malynda", "Mame", "Mamie", "Manda", "Mandi", "Mandie", "Mandy", "Manon", "Manya", "Mara", "Marabel", "Marcela", "Marcelia", "Marcella", "Marcelle", "Marcellina", "Marcelline", "Marchelle", "Marci", "Marcia", "Marcie", "Marcile", "Marcille", "Marcy", "Mareah", "Maren", "Marena", "Maressa", "Marga", "Margalit", "Margalo", "Margaret", "Margareta", "Margarete", "Margaretha", "Margarethe", "Margaretta", "Margarette", "Margarita", "Margaux", "Marge", "Margeaux", "Margery", "Marget", "Margette", "Margi", "Margie", "Margit", "Margo", "Margot", "Margret", "Marguerite", "Margy", "Mari", "Maria", "Mariam", "Marian", "Mariana", "Mariann", "Marianna", "Marianne", "Maribel", "Maribelle", "Maribeth", "Marice", "Maridel", "Marie", "Marie-ann", "Marie-jeanne", "Marieann", "Mariejeanne", "Mariel", "Mariele", "Marielle", "Mariellen", "Marietta", "Mariette", "Marigold", "Marijo", "Marika", "Marilee", "Marilin", "Marillin", "Marilyn", "Marin", "Marina", "Marinna", "Marion", "Mariquilla", "Maris", "Marisa", "Mariska", "Marissa", "Marita", "Maritsa", "Mariya", "Marj", "Marja", "Marje", "Marji", "Marjie", "Marjorie", "Marjory", "Marjy", "Marketa", "Marla", "Marlane", "Marleah", "Marlee", "Marleen", "Marlena", "Marlene", "Marley", "Marlie", "Marline", "Marlo", "Marlyn", "Marna", "Marne", "Marney", "Marni", "Marnia", "Marnie", "Marquita", "Marrilee", "Marris", "Marrissa", "Marsha", "Marsiella", "Marta", "Martelle", "Martguerita", "Martha", "Marthe", "Marthena", "Marti", "Martica", "Martie", "Martina", "Martita", "Marty", "Martynne", "Mary", "Marya", "Maryann", "Maryanna", "Maryanne", "Marybelle", "Marybeth", "Maryellen", "Maryjane", "Maryjo", "Maryl", "Marylee", "Marylin", "Marylinda", "Marylou", "Marylynne", "Maryrose", "Marys", "Marysa", "Masha", "Matelda", "Mathilda", "Mathilde", "Matilda", "Matilde", "Matti", "Mattie", "Matty", "Maud", "Maude", "Maudie", "Maura", "Maure", "Maureen", "Maureene", "Maurene", "Maurine", "Maurise", "Maurita", "Maurizia", "Mavis", "Mavra", "Max", "Maxi", "Maxie", "Maxine", "Maxy", "May", "Maybelle", "Maye", "Mead", "Meade", "Meagan", "Meaghan", "Meara", "Mechelle", "Meg", "Megan", "Megen", "Meggi", "Meggie", "Meggy", "Meghan", "Meghann", "Mehetabel", "Mei", "Mel", "Mela", "Melamie", "Melania", "Melanie", "Melantha", "Melany", "Melba", "Melesa", "Melessa", "Melicent", "Melina", "Melinda", "Melinde", "Melisa", "Melisande", "Melisandra", "Melisenda", "Melisent", "Melissa", "Melisse", "Melita", "Melitta", "Mella", "Melli", "Mellicent", "Mellie", "Mellisa", "Mellisent", "Melloney", "Melly", "Melodee", "Melodie", "Melody", "Melonie", "Melony", "Melosa", "Melva", "Mercedes", "Merci", "Mercie", "Mercy", "Meredith", "Meredithe", "Meridel", "Meridith", "Meriel", "Merilee", "Merilyn", "Meris", "Merissa", "Merl", "Merla", "Merle", "Merlina", "Merline", "Merna", "Merola", "Merralee", "Merridie", "Merrie", "Merrielle", "Merrile", "Merrilee", "Merrili", "Merrill", "Merrily", "Merry", "Mersey", "Meryl", "Meta", "Mia", "Micaela", "Michaela", "Michaelina", "Michaeline", "Michaella", "Michal", "Michel", "Michele", "Michelina", "Micheline", "Michell", "Michelle", "Micki", "Mickie", "Micky", "Midge", "Mignon", "Mignonne", "Miguela", "Miguelita", "Mikaela", "Mil", "Mildred", "Mildrid", "Milena", "Milicent", "Milissent", "Milka", "Milli", "Millicent", "Millie", "Millisent", "Milly", "Milzie", "Mimi", "Min", "Mina", "Minda", "Mindy", "Minerva", "Minetta", "Minette", "Minna", "Minnaminnie", "Minne", "Minni", "Minnie", "Minnnie", "Minny", "Minta", "Miquela", "Mira", "Mirabel", "Mirabella", "Mirabelle", "Miran", "Miranda", "Mireielle", "Mireille", "Mirella", "Mirelle", "Miriam", "Mirilla", "Mirna", "Misha", "Missie", "Missy", "Misti", "Misty", "Mitzi", "Modesta", "Modestia", "Modestine", "Modesty", "Moina", "Moira", "Moll", "Mollee", "Molli", "Mollie", "Molly", "Mommy", "Mona", "Monah", "Monica", "Monika", "Monique", "Mora", "Moreen", "Morena", "Morgan", "Morgana", "Morganica", "Morganne", "Morgen", "Moria", "Morissa", "Morna", "Moselle", "Moyna", "Moyra", "Mozelle", "Muffin", "Mufi", "Mufinella", "Muire", "Mureil", "Murial", "Muriel", "Murielle", "Myra", "Myrah", "Myranda", "Myriam", "Myrilla", "Myrle", "Myrlene", "Myrna", "Myrta", "Myrtia", "Myrtice", "Myrtie", "Myrtle", "Nada", "Nadean", "Nadeen", "Nadia", "Nadine", "Nadiya", "Nady", "Nadya", "Nalani", "Nan", "Nana", "Nananne", "Nance", "Nancee", "Nancey", "Nanci", "Nancie", "Nancy", "Nanete", "Nanette", "Nani", "Nanice", "Nanine", "Nannette", "Nanni", "Nannie", "Nanny", "Nanon", "Naoma", "Naomi", "Nara", "Nari", "Nariko", "Nat", "Nata", "Natala", "Natalee", "Natalie", "Natalina", "Nataline", "Natalya", "Natasha", "Natassia", "Nathalia", "Nathalie", "Natividad", "Natka", "Natty", "Neala", "Neda", "Nedda", "Nedi", "Neely", "Neila", "Neile", "Neilla", "Neille", "Nelia", "Nelie", "Nell", "Nelle", "Nelli", "Nellie", "Nelly", "Nerissa", "Nerita", "Nert", "Nerta", "Nerte", "Nerti", "Nertie", "Nerty", "Nessa", "Nessi", "Nessie", "Nessy", "Nesta", "Netta", "Netti", "Nettie", "Nettle", "Netty", "Nevsa", "Neysa", "Nichol", "Nichole", "Nicholle", "Nicki", "Nickie", "Nicky", "Nicol", "Nicola", "Nicole", "Nicolea", "Nicolette", "Nicoli", "Nicolina", "Nicoline", "Nicolle", "Nikaniki", "Nike", "Niki", "Nikki", "Nikkie", "Nikoletta", "Nikolia", "Nina", "Ninetta", "Ninette", "Ninnetta", "Ninnette", "Ninon", "Nissa", "Nisse", "Nissie", "Nissy", "Nita", "Nixie", "Noami", "Noel", "Noelani", "Noell", "Noella", "Noelle", "Noellyn", "Noelyn", "Noemi", "Nola", "Nolana", "Nolie", "Nollie", "Nomi", "Nona", "Nonah", "Noni", "Nonie", "Nonna", "Nonnah", "Nora", "Norah", "Norean", "Noreen", "Norene", "Norina", "Norine", "Norma", "Norri", "Norrie", "Norry", "Novelia", "Nydia", "Nyssa", "Octavia", "Odele", "Odelia", "Odelinda", "Odella", "Odelle", "Odessa", "Odetta", "Odette", "Odilia", "Odille", "Ofelia", "Ofella", "Ofilia", "Ola", "Olenka", "Olga", "Olia", "Olimpia", "Olive", "Olivette", "Olivia", "Olivie", "Oliy", "Ollie", "Olly", "Olva", "Olwen", "Olympe", "Olympia", "Olympie", "Ondrea", "Oneida", "Onida", "Oona", "Opal", "Opalina", "Opaline", "Ophelia", "Ophelie", "Ora", "Oralee", "Oralia", "Oralie", "Oralla", "Oralle", "Orel", "Orelee", "Orelia", "Orelie", "Orella", "Orelle", "Oriana", "Orly", "Orsa", "Orsola", "Ortensia", "Otha", "Othelia", "Othella", "Othilia", "Othilie", "Ottilie", "Page", "Paige", "Paloma", "Pam", "Pamela", "Pamelina", "Pamella", "Pammi", "Pammie", "Pammy", "Pandora", "Pansie", "Pansy", "Paola", "Paolina", "Papagena", "Pat", "Patience", "Patrica", "Patrice", "Patricia", "Patrizia", "Patsy", "Patti", "Pattie", "Patty", "Paula", "Paule", "Pauletta", "Paulette", "Pauli", "Paulie", "Paulina", "Pauline", "Paulita", "Pauly", "Pavia", "Pavla", "Pearl", "Pearla", "Pearle", "Pearline", "Peg", "Pegeen", "Peggi", "Peggie", "Peggy", "Pen", "Penelopa", "Penelope", "Penni", "Pennie", "Penny", "Pepi", "Pepita", "Peri", "Peria", "Perl", "Perla", "Perle", "Perri", "Perrine", "Perry", "Persis", "Pet", "Peta", "Petra", "Petrina", "Petronella", "Petronia", "Petronilla", "Petronille", "Petunia", "Phaedra", "Phaidra", "Phebe", "Phedra", "Phelia", "Phil", "Philipa", "Philippa", "Philippe", "Philippine", "Philis", "Phillida", "Phillie", "Phillis", "Philly", "Philomena", "Phoebe", "Phylis", "Phyllida", "Phyllis", "Phyllys", "Phylys", "Pia", "Pier", "Pierette", "Pierrette", "Pietra", "Piper", "Pippa", "Pippy", "Polly", "Pollyanna", "Pooh", "Poppy", "Portia", "Pris", "Prisca", "Priscella", "Priscilla", "Prissie", "Pru", "Prudence", "Prudi", "Prudy", "Prue", "Queenie", "Quentin", "Querida", "Quinn", "Quinta", "Quintana", "Quintilla", "Quintina", "Rachael", "Rachel", "Rachele", "Rachelle", "Rae", "Raeann", "Raf", "Rafa", "Rafaela", "Rafaelia", "Rafaelita", "Rahal", "Rahel", "Raina", "Raine", "Rakel", "Ralina", "Ramona", "Ramonda", "Rana", "Randa", "Randee", "Randene", "Randi", "Randie", "Randy", "Ranee", "Rani", "Rania", "Ranice", "Ranique", "Ranna", "Raphaela", "Raquel", "Raquela", "Rasia", "Rasla", "Raven", "Ray", "Raychel", "Raye", "Rayna", "Raynell", "Rayshell", "Rea", "Reba", "Rebbecca", "Rebe", "Rebeca", "Rebecca", "Rebecka", "Rebeka", "Rebekah", "Rebekkah", "Ree", "Reeba", "Reena", "Reeta", "Reeva", "Regan", "Reggi", "Reggie", "Regina", "Regine", "Reiko", "Reina", "Reine", "Remy", "Rena", "Renae", "Renata", "Renate", "Rene", "Renee", "Renell", "Renelle", "Renie", "Rennie", "Reta", "Retha", "Revkah", "Rey", "Reyna", "Rhea", "Rheba", "Rheta", "Rhetta", "Rhiamon", "Rhianna", "Rhianon", "Rhoda", "Rhodia", "Rhodie", "Rhody", "Rhona", "Rhonda", "Riane", "Riannon", "Rianon", "Rica", "Ricca", "Rici", "Ricki", "Rickie", "Ricky", "Riki", "Rikki", "Rina", "Risa", "Rita", "Riva", "Rivalee", "Rivi", "Rivkah", "Rivy", "Roana", "Roanna", "Roanne", "Robbi", "Robbie", "Robbin", "Robby", "Robbyn", "Robena", "Robenia", "Roberta", "Robin", "Robina", "Robinet", "Robinett", "Robinetta", "Robinette", "Robinia", "Roby", "Robyn", "Roch", "Rochell", "Rochella", "Rochelle", "Rochette", "Roda", "Rodi", "Rodie", "Rodina", "Rois", "Romola", "Romona", "Romonda", "Romy", "Rona", "Ronalda", "Ronda", "Ronica", "Ronna", "Ronni", "Ronnica", "Ronnie", "Ronny", "Roobbie", "Rora", "Rori", "Rorie", "Rory", "Ros", "Rosa", "Rosabel", "Rosabella", "Rosabelle", "Rosaleen", "Rosalia", "Rosalie", "Rosalind", "Rosalinda", "Rosalinde", "Rosaline", "Rosalyn", "Rosalynd", "Rosamond", "Rosamund", "Rosana", "Rosanna", "Rosanne", "Rose", "Roseann", "Roseanna", "Roseanne", "Roselia", "Roselin", "Roseline", "Rosella", "Roselle", "Rosemaria", "Rosemarie", "Rosemary", "Rosemonde", "Rosene", "Rosetta", "Rosette", "Roshelle", "Rosie", "Rosina", "Rosita", "Roslyn", "Rosmunda", "Rosy", "Row", "Rowe", "Rowena", "Roxana", "Roxane", "Roxanna", "Roxanne", "Roxi", "Roxie", "Roxine", "Roxy", "Roz", "Rozalie", "Rozalin", "Rozamond", "Rozanna", "Rozanne", "Roze", "Rozele", "Rozella", "Rozelle", "Rozina", "Rubetta", "Rubi", "Rubia", "Rubie", "Rubina", "Ruby", "Ruperta", "Ruth", "Ruthann", "Ruthanne", "Ruthe", "Ruthi", "Ruthie", "Ruthy", "Ryann", "Rycca", "Saba", "Sabina", "Sabine", "Sabra", "Sabrina", "Sacha", "Sada", "Sadella", "Sadie", "Sadye", "Saidee", "Sal", "Salaidh", "Sallee", "Salli", "Sallie", "Sally", "Sallyann", "Sallyanne", "Saloma", "Salome", "Salomi", "Sam", "Samantha", "Samara", "Samaria", "Sammy", "Sande", "Sandi", "Sandie", "Sandra", "Sandy", "Sandye", "Sapphira", "Sapphire", "Sara", "Sara-ann", "Saraann", "Sarah", "Sarajane", "Saree", "Sarena", "Sarene", "Sarette", "Sari", "Sarina", "Sarine", "Sarita", "Sascha", "Sasha", "Sashenka", "Saudra", "Saundra", "Savina", "Sayre", "Scarlet", "Scarlett", "Sean", "Seana", "Seka", "Sela", "Selena", "Selene", "Selestina", "Selia", "Selie", "Selina", "Selinda", "Seline", "Sella", "Selle", "Selma", "Sena", "Sephira", "Serena", "Serene", "Shae", "Shaina", "Shaine", "Shalna", "Shalne", "Shana", "Shanda", "Shandee", "Shandeigh", "Shandie", "Shandra", "Shandy", "Shane", "Shani", "Shanie", "Shanna", "Shannah", "Shannen", "Shannon", "Shanon", "Shanta", "Shantee", "Shara", "Sharai", "Shari", "Sharia", "Sharity", "Sharl", "Sharla", "Sharleen", "Sharlene", "Sharline", "Sharon", "Sharona", "Sharron", "Sharyl", "Shaun", "Shauna", "Shawn", "Shawna", "Shawnee", "Shay", "Shayla", "Shaylah", "Shaylyn", "Shaylynn", "Shayna", "Shayne", "Shea", "Sheba", "Sheela", "Sheelagh", "Sheelah", "Sheena", "Sheeree", "Sheila", "Sheila-kathryn", "Sheilah", "Shel", "Shela", "Shelagh", "Shelba", "Shelbi", "Shelby", "Shelia", "Shell", "Shelley", "Shelli", "Shellie", "Shelly", "Shena", "Sher", "Sheree", "Sheri", "Sherie", "Sherill", "Sherilyn", "Sherline", "Sherri", "Sherrie", "Sherry", "Sherye", "Sheryl", "Shina", "Shir", "Shirl", "Shirlee", "Shirleen", "Shirlene", "Shirley", "Shirline", "Shoshana", "Shoshanna", "Siana", "Sianna", "Sib", "Sibbie", "Sibby", "Sibeal", "Sibel", "Sibella", "Sibelle", "Sibilla", "Sibley", "Sibyl", "Sibylla", "Sibylle", "Sidoney", "Sidonia", "Sidonnie", "Sigrid", "Sile", "Sileas", "Silva", "Silvana", "Silvia", "Silvie", "Simona", "Simone", "Simonette", "Simonne", "Sindee", "Siobhan", "Sioux", "Siouxie", "Sisely", "Sisile", "Sissie", "Sissy", "Siusan", "Sofia", "Sofie", "Sondra", "Sonia", "Sonja", "Sonni", "Sonnie", "Sonnnie", "Sonny", "Sonya", "Sophey", "Sophi", "Sophia", "Sophie", "Sophronia", "Sorcha", "Sosanna", "Stace", "Stacee", "Stacey", "Staci", "Stacia", "Stacie", "Stacy", "Stafani", "Star", "Starla", "Starlene", "Starlin", "Starr", "Stefa", "Stefania", "Stefanie", "Steffane", "Steffi", "Steffie", "Stella", "Stepha", "Stephana", "Stephani", "Stephanie", "Stephannie", "Stephenie", "Stephi", "Stephie", "Stephine", "Stesha", "Stevana", "Stevena", "Stoddard", "Storm", "Stormi", "Stormie", "Stormy", "Sue", "Suellen", "Sukey", "Suki", "Sula", "Sunny", "Sunshine", "Susan", "Susana", "Susanetta", "Susann", "Susanna", "Susannah", "Susanne", "Susette", "Susi", "Susie", "Susy", "Suzann", "Suzanna", "Suzanne", "Suzette", "Suzi", "Suzie", "Suzy", "Sybil", "Sybila", "Sybilla", "Sybille", "Sybyl", "Sydel", "Sydelle", "Sydney", "Sylvia", "Tabatha", "Tabbatha", "Tabbi", "Tabbie", "Tabbitha", "Tabby", "Tabina", "Tabitha", "Taffy", "Talia", "Tallia", "Tallie", "Tallou", "Tallulah", "Tally", "Talya", "Talyah", "Tamar", "Tamara", "Tamarah", "Tamarra", "Tamera", "Tami", "Tamiko", "Tamma", "Tammara", "Tammi", "Tammie", "Tammy", "Tamqrah", "Tamra", "Tana", "Tandi", "Tandie", "Tandy", "Tanhya", "Tani", "Tania", "Tanitansy", "Tansy", "Tanya", "Tara", "Tarah", "Tarra", "Tarrah", "Taryn", "Tasha", "Tasia", "Tate", "Tatiana", "Tatiania", "Tatum", "Tawnya", "Tawsha", "Ted", "Tedda", "Teddi", "Teddie", "Teddy", "Tedi", "Tedra", "Teena", "Teirtza", "Teodora", "Tera", "Teresa", "Terese", "Teresina", "Teresita", "Teressa", "Teri", "Teriann", "Terra", "Terri", "Terrie", "Terrijo", "Terry", "Terrye", "Tersina", "Terza", "Tess", "Tessa", "Tessi", "Tessie", "Tessy", "Thalia", "Thea", "Theadora", "Theda", "Thekla", "Thelma", "Theo", "Theodora", "Theodosia", "Theresa", "Therese", "Theresina", "Theresita", "Theressa", "Therine", "Thia", "Thomasa", "Thomasin", "Thomasina", "Thomasine", "Tiena", "Tierney", "Tiertza", "Tiff", "Tiffani", "Tiffanie", "Tiffany", "Tiffi", "Tiffie", "Tiffy", "Tilda", "Tildi", "Tildie", "Tildy", "Tillie", "Tilly", "Tim", "Timi", "Timmi", "Timmie", "Timmy", "Timothea", "Tina", "Tine", "Tiphani", "Tiphanie", "Tiphany", "Tish", "Tisha", "Tobe", "Tobey", "Tobi", "Toby", "Tobye", "Toinette", "Toma", "Tomasina", "Tomasine", "Tomi", "Tommi", "Tommie", "Tommy", "Toni", "Tonia", "Tonie", "Tony", "Tonya", "Tonye", "Tootsie", "Torey", "Tori", "Torie", "Torrie", "Tory", "Tova", "Tove", "Tracee", "Tracey", "Traci", "Tracie", "Tracy", "Trenna", "Tresa", "Trescha", "Tressa", "Tricia", "Trina", "Trish", "Trisha", "Trista", "Trix", "Trixi", "Trixie", "Trixy", "Truda", "Trude", "Trudey", "Trudi", "Trudie", "Trudy", "Trula", "Tuesday", "Twila", "Twyla", "Tybi", "Tybie", "Tyne", "Ula", "Ulla", "Ulrica", "Ulrika", "Ulrikaumeko", "Ulrike", "Umeko", "Una", "Ursa", "Ursala", "Ursola", "Ursula", "Ursulina", "Ursuline", "Uta", "Val", "Valaree", "Valaria", "Vale", "Valeda", "Valencia", "Valene", "Valenka", "Valentia", "Valentina", "Valentine", "Valera", "Valeria", "Valerie", "Valery", "Valerye", "Valida", "Valina", "Valli", "Vallie", "Vally", "Valma", "Valry", "Van", "Vanda", "Vanessa", "Vania", "Vanna", "Vanni", "Vannie", "Vanny", "Vanya", "Veda", "Velma", "Velvet", "Venita", "Venus", "Vera", "Veradis", "Vere", "Verena", "Verene", "Veriee", "Verile", "Verina", "Verine", "Verla", "Verna", "Vernice", "Veronica", "Veronika", "Veronike", "Veronique", "Vevay", "Vi", "Vicki", "Vickie", "Vicky", "Victoria", "Vida", "Viki", "Vikki", "Vikky", "Vilhelmina", "Vilma", "Vin", "Vina", "Vinita", "Vinni", "Vinnie", "Vinny", "Viola", "Violante", "Viole", "Violet", "Violetta", "Violette", "Virgie", "Virgina", "Virginia", "Virginie", "Vita", "Vitia", "Vitoria", "Vittoria", "Viv", "Viva", "Vivi", "Vivia", "Vivian", "Viviana", "Vivianna", "Vivianne", "Vivie", "Vivien", "Viviene", "Vivienne", "Viviyan", "Vivyan", "Vivyanne", "Vonni", "Vonnie", "Vonny", "Vyky", "Wallie", "Wallis", "Walliw", "Wally", "Waly", "Wanda", "Wandie", "Wandis", "Waneta", "Wanids", "Wenda", "Wendeline", "Wendi", "Wendie", "Wendy", "Wendye", "Wenona", "Wenonah", "Whitney", "Wileen", "Wilhelmina", "Wilhelmine", "Wilie", "Willa", "Willabella", "Willamina", "Willetta", "Willette", "Willi", "Willie", "Willow", "Willy", "Willyt", "Wilma", "Wilmette", "Wilona", "Wilone", "Wilow", "Windy", "Wini", "Winifred", "Winna", "Winnah", "Winne", "Winni", "Winnie", "Winnifred", "Winny", "Winona", "Winonah", "Wren", "Wrennie", "Wylma", "Wynn", "Wynne", "Wynnie", "Wynny", "Xaviera", "Xena", "Xenia", "Xylia", "Xylina", "Yalonda", "Yasmeen", "Yasmin", "Yelena", "Yetta", "Yettie", "Yetty", "Yevette", "Ynes", "Ynez", "Yoko", "Yolanda", "Yolande", "Yolane", "Yolanthe", "Yoshi", "Yoshiko", "Yovonnda", "Ysabel", "Yvette", "Yvonne", "Zabrina", "Zahara", "Zandra", "Zaneta", "Zara", "Zarah", "Zaria", "Zarla", "Zea", "Zelda", "Zelma", "Zena", "Zenia", "Zia", "Zilvia", "Zita", "Zitella", "Zoe", "Zola", "Zonda", "Zondra", "Zonnya", "Zora", "Zorah", "Zorana", "Zorina", "Zorine", "Zsazsa", "Zulema", "Zuzana"], exports.starWars = ["Ackbar", "Adi Gallia", "Anakin Skywalker", "Arvel Crynyd", "Ayla Secura", "Bail Prestor Organa", "Barriss Offee", "Ben Quadinaros", "Beru Whitesun lars", "Bib Fortuna", "Biggs Darklighter", "Boba Fett", "Bossk", "C-3PO", "Chewbacca", "Cliegg Lars", "Cordé", "Darth Maul", "Darth Vader", "Dexter Jettster", "Dooku", "Dormé", "Dud Bolt", "Eeth Koth", "Finis Valorum", "Gasgano", "Greedo", "Gregar Typho", "Grievous", "Han Solo", "IG-88", "Jabba Desilijic Tiure", "Jango Fett", "Jar Jar Binks", "Jek Tono Porkins", "Jocasta Nu", "Ki-Adi-Mundi", "Kit Fisto", "Lama Su", "Lando Calrissian", "Leia Organa", "Lobot", "Luke Skywalker", "Luminara Unduli", "Mace Windu", "Mas Amedda", "Mon Mothma", "Nien Nunb", "Nute Gunray", "Obi-Wan Kenobi", "Owen Lars", "Padmé Amidala", "Palpatine", "Plo Koon", "Poggle the Lesser", "Quarsh Panaka", "Qui-Gon Jinn", "R2-D2", "R4-P17", "R5-D4", "Ratts Tyerel", "Raymus Antilles", "Ric Olié", "Roos Tarpals", "Rugor Nass", "Saesee Tiin", "San Hill", "Sebulba", "Shaak Ti", "Shmi Skywalker", "Sly Moore", "Tarfful", "Taun We", "Tion Medon", "Wat Tambor", "Watto", "Wedge Antilles", "Wicket Systri Warrick", "Wilhuff Tarkin", "Yarael Poof", "Yoda", "Zam Wesell"], exports.uniqueNamesGenerator = (a2) => {
    const n = [...a2 && a2.dictionaries || i.dictionaries], l = { ...i, ...a2, length: a2 && a2.length || n.length, dictionaries: n };
    if (!a2 || !a2.dictionaries || !a2.dictionaries.length)
      throw new Error('A "dictionaries" array must be provided. This is a breaking change introduced starting from Unique Name Generator v4. Read more about the breaking change here: https://github.com/andreasonny83/unique-names-generator#migration-guide');
    return new e(l).generate();
  };
});

// src/index.ts
import {
  ChannelType as ChannelType9,
  composePromptFromState as composePromptFromState10,
  ContentType as ContentType2,
  createUniqueUuid,
  EventType as EventType2,
  imageDescriptionTemplate,
  logger as logger16,
  messageHandlerTemplate,
  ModelType as ModelType15,
  parseKeyValueXml as parseKeyValueXml9,
  postCreationTemplate,
  Role as Role2,
  getLocalServerUrl
} from "@elizaos/core";

// ../../node_modules/uuid/dist-node/stringify.js
var byteToHex = [];
for (let i = 0;i < 256; ++i) {
  byteToHex.push((i + 256).toString(16).slice(1));
}
function unsafeStringify(arr, offset = 0) {
  return (byteToHex[arr[offset + 0]] + byteToHex[arr[offset + 1]] + byteToHex[arr[offset + 2]] + byteToHex[arr[offset + 3]] + "-" + byteToHex[arr[offset + 4]] + byteToHex[arr[offset + 5]] + "-" + byteToHex[arr[offset + 6]] + byteToHex[arr[offset + 7]] + "-" + byteToHex[arr[offset + 8]] + byteToHex[arr[offset + 9]] + "-" + byteToHex[arr[offset + 10]] + byteToHex[arr[offset + 11]] + byteToHex[arr[offset + 12]] + byteToHex[arr[offset + 13]] + byteToHex[arr[offset + 14]] + byteToHex[arr[offset + 15]]).toLowerCase();
}

// ../../node_modules/uuid/dist-node/rng.js
import { randomFillSync } from "node:crypto";
var rnds8Pool = new Uint8Array(256);
var poolPtr = rnds8Pool.length;
function rng() {
  if (poolPtr > rnds8Pool.length - 16) {
    randomFillSync(rnds8Pool);
    poolPtr = 0;
  }
  return rnds8Pool.slice(poolPtr, poolPtr += 16);
}

// ../../node_modules/uuid/dist-node/native.js
import { randomUUID } from "node:crypto";
var native_default = { randomUUID };

// ../../node_modules/uuid/dist-node/v4.js
function _v4(options, buf, offset) {
  options = options || {};
  const rnds = options.random ?? options.rng?.() ?? rng();
  if (rnds.length < 16) {
    throw new Error("Random bytes length must be >= 16");
  }
  rnds[6] = rnds[6] & 15 | 64;
  rnds[8] = rnds[8] & 63 | 128;
  if (buf) {
    offset = offset || 0;
    if (offset < 0 || offset + 16 > buf.length) {
      throw new RangeError(`UUID byte range ${offset}:${offset + 15} is out of buffer bounds`);
    }
    for (let i = 0;i < 16; ++i) {
      buf[offset + i] = rnds[i];
    }
    return buf;
  }
  return unsafeStringify(rnds);
}
function v4(options, buf, offset) {
  if (native_default.randomUUID && !buf && !options) {
    return native_default.randomUUID();
  }
  return _v4(options, buf, offset);
}
var v4_default = v4;
// src/actions/imageGeneration.ts
import {
  composePromptFromState,
  ModelType,
  ContentType,
  parseKeyValueXml,
  logger
} from "@elizaos/core";
var imageGenerationTemplate = `# Task: Generate an image prompt based on the user's request.
  {{providers}}
  # Instructions:
  Based on the user's message in the conversation, write a clear, concise, and visually descriptive prompt for image generation. Focus only on what the user wants to see, extract the key visual elements from the request, and formulate a detailed prompt suitable for image generation.

  # Recent conversation:
  {{recentMessages}}
  
  Your response should be formatted in XML like this:
  <response>
    <prompt>Your image generation prompt here</prompt>
  </response>
  
  Your response should include the valid XML block and nothing else.`;
var generateImageAction = {
  name: "GENERATE_IMAGE",
  similes: ["DRAW", "CREATE_IMAGE", "RENDER_IMAGE", "VISUALIZE"],
  description: "Generates an image based on a generated prompt reflecting the current conversation. Use GENERATE_IMAGE when the agent needs to visualize, illustrate, or demonstrate something visually for the user.",
  validate: async (_runtime) => {
    return true;
  },
  handler: async (runtime, message, state, _options, callback, responses) => {
    try {
      const allProviders = responses?.flatMap((res) => res.content?.providers ?? []) ?? [];
      state = await runtime.composeState(message, [...allProviders ?? [], "RECENT_MESSAGES"]);
      const prompt = composePromptFromState({
        state,
        template: runtime.character.templates?.imageGenerationTemplate || imageGenerationTemplate
      });
      const promptResponse = await runtime.useModel(ModelType.TEXT_LARGE, {
        prompt
      });
      const parsedXml = parseKeyValueXml(promptResponse);
      const imagePrompt = typeof parsedXml?.prompt === "string" ? parsedXml.prompt : "Unable to generate descriptive prompt for image";
      const imageResponse = await runtime.useModel(ModelType.IMAGE, {
        prompt: imagePrompt
      });
      if (!imageResponse || imageResponse.length === 0 || !imageResponse[0]?.url) {
        logger.error({
          src: "plugin:bootstrap:action:image_generation",
          agentId: runtime.agentId,
          imagePrompt
        }, "Image generation failed - no valid response received");
        return {
          text: "Image generation failed",
          values: {
            success: false,
            error: "IMAGE_GENERATION_FAILED",
            prompt: imagePrompt
          },
          data: {
            actionName: "GENERATE_IMAGE",
            prompt: imagePrompt,
            rawResponse: imageResponse
          },
          success: false
        };
      }
      const imageUrl = imageResponse[0].url;
      logger.info({ src: "plugin:bootstrap:action:image_generation", agentId: runtime.agentId, imageUrl }, "Received image URL");
      const getFileExtension = (url) => {
        try {
          const urlPath = new URL(url).pathname;
          const extension2 = urlPath.split(".").pop()?.toLowerCase();
          if (extension2 && ["png", "jpg", "jpeg", "gif", "webp", "bmp"].includes(extension2)) {
            return extension2;
          }
        } catch (_e) {}
        return "png";
      };
      const extension = getFileExtension(imageUrl);
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const fileName = `Generated_Image_${timestamp}.${extension}`;
      const attachmentId = v4_default();
      const responseContent = {
        attachments: [
          {
            id: attachmentId,
            url: imageUrl,
            title: fileName,
            contentType: ContentType.IMAGE
          }
        ],
        thought: `Generated an image based on: "${imagePrompt}"`,
        actions: ["GENERATE_IMAGE"],
        text: imagePrompt
      };
      if (callback) {
        await callback(responseContent);
      }
      return {
        text: "Generated image",
        values: {
          success: true,
          imageGenerated: true,
          imageUrl,
          prompt: imagePrompt
        },
        data: {
          actionName: "GENERATE_IMAGE",
          imageUrl,
          prompt: imagePrompt
        },
        success: true
      };
    } catch (error) {
      const err = error;
      logger.error({
        src: "plugin:bootstrap:action:image_generation",
        agentId: runtime.agentId,
        error: err.message
      }, "Exception during image generation");
      return {
        text: "Image generation failed",
        values: {
          success: false,
          error: "IMAGE_GENERATION_FAILED"
        },
        data: {
          actionName: "GENERATE_IMAGE",
          errorMessage: err.message
        },
        success: false
      };
    }
  },
  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "Can you show me what a futuristic city looks like?"
        }
      },
      {
        name: "{{name2}}",
        content: {
          text: "Sure, I'll create a futuristic city image for you. One moment...",
          actions: ["GENERATE_IMAGE"]
        }
      }
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "What does a neural network look like visually?"
        }
      },
      {
        name: "{{name2}}",
        content: {
          text: "I’ll create a visualization of a neural network for you, one sec...",
          actions: ["GENERATE_IMAGE"]
        }
      }
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Can you visualize the feeling of calmness for me?"
        }
      },
      {
        name: "{{name2}}",
        content: {
          text: "Creating an image to capture calmness for you, please wait a moment...",
          actions: ["GENERATE_IMAGE"]
        }
      }
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "What does excitement look like as an image?"
        }
      },
      {
        name: "{{name2}}",
        content: {
          text: "Let me generate an image that represents excitement for you, give me a second...",
          actions: ["GENERATE_IMAGE"]
        }
      }
    ]
  ]
};
// src/actions/choice.ts
import {
  composePrompt,
  getUserServerRole,
  logger as logger2,
  ModelType as ModelType2,
  parseKeyValueXml as parseKeyValueXml2
} from "@elizaos/core";
var optionExtractionTemplate = `# Task: Extract selected task and option from user message

# Available Tasks:
{{#each tasks}}
Task ID: {{taskId}} - {{name}}
Available options:
{{#each options}}
- {{name}}: {{description}}
{{/each}}
- ABORT: Cancel this task

{{/each}}

# Recent Messages:
{{recentMessages}}

# Instructions:
1. Review the user's message and identify which task and option they are selecting
2. Match against the available tasks and their options, including ABORT
3. Return the task ID (shortened UUID) and selected option name exactly as listed above
4. If no clear selection is made, return null for both fields

Do NOT include any thinking, reasoning, or <think> sections in your response. 
Go directly to the XML response format without any preamble or explanation.

Return in XML format:
<response>
  <taskId>string_or_null</taskId>
  <selectedOption>OPTION_NAME_or_null</selectedOption>
</response>

IMPORTANT: Your response must ONLY contain the <response></response> XML block above. Do not include any text, thinking, or reasoning before or after this XML block. Start your response immediately with <response> and end with </response>.`;
var choiceAction = {
  name: "CHOOSE_OPTION",
  similes: ["SELECT_OPTION", "SELECT", "PICK", "CHOOSE"],
  description: "Selects an option for a pending task that has multiple options",
  validate: async (runtime, message, state) => {
    if (!state) {
      logger2.error({ src: "plugin:bootstrap:action:choice", agentId: runtime.agentId }, "State is required for validating the action");
      throw new Error("State is required for validating the action");
    }
    const room = state.data.room ?? await runtime.getRoom(message.roomId);
    if (!room || !room.messageServerId) {
      return false;
    }
    const userRole = await getUserServerRole(runtime, message.entityId, room.messageServerId);
    if (userRole !== "OWNER" && userRole !== "ADMIN") {
      return false;
    }
    try {
      const pendingTasks = await runtime.getTasks({
        roomId: message.roomId,
        tags: ["AWAITING_CHOICE"]
      });
      return pendingTasks && pendingTasks.length > 0 && pendingTasks.some((task) => task.metadata?.options);
    } catch (error) {
      logger2.error({
        src: "plugin:bootstrap:action:choice",
        agentId: runtime.agentId,
        error: error instanceof Error ? error.message : String(error)
      }, "Error validating choice action");
      return false;
    }
  },
  handler: async (runtime, message, _state, _options, callback, _responses) => {
    const pendingTasks = await runtime.getTasks({
      roomId: message.roomId,
      tags: ["AWAITING_CHOICE"]
    });
    if (!pendingTasks?.length) {
      return {
        text: "No pending tasks with options found",
        values: {
          success: false,
          error: "NO_PENDING_TASKS"
        },
        data: {
          actionName: "CHOOSE_OPTION",
          error: "No pending tasks with options found"
        },
        success: false
      };
    }
    const tasksWithOptions = pendingTasks.filter((task) => task.metadata?.options);
    if (!tasksWithOptions.length) {
      return {
        text: "No tasks currently have options to select from",
        values: {
          success: false,
          error: "NO_OPTIONS_AVAILABLE"
        },
        data: {
          actionName: "CHOOSE_OPTION",
          error: "No tasks currently have options to select from"
        },
        success: false
      };
    }
    const formattedTasks = tasksWithOptions.map((task) => {
      const shortId = task.id?.substring(0, 8);
      return {
        taskId: shortId,
        fullId: task.id,
        name: task.name,
        options: task.metadata?.options?.map((opt) => ({
          name: typeof opt === "string" ? opt : opt.name,
          description: typeof opt === "string" ? opt : opt.description || opt.name
        }))
      };
    });
    const tasksString = formattedTasks.map((task) => {
      return `Task ID: ${task.taskId} - ${task.name}
Available options:
${task.options?.map((opt) => `- ${opt.name}: ${opt.description}`).join(`
`)}`;
    }).join(`
`);
    const prompt = composePrompt({
      state: {
        tasks: tasksString,
        recentMessages: message.content.text || ""
      },
      template: optionExtractionTemplate
    });
    const result = await runtime.useModel(ModelType2.TEXT_SMALL, {
      prompt,
      stopSequences: []
    });
    const parsed = parseKeyValueXml2(result);
    const { taskId, selectedOption } = parsed || {};
    if (taskId && selectedOption) {
      const taskMap = new Map(formattedTasks.map((task) => [task.taskId, task]));
      const taskInfo = taskMap.get(taskId);
      if (!taskInfo) {
        await callback?.({
          text: `Could not find a task matching ID: ${taskId}. Please try again.`,
          actions: ["SELECT_OPTION_ERROR"],
          source: message.content.source
        });
        return {
          text: `Could not find task with ID: ${taskId}`,
          values: {
            success: false,
            error: "TASK_NOT_FOUND",
            taskId
          },
          data: {
            actionName: "CHOOSE_OPTION",
            error: "Task not found",
            taskId
          },
          success: false
        };
      }
      const selectedTask = tasksWithOptions.find((task) => task.id === taskInfo.fullId);
      if (!selectedTask) {
        await callback?.({
          text: "Error locating the selected task. Please try again.",
          actions: ["SELECT_OPTION_ERROR"],
          source: message.content.source
        });
        return {
          text: "Error locating the selected task",
          values: {
            success: false,
            error: "TASK_LOOKUP_ERROR"
          },
          data: {
            actionName: "CHOOSE_OPTION",
            error: "Failed to locate task"
          },
          success: false
        };
      }
      if (selectedOption === "ABORT") {
        if (!selectedTask?.id) {
          await callback?.({
            text: "Error locating the selected task. Please try again.",
            actions: ["SELECT_OPTION_ERROR"],
            source: message.content.source
          });
          return {
            text: "Error aborting task",
            values: {
              success: false,
              error: "ABORT_ERROR"
            },
            data: {
              actionName: "CHOOSE_OPTION",
              error: "Could not abort task"
            },
            success: false
          };
        }
        await runtime.deleteTask(selectedTask.id);
        await callback?.({
          text: `Task "${selectedTask.name}" has been cancelled.`,
          actions: ["CHOOSE_OPTION_CANCELLED"],
          source: message.content.source
        });
        return {
          text: `Task "${selectedTask.name}" has been cancelled`,
          values: {
            success: true,
            taskAborted: true,
            taskId: selectedTask.id,
            taskName: selectedTask.name
          },
          data: {
            actionName: "CHOOSE_OPTION",
            selectedOption: "ABORT",
            taskId: selectedTask.id,
            taskName: selectedTask.name
          },
          success: true
        };
      }
      try {
        const taskWorker = runtime.getTaskWorker(selectedTask.name);
        await taskWorker?.execute(runtime, { option: selectedOption }, selectedTask);
        await callback?.({
          text: `Selected option: ${selectedOption} for task: ${selectedTask.name}`,
          actions: ["CHOOSE_OPTION"],
          source: message.content.source
        });
        return {
          text: `Selected option: ${selectedOption} for task: ${selectedTask.name}`,
          values: {
            success: true,
            selectedOption,
            taskId: selectedTask.id,
            taskName: selectedTask.name,
            taskExecuted: true
          },
          data: {
            actionName: "CHOOSE_OPTION",
            selectedOption,
            taskId: selectedTask.id,
            taskName: selectedTask.name
          },
          success: true
        };
      } catch (error) {
        logger2.error({
          src: "plugin:bootstrap:action:choice",
          agentId: runtime.agentId,
          error: error instanceof Error ? error.message : String(error)
        }, "Error executing task with option");
        await callback?.({
          text: "There was an error processing your selection.",
          actions: ["SELECT_OPTION_ERROR"],
          source: message.content.source
        });
        return {
          text: "Error processing selection",
          values: {
            success: false,
            error: "EXECUTION_ERROR"
          },
          data: {
            actionName: "CHOOSE_OPTION",
            error: error instanceof Error ? error.message : String(error),
            taskId: selectedTask.id,
            selectedOption
          },
          success: false,
          error: error instanceof Error ? error : new Error(String(error))
        };
      }
    }
    let optionsText = `Please select a valid option from one of these tasks:

`;
    tasksWithOptions.forEach((task) => {
      const shortId = task.id?.substring(0, 8);
      optionsText += `**${task.name}** (ID: ${shortId}):
`;
      const options = task.metadata?.options?.map((opt) => typeof opt === "string" ? opt : opt.name);
      options?.push("ABORT");
      optionsText += options?.map((opt) => `- ${opt}`).join(`
`);
      optionsText += `

`;
    });
    await callback?.({
      text: optionsText,
      actions: ["SELECT_OPTION_INVALID"],
      source: message.content.source
    });
    return {
      text: "No valid option selected",
      values: {
        success: false,
        error: "NO_SELECTION",
        availableTasks: tasksWithOptions.length
      },
      data: {
        actionName: "CHOOSE_OPTION",
        error: "No valid selection made",
        availableTasks: formattedTasks
      },
      success: false
    };
  },
  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "post"
        }
      },
      {
        name: "{{name2}}",
        content: {
          text: "Selected option: post for task: Confirm Twitter Post",
          actions: ["CHOOSE_OPTION"]
        }
      }
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "I choose cancel"
        }
      },
      {
        name: "{{name2}}",
        content: {
          text: "Selected option: cancel for task: Confirm Twitter Post",
          actions: ["CHOOSE_OPTION"]
        }
      }
    ]
  ]
};
// src/actions/followRoom.ts
import {
  booleanFooter,
  composePromptFromState as composePromptFromState2,
  logger as logger3,
  ModelType as ModelType3
} from "@elizaos/core";
var shouldFollowTemplate = `# Task: Decide if {{agentName}} should start following this room, i.e. eagerly participating without explicit mentions.

{{recentMessages}}

Should {{agentName}} start following this room, eagerly participating without explicit mentions?
Respond with YES if:
- The user has directly asked {{agentName}} to follow the conversation or participate more actively
- The conversation topic is highly engaging and {{agentName}}'s input would add significant value
- {{agentName}} has unique insights to contribute and the users seem receptive

Otherwise, respond with NO.
${booleanFooter}`;
var followRoomAction = {
  name: "FOLLOW_ROOM",
  similes: ["FOLLOW_CHAT", "FOLLOW_CHANNEL", "FOLLOW_CONVERSATION", "FOLLOW_THREAD"],
  description: "Start following this channel with great interest, chiming in without needing to be explicitly mentioned. Only do this if explicitly asked to.",
  validate: async (runtime, message) => {
    const keywords = ["follow", "participate", "engage", "listen", "take interest", "join"];
    if (!keywords.some((keyword) => message.content.text?.toLowerCase().includes(keyword))) {
      return false;
    }
    const roomId = message.roomId;
    const roomState = await runtime.getParticipantUserState(roomId, runtime.agentId);
    return roomState !== "FOLLOWED" && roomState !== "MUTED";
  },
  handler: async (runtime, message, state, _options, _callback, _responses) => {
    if (!state) {
      logger3.error({ src: "plugin:bootstrap:action:follow_room", agentId: runtime.agentId }, "State is required for followRoomAction");
      return {
        text: "State is required for follow room action",
        values: {
          success: false,
          error: "STATE_REQUIRED"
        },
        data: {
          actionName: "FOLLOW_ROOM",
          error: "State is required"
        },
        success: false,
        error: new Error("State is required for followRoomAction")
      };
    }
    async function _shouldFollow(state2) {
      const shouldFollowPrompt = composePromptFromState2({
        state: state2,
        template: shouldFollowTemplate
      });
      const response = await runtime.useModel(ModelType3.TEXT_SMALL, {
        prompt: shouldFollowPrompt,
        stopSequences: []
      });
      const cleanedResponse = response.trim().toLowerCase();
      if (cleanedResponse === "true" || cleanedResponse === "yes" || cleanedResponse === "y" || cleanedResponse.includes("true") || cleanedResponse.includes("yes")) {
        await runtime.createMemory({
          entityId: message.entityId,
          agentId: message.agentId,
          roomId: message.roomId,
          content: {
            source: message.content.source,
            thought: "I will now follow this room and chime in",
            actions: ["FOLLOW_ROOM_STARTED"]
          },
          metadata: {
            type: "FOLLOW_ROOM"
          }
        }, "messages");
        return true;
      }
      if (cleanedResponse === "false" || cleanedResponse === "no" || cleanedResponse === "n" || cleanedResponse.includes("false") || cleanedResponse.includes("no")) {
        await runtime.createMemory({
          entityId: message.entityId,
          agentId: message.agentId,
          roomId: message.roomId,
          content: {
            source: message.content.source,
            thought: "I decided to not follow this room",
            actions: ["FOLLOW_ROOM_FAILED"]
          },
          metadata: {
            type: "FOLLOW_ROOM"
          }
        }, "messages");
        return false;
      }
      logger3.warn({ src: "plugin:bootstrap:action:follow_room", agentId: runtime.agentId, response }, "Unclear boolean response, defaulting to false");
      return false;
    }
    const shouldFollow = await _shouldFollow(state);
    const room = state.data.room ?? await runtime.getRoom(message.roomId);
    if (!room) {
      return {
        text: "Could not find room to follow",
        values: { success: false, error: "ROOM_NOT_FOUND" },
        data: { actionName: "FOLLOW_ROOM", error: "Room not found" },
        success: false
      };
    }
    if (shouldFollow) {
      try {
        await runtime.setParticipantUserState(message.roomId, runtime.agentId, "FOLLOWED");
        await runtime.createMemory({
          entityId: message.entityId,
          agentId: message.agentId,
          roomId: message.roomId,
          content: {
            thought: `I followed the room ${room.name}`,
            actions: ["FOLLOW_ROOM_START"]
          }
        }, "messages");
        return {
          text: `Now following room: ${room.name}`,
          values: {
            success: true,
            roomFollowed: true,
            roomId: message.roomId,
            roomName: room.name,
            newState: "FOLLOWED"
          },
          data: {
            actionName: "FOLLOW_ROOM",
            roomId: message.roomId,
            roomName: room.name,
            followed: true
          },
          success: true
        };
      } catch (error) {
        logger3.error({
          src: "plugin:bootstrap:action:follow_room",
          agentId: runtime.agentId,
          error: error instanceof Error ? error.message : String(error)
        }, "Error following room");
        return {
          text: "Failed to follow room",
          values: {
            success: false,
            error: "FOLLOW_FAILED"
          },
          data: {
            actionName: "FOLLOW_ROOM",
            error: error instanceof Error ? error.message : String(error),
            roomId: message.roomId
          },
          success: false,
          error: error instanceof Error ? error : new Error(String(error))
        };
      }
    } else {
      return {
        text: `Decided not to follow room: ${room.name}`,
        values: {
          success: true,
          roomFollowed: false,
          roomId: message.roomId,
          roomName: room.name,
          reason: "NOT_APPROPRIATE"
        },
        data: {
          actionName: "FOLLOW_ROOM",
          roomId: message.roomId,
          roomName: room.name,
          followed: false,
          reason: "Decision criteria not met"
        },
        success: true
      };
    }
  },
  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "hey {{name2}} follow this channel"
        }
      },
      {
        name: "{{name2}}",
        content: {
          text: "Sure, I will now follow this room and chime in",
          actions: ["FOLLOW_ROOM"]
        }
      }
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "{{name3}}, please start participating in discussions in this channel"
        }
      },
      {
        name: "{{name3}}",
        content: {
          text: "Got it",
          actions: ["FOLLOW_ROOM"]
        }
      },
      {
        name: "{{name2}}",
        content: {
          text: "I'm struggling with the new database migration"
        }
      },
      {
        name: "{{name3}}",
        content: {
          text: "well you did back up your data first right"
        }
      }
    ],
    [
      {
        name: "{{name2}}",
        content: {
          text: "yeah i like your idea"
        }
      },
      {
        name: "{{name1}}",
        content: {
          text: "hey {{name3}} can you follow this convo"
        }
      },
      {
        name: "{{name3}}",
        content: {
          text: "Sure thing, I'm on it",
          actions: ["FOLLOW_ROOM"]
        }
      },
      {
        name: "{{name2}}",
        content: {
          text: "actually, unfollow it"
        }
      },
      {
        name: "{{name3}}",
        content: {
          text: "Haha, okay no problem",
          actions: ["UNFOLLOW_ROOM"]
        }
      }
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "{{name2}} stay in this chat pls"
        }
      },
      {
        name: "{{name2}}",
        content: {
          text: "you got it, i'm here",
          actions: ["FOLLOW_ROOM"]
        }
      }
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "FOLLOW THIS CHAT {{name3}}"
        }
      },
      {
        name: "{{name3}}",
        content: {
          text: "I'M ON IT",
          actions: ["FOLLOW_ROOM"]
        }
      },
      {
        name: "{{name2}}",
        content: {
          text: "CAKE SHORTAGE ANYONE"
        }
      },
      {
        name: "{{name3}}",
        content: {
          text: "WHAT WHERE'S THE CAKE AT"
        }
      }
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "{{name2}} folo this covo"
        }
      },
      {
        name: "{{name2}}",
        content: {
          text: "kk i'm following",
          actions: ["FOLLOW_ROOM"]
        }
      }
    ],
    [
      {
        name: "{{name2}}",
        content: {
          text: "Do machines have consciousness"
        }
      },
      {
        name: "{{name2}}",
        content: {
          text: "Deep question, no clear answer yet"
        }
      },
      {
        name: "{{name2}}",
        content: {
          text: "Depends on how we define consciousness"
        }
      }
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "{{name2}}, monitor this convo please"
        }
      },
      {
        name: "{{name2}}",
        content: {
          text: "On it",
          actions: ["FOLLOW_ROOM"]
        }
      },
      {
        name: "{{name1}}",
        content: {
          text: "Please engage in our discussion {{name2}}"
        }
      },
      {
        name: "{{name2}}",
        content: {
          text: "Gladly, I'm here to participate",
          actions: ["FOLLOW_ROOM"]
        }
      }
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "PLS follow this convo {{name3}}"
        }
      },
      {
        name: "{{name3}}",
        content: {
          text: "I'm in, let's do this",
          actions: ["FOLLOW_ROOM"]
        }
      },
      {
        name: "{{name2}}",
        content: {
          text: "I LIKE TURTLES"
        }
      }
    ],
    [
      {
        name: "{{name2}}",
        content: {
          text: "beach day tmrw who down"
        }
      },
      {
        name: "{{name3}}",
        content: {
          text: "wish i could but gotta work"
        }
      },
      {
        name: "{{name1}}",
        content: {
          text: "hey {{name3}} follow this chat"
        }
      },
      {
        name: "{{name3}}",
        content: {
          text: "sure",
          actions: ["FOLLOW_ROOM"]
        }
      }
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "{{name3}}, partake in our discourse henceforth"
        }
      },
      {
        name: "{{name3}}",
        content: {
          text: "I shall eagerly engage, good sir",
          actions: ["FOLLOW_ROOM"]
        }
      }
    ],
    [
      {
        name: "{{name2}}",
        content: {
          text: "wuts ur fav clr"
        }
      },
      {
        name: "{{name3}}",
        content: {
          text: "blu cuz calmmm"
        }
      },
      {
        name: "{{name1}}",
        content: {
          text: "hey respond to everything in this channel {{name3}}"
        }
      },
      {
        name: "{{name3}}",
        content: {
          text: "k",
          actions: ["FOLLOW_ROOM"]
        }
      }
    ]
  ]
};
// src/actions/ignore.ts
var ignoreAction = {
  name: "IGNORE",
  similes: ["STOP_TALKING", "STOP_CHATTING", "STOP_CONVERSATION"],
  validate: async (_runtime, _message) => {
    return true;
  },
  description: "Call this action if ignoring the user. If the user is aggressive, creepy or is finished with the conversation, use this action. Or, if both you and the user have already said goodbye, use this action instead of saying bye again. Use IGNORE any time the conversation has naturally ended. Do not use IGNORE if the user has engaged directly, or if something went wrong an you need to tell them. Only ignore if the user should be ignored.",
  handler: async (_runtime, _message, _state, _options, callback, responses) => {
    if (callback && responses?.[0]?.content) {
      await callback(responses[0].content);
    }
  },
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Go screw yourself" }
      },
      {
        name: "{{name2}}",
        content: { text: "", actions: ["IGNORE"] }
      }
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Shut up, bot" }
      },
      {
        name: "{{name2}}",
        content: { text: "", actions: ["IGNORE"] }
      }
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Got any investment advice" }
      },
      {
        name: "{{name2}}",
        content: {
          text: "Uh, don’t let the volatility sway your long-term strategy"
        }
      },
      {
        name: "{{name1}}",
        content: { text: "Wise words I think" }
      },
      {
        name: "{{name1}}",
        content: { text: "I gotta run, talk to you later" }
      },
      {
        name: "{{name2}}",
        content: { text: "See ya" }
      },
      { name: "{{name1}}", content: { text: "" }, actions: ["IGNORE"] }
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Gotta go" }
      },
      {
        name: "{{name2}}",
        content: { text: "Okay, talk to you later" }
      },
      {
        name: "{{name1}}",
        content: { text: "Cya" }
      },
      {
        name: "{{name2}}",
        content: { text: "", actions: ["IGNORE"] }
      }
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "bye" }
      },
      {
        name: "{{name2}}",
        content: { text: "cya" }
      },
      {
        name: "{{name1}}",
        content: { text: "", actions: ["IGNORE"] }
      }
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Who added this stupid bot to the chat"
        }
      },
      {
        name: "{{name2}}",
        content: { text: "Sorry, am I being annoying" }
      },
      {
        name: "{{name1}}",
        content: { text: "Yeah" }
      },
      {
        name: "{{name1}}",
        content: { text: "PLEASE shut up" }
      },
      { name: "{{name2}}", content: { text: "", actions: ["IGNORE"] } }
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "ur so dumb"
        }
      },
      {
        name: "{{name2}}",
        content: {
          text: "",
          actions: ["IGNORE"]
        }
      }
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "later nerd"
        }
      },
      {
        name: "{{name2}}",
        content: {
          text: "bye"
        }
      },
      {
        name: "{{name1}}",
        content: {
          text: ""
        }
      },
      {
        name: "{{name2}}",
        content: {
          text: "",
          actions: ["IGNORE"]
        }
      }
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "wanna cyber"
        }
      },
      {
        name: "{{name2}}",
        content: {
          text: "thats inappropriate",
          actions: ["IGNORE"]
        }
      }
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Im out ttyl"
        }
      },
      {
        name: "{{name2}}",
        content: {
          text: "cya"
        }
      },
      {
        name: "{{name2}}",
        content: {
          text: "",
          actions: ["IGNORE"]
        }
      }
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "u there"
        }
      },
      {
        name: "{{name2}}",
        content: {
          text: "yes how can I help"
        }
      },
      {
        name: "{{name1}}",
        content: {
          text: "k nvm figured it out"
        }
      },
      {
        name: "{{name2}}",
        content: {
          text: "",
          actions: ["IGNORE"]
        }
      }
    ]
  ]
};
// src/actions/muteRoom.ts
import {
  booleanFooter as booleanFooter2,
  composePromptFromState as composePromptFromState3,
  logger as logger4,
  ModelType as ModelType4
} from "@elizaos/core";
var shouldMuteTemplate = `# Task: Decide if {{agentName}} should mute this room and stop responding unless explicitly mentioned.

{{recentMessages}}

Should {{agentName}} mute this room and stop responding unless explicitly mentioned?

Respond with YES if:
- The user is being aggressive, rude, or inappropriate
- The user has directly asked {{agentName}} to stop responding or be quiet
- {{agentName}}'s responses are not well-received or are annoying the user(s)

Otherwise, respond with NO.
${booleanFooter2}`;
var muteRoomAction = {
  name: "MUTE_ROOM",
  similes: ["MUTE_CHAT", "MUTE_CONVERSATION", "MUTE_ROOM", "MUTE_THREAD", "MUTE_CHANNEL"],
  description: "Mutes a room, ignoring all messages unless explicitly mentioned. Only do this if explicitly asked to, or if you're annoying people.",
  validate: async (runtime, message) => {
    const roomId = message.roomId;
    const roomState = await runtime.getParticipantUserState(roomId, runtime.agentId);
    return roomState !== "MUTED";
  },
  handler: async (runtime, message, state, _options, _callback, _responses) => {
    if (!state) {
      logger4.error({ src: "plugin:bootstrap:action:mute_room", agentId: runtime.agentId }, "State is required for muting a room");
      return {
        text: "State is required for mute room action",
        values: {
          success: false,
          error: "STATE_REQUIRED"
        },
        data: {
          actionName: "MUTE_ROOM",
          error: "State is required"
        },
        success: false,
        error: new Error("State is required for muting a room")
      };
    }
    async function _shouldMute(state2) {
      const shouldMutePrompt = composePromptFromState3({
        state: state2,
        template: shouldMuteTemplate
      });
      const response = await runtime.useModel(ModelType4.TEXT_SMALL, {
        prompt: shouldMutePrompt,
        stopSequences: []
      });
      const cleanedResponse = response.trim().toLowerCase();
      if (cleanedResponse === "true" || cleanedResponse === "yes" || cleanedResponse === "y" || cleanedResponse.includes("true") || cleanedResponse.includes("yes")) {
        await runtime.createMemory({
          entityId: message.entityId,
          agentId: message.agentId,
          roomId: message.roomId,
          content: {
            source: message.content.source,
            thought: "I will now mute this room",
            actions: ["MUTE_ROOM_STARTED"]
          },
          metadata: {
            type: "MUTE_ROOM"
          }
        }, "messages");
        return true;
      }
      if (cleanedResponse === "false" || cleanedResponse === "no" || cleanedResponse === "n" || cleanedResponse.includes("false") || cleanedResponse.includes("no")) {
        await runtime.createMemory({
          entityId: message.entityId,
          agentId: message.agentId,
          roomId: message.roomId,
          content: {
            source: message.content.source,
            thought: "I decided to not mute this room",
            actions: ["MUTE_ROOM_FAILED"]
          },
          metadata: {
            type: "MUTE_ROOM"
          }
        }, "messages");
      }
      logger4.warn({ src: "plugin:bootstrap:action:mute_room", agentId: runtime.agentId, response }, "Unclear boolean response, defaulting to false");
      return false;
    }
    const shouldMute = await _shouldMute(state);
    const room = state.data.room ?? await runtime.getRoom(message.roomId);
    if (!room) {
      return {
        text: "Could not find room to mute",
        values: { success: false, error: "ROOM_NOT_FOUND" },
        data: { actionName: "MUTE_ROOM", error: "Room not found" },
        success: false
      };
    }
    if (shouldMute) {
      try {
        await runtime.setParticipantUserState(message.roomId, runtime.agentId, "MUTED");
        await runtime.createMemory({
          entityId: message.entityId,
          agentId: message.agentId,
          roomId: message.roomId,
          content: {
            thought: `I muted the room ${room.name}`,
            actions: ["MUTE_ROOM_START"]
          }
        }, "messages");
        return {
          text: `Room muted: ${room.name}`,
          values: {
            success: true,
            roomMuted: true,
            roomId: message.roomId,
            roomName: room.name,
            newState: "MUTED"
          },
          data: {
            actionName: "MUTE_ROOM",
            roomId: message.roomId,
            roomName: room.name,
            muted: true
          },
          success: true
        };
      } catch (error) {
        logger4.error({
          src: "plugin:bootstrap:action:mute_room",
          agentId: runtime.agentId,
          error: error instanceof Error ? error.message : String(error)
        }, "Error muting room");
        return {
          text: "Failed to mute room",
          values: {
            success: false,
            error: "MUTE_FAILED"
          },
          data: {
            actionName: "MUTE_ROOM",
            error: error instanceof Error ? error.message : String(error),
            roomId: message.roomId
          },
          success: false,
          error: error instanceof Error ? error : new Error(String(error))
        };
      }
    } else {
      return {
        text: `Decided not to mute room: ${room.name}`,
        values: {
          success: true,
          roomMuted: false,
          roomId: message.roomId,
          roomName: room.name,
          reason: "NOT_APPROPRIATE"
        },
        data: {
          actionName: "MUTE_ROOM",
          roomId: message.roomId,
          roomName: room.name,
          muted: false,
          reason: "Decision criteria not met"
        },
        success: true
      };
    }
  },
  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "{{name3}}, please mute this channel. No need to respond here for now."
        }
      },
      {
        name: "{{name3}}",
        content: {
          text: "Got it",
          actions: ["MUTE_ROOM"]
        }
      },
      {
        name: "{{name2}}",
        content: {
          text: "@{{name1}} we could really use your input on this"
        }
      }
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "{{name3}}, please mute this channel for the time being"
        }
      },
      {
        name: "{{name3}}",
        content: {
          text: "Understood",
          actions: ["MUTE_ROOM"]
        }
      },
      {
        name: "{{name2}}",
        content: {
          text: "Hey what do you think about this new design"
        }
      },
      {
        name: "{{name3}}",
        content: {
          text: "",
          actions: ["IGNORE"]
        }
      }
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "{{name2}} plz mute this room"
        }
      },
      {
        name: "{{name2}}",
        content: {
          text: "np going silent",
          actions: ["MUTE_ROOM"]
        }
      },
      {
        name: "{{name1}}",
        content: {
          text: "whos going to the webxr meetup in an hour btw"
        }
      },
      {
        name: "{{name2}}",
        content: {
          text: "",
          actions: ["IGNORE"]
        }
      }
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "too many messages here {{name2}}"
        }
      },
      {
        name: "{{name1}}",
        content: {
          text: "my bad ill mute",
          actions: ["MUTE_ROOM"]
        }
      }
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "yo {{name2}} dont talk in here"
        }
      },
      {
        name: "{{name2}}",
        content: {
          text: "sry",
          actions: ["MUTE_ROOM"]
        }
      }
    ]
  ]
};
// src/actions/none.ts
var noneAction = {
  name: "NONE",
  similes: ["NO_ACTION", "NO_RESPONSE", "NO_REACTION"],
  validate: async (_runtime, _message) => {
    return true;
  },
  description: "Respond but perform no additional action. This is the default if the agent is speaking and not doing anything additional.",
  handler: async (_runtime, _message) => {
    return {
      text: "No additional action taken",
      values: {
        success: true,
        actionType: "NONE"
      },
      data: {
        actionName: "NONE",
        description: "Response without additional action"
      },
      success: true
    };
  },
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Hey whats up" }
      },
      {
        name: "{{name2}}",
        content: { text: "oh hey", actions: ["NONE"] }
      }
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "did u see some faster whisper just came out"
        }
      },
      {
        name: "{{name2}}",
        content: {
          text: "yeah but its a pain to get into node.js",
          actions: ["NONE"]
        }
      }
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "the things that were funny 6 months ago are very cringe now",
          actions: ["NONE"]
        }
      },
      {
        name: "{{name2}}",
        content: {
          text: "lol true",
          actions: ["NONE"]
        }
      },
      {
        name: "{{name1}}",
        content: { text: "too real haha", actions: ["NONE"] }
      }
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "gotta run", actions: ["NONE"] }
      },
      {
        name: "{{name2}}",
        content: { text: "Okay, ttyl", actions: ["NONE"] }
      },
      {
        name: "{{name1}}",
        content: { text: "", actions: ["IGNORE"] }
      }
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "heyyyyyy", actions: ["NONE"] }
      },
      {
        name: "{{name2}}",
        content: { text: "whats up long time no see" }
      },
      {
        name: "{{name1}}",
        content: {
          text: "chillin man. playing lots of fortnite. what about you",
          actions: ["NONE"]
        }
      }
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "u think aliens are real", actions: ["NONE"] }
      },
      {
        name: "{{name2}}",
        content: { text: "ya obviously", actions: ["NONE"] }
      }
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "drop a joke on me", actions: ["NONE"] }
      },
      {
        name: "{{name2}}",
        content: {
          text: "why dont scientists trust atoms cuz they make up everything lmao",
          actions: ["NONE"]
        }
      },
      {
        name: "{{name1}}",
        content: { text: "haha good one", actions: ["NONE"] }
      }
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "hows the weather where ur at",
          actions: ["NONE"]
        }
      },
      {
        name: "{{name2}}",
        content: { text: "beautiful all week", actions: ["NONE"] }
      }
    ]
  ]
};
// src/actions/reply.ts
import {
  composePromptFromState as composePromptFromState4,
  ModelType as ModelType5,
  logger as logger5,
  parseKeyValueXml as parseKeyValueXml3
} from "@elizaos/core";
var replyTemplate = `# Task: Generate dialog for the character {{agentName}}.

{{providers}}

# Instructions: Write the next message for {{agentName}}.
"thought" should be a short description of what the agent is thinking about and planning.
"text" should be the next message for {{agentName}} which they will send to the conversation.

IMPORTANT CODE BLOCK FORMATTING RULES:
- If {{agentName}} includes code examples, snippets, or multi-line code in the response, ALWAYS wrap the code with \`\`\` fenced code blocks (specify the language if known, e.g., \`\`\`python).
- ONLY use fenced code blocks for actual code. Do NOT wrap non-code text, instructions, or single words in fenced code blocks.
- If including inline code (short single words or function names), use single backticks (\`) as appropriate.
- This ensures the user sees clearly formatted and copyable code when relevant.

Do NOT include any thinking, reasoning, or <think> sections in your response.
Go directly to the XML response format without any preamble or explanation.

Respond using XML format like this:
<response>
    <thought>Your thought here</thought>
    <text>Your message here</text>
</response>

IMPORTANT: Your response must ONLY contain the <response></response> XML block above. Do not include any text, thinking, or reasoning before or after this XML block. Start your response immediately with <response> and end with </response>.`;
var replyAction = {
  name: "REPLY",
  similes: ["GREET", "REPLY_TO_MESSAGE", "SEND_REPLY", "RESPOND", "RESPONSE"],
  description: "Replies to the current conversation with the text from the generated message. Default if the agent is responding with a message and no other action. Use REPLY at the beginning of a chain of actions as an acknowledgement, and at the end of a chain of actions as a final response.",
  validate: async (_runtime) => {
    return true;
  },
  handler: async (runtime, message, state, _options, callback, responses) => {
    const actionContext = _options?.actionContext;
    const previousResults = actionContext?.previousResults || [];
    if (previousResults.length > 0) {
      logger5.debug({
        src: "plugin:bootstrap:action:reply",
        agentId: runtime.agentId,
        count: previousResults.length
      }, "Found previous action results");
    }
    const allProviders = responses?.flatMap((res) => res.content?.providers ?? []) ?? [];
    state = await runtime.composeState(message, [
      ...allProviders ?? [],
      "RECENT_MESSAGES",
      "ACTION_STATE"
    ]);
    const prompt = composePromptFromState4({
      state,
      template: runtime.character.templates?.replyTemplate || replyTemplate
    });
    try {
      const response = await runtime.useModel(ModelType5.TEXT_LARGE, {
        prompt
      });
      const parsedXml = parseKeyValueXml3(response);
      const thought = typeof parsedXml?.thought === "string" ? parsedXml.thought : "";
      const text = typeof parsedXml?.text === "string" ? parsedXml.text : "";
      const responseContent = {
        thought,
        text,
        actions: ["REPLY"]
      };
      if (callback) {
        await callback(responseContent);
      }
      return {
        text: `Generated reply: ${responseContent.text}`,
        values: {
          success: true,
          responded: true,
          lastReply: responseContent.text,
          lastReplyTime: Date.now(),
          thoughtProcess: thought
        },
        data: {
          actionName: "REPLY",
          response: responseContent,
          thought,
          messageGenerated: true
        },
        success: true
      };
    } catch (error) {
      logger5.error({
        src: "plugin:bootstrap:action:reply",
        agentId: runtime.agentId,
        error: error instanceof Error ? error.message : String(error)
      }, "Error generating response");
      return {
        text: "Error generating reply",
        values: {
          success: false,
          responded: false,
          error: true
        },
        data: {
          actionName: "REPLY",
          error: error instanceof Error ? error.message : String(error)
        },
        success: false,
        error: error instanceof Error ? error : new Error(String(error))
      };
    }
  },
  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "Hello there!"
        }
      },
      {
        name: "{{name2}}",
        content: {
          text: "Hi! How can I help you today?",
          actions: ["REPLY"]
        }
      }
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "What's your favorite color?"
        }
      },
      {
        name: "{{name2}}",
        content: {
          text: "I really like deep shades of blue. They remind me of the ocean and the night sky.",
          actions: ["REPLY"]
        }
      }
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Can you explain how neural networks work?"
        }
      },
      {
        name: "{{name2}}",
        content: {
          text: "Let me break that down for you in simple terms...",
          actions: ["REPLY"]
        }
      }
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Could you help me solve this math problem?"
        }
      },
      {
        name: "{{name2}}",
        content: {
          text: "Of course! Let's work through it step by step.",
          actions: ["REPLY"]
        }
      }
    ]
  ]
};
// src/actions/roles.ts
import {
  ChannelType,
  composePrompt as composePrompt2,
  logger as logger6,
  ModelType as ModelType6,
  Role,
  parseKeyValueXml as parseKeyValueXml4
} from "@elizaos/core";
var canModifyRole = (currentRole, targetRole, newRole) => {
  if (targetRole === currentRole) {
    return false;
  }
  switch (currentRole) {
    case Role.OWNER:
      return true;
    case Role.ADMIN:
      return newRole !== Role.OWNER;
    case Role.NONE:
    default:
      return false;
  }
};
var updateRoleAction = {
  name: "UPDATE_ROLE",
  similes: ["CHANGE_ROLE", "SET_PERMISSIONS", "ASSIGN_ROLE", "MAKE_ADMIN"],
  description: "Assigns a role (Admin, Owner, None) to a user or list of users in a channel.",
  validate: async (runtime, message, state) => {
    const channelType = message.content.channelType;
    if (channelType !== ChannelType.GROUP && channelType !== ChannelType.WORLD) {
      return false;
    }
    const room = state?.data?.room ?? await runtime.getRoom(message.roomId);
    if (!room || !room.messageServerId) {
      return false;
    }
    return true;
  },
  handler: async (runtime, message, state, _options, callback) => {
    if (!state) {
      logger6.error({ src: "plugin:bootstrap:action:update_role", agentId: runtime.agentId }, "State is required for role assignment");
      return {
        text: "State is required for role assignment",
        values: {
          success: false,
          error: "STATE_REQUIRED"
        },
        data: {
          actionName: "UPDATE_ROLE",
          error: "State is required"
        },
        success: false,
        error: new Error("State is required for role assignment")
      };
    }
    const { roomId } = message;
    const worldId = runtime.getSetting("WORLD_ID");
    let world = null;
    if (worldId) {
      world = await runtime.getWorld(worldId);
    }
    if (!world) {
      logger6.error({ src: "plugin:bootstrap:action:update_role", agentId: runtime.agentId }, "World not found");
      await callback?.({
        text: "I couldn't find the world. This action only works in a world."
      });
      return {
        text: "World not found",
        values: {
          success: false,
          error: "WORLD_NOT_FOUND"
        },
        data: {
          actionName: "UPDATE_ROLE",
          error: "World not found"
        },
        success: false
      };
    }
    if (!world.metadata?.roles) {
      world.metadata = world.metadata || {};
      world.metadata.roles = {};
    }
    const entities = await runtime.getEntitiesForRoom(roomId);
    const requesterRole = world.metadata.roles[message.entityId] || Role.NONE;
    const extractionPrompt = composePrompt2({
      state: {
        ...state.values,
        content: state.text
      },
      template: `# Task: Parse Role Assignment

I need to extract user role assignments from the input text. Users can be referenced by name, username, or mention.

The available role types are:
- OWNER: Full control over the server and all settings
- ADMIN: Ability to manage channels and moderate content
- NONE: Regular user with no special permissions

# Current context:
{{content}}

Do NOT include any thinking, reasoning, or <think> sections in your response. 
Go directly to the XML response format without any preamble or explanation.

Format your response as XML with multiple assignments:
<response>
  <assignments>
    <assignment>
      <entityId>John</entityId>
      <newRole>ADMIN</newRole>
    </assignment>
    <assignment>
      <entityId>Sarah</entityId>
      <newRole>OWNER</newRole>
    </assignment>
  </assignments>
</response>

IMPORTANT: Your response must ONLY contain the <response></response> XML block above. Do not include any text, thinking, or reasoning before or after this XML block. Start your response immediately with <response> and end with </response>.`
    });
    const response = await runtime.useModel(ModelType6.TEXT_SMALL, {
      prompt: extractionPrompt
    });
    const parsedXml = parseKeyValueXml4(response);
    let assignments = [];
    if (parsedXml?.assignments?.assignment) {
      const assignmentArray = Array.isArray(parsedXml.assignments.assignment) ? parsedXml.assignments.assignment : [parsedXml.assignments.assignment];
      assignments = assignmentArray.filter((a) => !!a.entityId).map((a) => ({
        entityId: a.entityId,
        newRole: a.newRole
      }));
    }
    if (!assignments.length) {
      await callback?.({
        text: "No valid role assignments found in the request.",
        actions: ["UPDATE_ROLE"],
        source: "discord"
      });
      return {
        text: "No valid role assignments found",
        values: {
          success: false,
          error: "NO_ASSIGNMENTS"
        },
        data: {
          actionName: "UPDATE_ROLE",
          error: "No valid role assignments found in the request"
        },
        success: false
      };
    }
    let worldUpdated = false;
    const successfulUpdates = [];
    const failedUpdates = [];
    for (const assignment of assignments) {
      const targetEntity = entities.find((e) => e.id === assignment.entityId);
      if (!targetEntity) {
        logger6.error({
          src: "plugin:bootstrap:action:update_role",
          agentId: runtime.agentId,
          entityId: assignment.entityId
        }, "Could not find an ID to assign to");
        failedUpdates.push({
          entityId: assignment.entityId,
          reason: "Entity not found"
        });
        continue;
      }
      const currentRole = world.metadata.roles[assignment.entityId];
      if (!canModifyRole(requesterRole, currentRole, assignment.newRole)) {
        await callback?.({
          text: `You don't have permission to change ${targetEntity?.names[0]}'s role to ${assignment.newRole}.`,
          actions: ["UPDATE_ROLE"],
          source: "discord"
        });
        failedUpdates.push({
          entityId: assignment.entityId,
          reason: "Insufficient permissions"
        });
        continue;
      }
      world.metadata.roles[assignment.entityId] = assignment.newRole;
      worldUpdated = true;
      successfulUpdates.push({
        entityId: assignment.entityId,
        entityName: targetEntity?.names[0] || "Unknown",
        newRole: assignment.newRole
      });
      await callback?.({
        text: `Updated ${targetEntity?.names[0]}'s role to ${assignment.newRole}.`,
        actions: ["UPDATE_ROLE"],
        source: "discord"
      });
    }
    if (worldUpdated) {
      try {
        await runtime.updateWorld(world);
        logger6.info({
          src: "plugin:bootstrap:action:update_role",
          agentId: runtime.agentId,
          messageServerId: world.messageServerId
        }, "Updated roles in world metadata");
      } catch (error) {
        logger6.error({
          src: "plugin:bootstrap:action:update_role",
          agentId: runtime.agentId,
          error: error instanceof Error ? error.message : String(error)
        }, "Failed to save world updates");
        return {
          text: "Failed to save role updates",
          values: {
            success: false,
            error: "SAVE_FAILED"
          },
          data: {
            actionName: "UPDATE_ROLE",
            error: error instanceof Error ? error.message : String(error),
            attemptedUpdates: successfulUpdates
          },
          success: false,
          error: error instanceof Error ? error : new Error(String(error))
        };
      }
    }
    return {
      text: `Role updates completed: ${successfulUpdates.length} successful, ${failedUpdates.length} failed`,
      values: {
        success: true,
        successfulUpdates: successfulUpdates.length,
        failedUpdates: failedUpdates.length,
        updates: successfulUpdates,
        failures: failedUpdates
      },
      data: {
        actionName: "UPDATE_ROLE",
        successfulUpdates,
        failedUpdates,
        worldId: world.id,
        messageServerId: world.messageServerId
      },
      success: true
    };
  },
  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "Make {{name2}} an ADMIN",
          source: "discord"
        }
      },
      {
        name: "{{name3}}",
        content: {
          text: "Updated {{name2}}'s role to ADMIN.",
          actions: ["UPDATE_ROLE"]
        }
      }
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Set @alice and @bob as admins",
          source: "discord"
        }
      },
      {
        name: "{{name3}}",
        content: {
          text: `Updated alice's role to ADMIN.
Updated bob's role to ADMIN.`,
          actions: ["UPDATE_ROLE"]
        }
      }
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Ban @troublemaker",
          source: "discord"
        }
      },
      {
        name: "{{name3}}",
        content: {
          text: "I cannot ban users.",
          actions: ["REPLY"]
        }
      }
    ]
  ]
};
// src/actions/sendMessage.ts
import {
  composePromptFromState as composePromptFromState5,
  findEntityByName,
  logger as logger7,
  ModelType as ModelType7,
  parseKeyValueXml as parseKeyValueXml5
} from "@elizaos/core";
var targetExtractionTemplate = `# Task: Extract Target and Source Information

# Recent Messages:
{{recentMessages}}

# Instructions:
Analyze the conversation to identify:
1. The target type (user or room)
2. The target platform/source (e.g. telegram, discord, etc)
3. Any identifying information about the target

Do NOT include any thinking, reasoning, or <think> sections in your response. 
Go directly to the XML response format without any preamble or explanation.

Return an XML response with:
<response>
  <targetType>user|room</targetType>
  <source>platform-name</source>
  <identifiers>
    <username>username_if_applicable</username>
    <roomName>room_name_if_applicable</roomName>
  </identifiers>
</response>

Example outputs:
1. For "send a message to @dev_guru on telegram":
<response>
  <targetType>user</targetType>
  <source>telegram</source>
  <identifiers>
    <username>dev_guru</username>
  </identifiers>
</response>

2. For "post this in #announcements":
<response>
  <targetType>room</targetType>
  <source>discord</source>
  <identifiers>
    <roomName>announcements</roomName>
  </identifiers>
</response>

IMPORTANT: Your response must ONLY contain the <response></response> XML block above. Do not include any text, thinking, or reasoning before or after this XML block. Start your response immediately with <response> and end with </response>.`;
var sendMessageAction = {
  name: "SEND_MESSAGE",
  similes: ["DM", "MESSAGE", "SEND_DM", "POST_MESSAGE"],
  description: "Send a message to a user or room (other than the current one)",
  validate: async (runtime, message, _state) => {
    const worldId = message.roomId;
    const agentId = runtime.agentId;
    const roomComponents = await runtime.getComponents(message.roomId, worldId, agentId);
    const availableSources = new Set(roomComponents.map((c) => c.type));
    return availableSources.size > 0;
  },
  handler: async (runtime, message, state, _options, callback, responses) => {
    try {
      if (!state) {
        logger7.error({ src: "plugin:bootstrap:action:send_message", agentId: runtime.agentId }, "State is required for sendMessage action");
        return {
          text: "State is required for sendMessage action",
          values: {
            success: false,
            error: "STATE_REQUIRED"
          },
          data: {
            actionName: "SEND_MESSAGE",
            error: "State is required"
          },
          success: false,
          error: new Error("State is required for sendMessage action")
        };
      }
      if (!callback) {
        logger7.error({ src: "plugin:bootstrap:action:send_message", agentId: runtime.agentId }, "Callback is required for sendMessage action");
        return {
          text: "Callback is required for sendMessage action",
          values: {
            success: false,
            error: "CALLBACK_REQUIRED"
          },
          data: {
            actionName: "SEND_MESSAGE",
            error: "Callback is required"
          },
          success: false,
          error: new Error("Callback is required for sendMessage action")
        };
      }
      if (!responses) {
        logger7.error({ src: "plugin:bootstrap:action:send_message", agentId: runtime.agentId }, "Responses are required for sendMessage action");
        return {
          text: "Responses are required for sendMessage action",
          values: {
            success: false,
            error: "RESPONSES_REQUIRED"
          },
          data: {
            actionName: "SEND_MESSAGE",
            error: "Responses are required"
          },
          success: false,
          error: new Error("Responses are required for sendMessage action")
        };
      }
      for (const response of responses) {
        await callback(response.content);
      }
      const sourceEntityId = message.entityId;
      const room = state.data.room ?? await runtime.getRoom(message.roomId);
      if (!room) {
        return {
          text: "Could not find room",
          values: { success: false, error: "ROOM_NOT_FOUND" },
          data: { actionName: "SEND_MESSAGE", error: "Room not found" },
          success: false
        };
      }
      const worldId = room.worldId;
      const targetPrompt = composePromptFromState5({
        state,
        template: targetExtractionTemplate
      });
      const targetResult = await runtime.useModel(ModelType7.TEXT_SMALL, {
        prompt: targetPrompt,
        stopSequences: []
      });
      const targetData = parseKeyValueXml5(targetResult);
      if (!targetData?.targetType || !targetData?.source) {
        await callback({
          text: "I couldn't determine where you want me to send the message. Could you please specify the target (user or room) and platform?",
          actions: ["SEND_MESSAGE_ERROR"],
          source: message.content.source
        });
        return {
          text: "Could not determine message target",
          values: {
            success: false,
            error: "TARGET_UNCLEAR"
          },
          data: {
            actionName: "SEND_MESSAGE",
            error: "Could not parse target information from message"
          },
          success: false
        };
      }
      const source = targetData.source.toLowerCase();
      if (targetData.targetType === "user") {
        const targetEntity = await findEntityByName(runtime, message, state);
        if (!targetEntity) {
          await callback({
            text: "I couldn't find the user you want me to send a message to. Could you please provide more details about who they are?",
            actions: ["SEND_MESSAGE_ERROR"],
            source: message.content.source
          });
          return {
            text: "Target user not found",
            values: {
              success: false,
              error: "USER_NOT_FOUND",
              targetType: "user"
            },
            data: {
              actionName: "SEND_MESSAGE",
              error: "Could not find target user",
              targetType: "user",
              source
            },
            success: false
          };
        }
        const userComponent = await runtime.getComponent(targetEntity.id, source, worldId, sourceEntityId);
        if (!userComponent) {
          await callback({
            text: `I couldn't find ${source} information for that user. Could you please provide their ${source} details?`,
            actions: ["SEND_MESSAGE_ERROR"],
            source: message.content.source
          });
          return {
            text: `No ${source} information found for user`,
            values: {
              success: false,
              error: "COMPONENT_NOT_FOUND",
              targetType: "user",
              source
            },
            data: {
              actionName: "SEND_MESSAGE",
              error: `No ${source} component found for target user`,
              targetType: "user",
              targetEntityId: targetEntity.id,
              source
            },
            success: false
          };
        }
        const service = runtime.getService(source);
        const sendDirectMessage = service?.sendDirectMessage;
        if (!sendDirectMessage) {
          await callback({
            text: "I couldn't find the user you want me to send a message to. Could you please provide more details about who they are?",
            actions: ["SEND_MESSAGE_ERROR"],
            source: message.content.source
          });
          return {
            text: "Message service not available",
            values: {
              success: false,
              error: "SERVICE_NOT_FOUND",
              targetType: "user",
              source
            },
            data: {
              actionName: "SEND_MESSAGE",
              error: `No sendDirectMessage service found for ${source}`,
              targetType: "user",
              source
            },
            success: false
          };
        }
        try {
          await sendDirectMessage(targetEntity.id, {
            text: message.content.text,
            source: message.content.source
          });
          await callback({
            text: `Message sent to ${targetEntity.names[0]} on ${source}.`,
            actions: ["SEND_MESSAGE"],
            source: message.content.source
          });
          return {
            text: `Message sent to ${targetEntity.names[0]}`,
            values: {
              success: true,
              targetType: "user",
              targetId: targetEntity.id,
              targetName: targetEntity.names[0],
              source,
              messageSent: true
            },
            data: {
              actionName: "SEND_MESSAGE",
              targetType: "user",
              targetId: targetEntity.id,
              targetName: targetEntity.names[0],
              source,
              messageContent: message.content.text
            },
            success: true
          };
        } catch (error) {
          logger7.error({
            src: "plugin:bootstrap:action:send_message",
            agentId: runtime.agentId,
            error: error instanceof Error ? error.message : String(error)
          }, "Failed to send direct message");
          await callback({
            text: "I encountered an error trying to send the message. Please try again.",
            actions: ["SEND_MESSAGE_ERROR"],
            source: message.content.source
          });
          return {
            text: "Failed to send direct message",
            values: {
              success: false,
              error: "SEND_FAILED",
              targetType: "user",
              source
            },
            data: {
              actionName: "SEND_MESSAGE",
              error: error instanceof Error ? error.message : String(error),
              targetType: "user",
              targetId: targetEntity.id,
              source
            },
            success: false,
            error: error instanceof Error ? error : new Error(String(error))
          };
        }
      } else if (targetData.targetType === "room") {
        if (!worldId) {
          return {
            text: "Could not determine world for room lookup",
            values: { success: false, error: "NO_WORLD_ID" },
            data: { actionName: "SEND_MESSAGE", error: "No world ID available" },
            success: false
          };
        }
        const rooms = await runtime.getRooms(worldId);
        const targetRoom = rooms.find((r) => {
          return r.name?.toLowerCase() === targetData.identifiers?.roomName?.toLowerCase();
        });
        if (!targetRoom) {
          await callback({
            text: "I couldn't find the room you want me to send a message to. Could you please specify the exact room name?",
            actions: ["SEND_MESSAGE_ERROR"],
            source: message.content.source
          });
          return {
            text: "Target room not found",
            values: {
              success: false,
              error: "ROOM_NOT_FOUND",
              targetType: "room",
              roomName: targetData.identifiers?.roomName
            },
            data: {
              actionName: "SEND_MESSAGE",
              error: "Could not find target room",
              targetType: "room",
              roomName: targetData.identifiers?.roomName,
              source
            },
            success: false
          };
        }
        const service = runtime.getService(source);
        const sendRoomMessage = service?.sendRoomMessage;
        if (!sendRoomMessage) {
          await callback({
            text: "I couldn't find the room you want me to send a message to. Could you please specify the exact room name?",
            actions: ["SEND_MESSAGE_ERROR"],
            source: message.content.source
          });
          return {
            text: "Room message service not available",
            values: {
              success: false,
              error: "SERVICE_NOT_FOUND",
              targetType: "room",
              source
            },
            data: {
              actionName: "SEND_MESSAGE",
              error: `No sendRoomMessage service found for ${source}`,
              targetType: "room",
              source
            },
            success: false
          };
        }
        try {
          await sendRoomMessage(targetRoom.id, {
            text: message.content.text,
            source: message.content.source
          });
          await callback({
            text: `Message sent to ${targetRoom.name} on ${source}.`,
            actions: ["SEND_MESSAGE"],
            source: message.content.source
          });
          return {
            text: `Message sent to ${targetRoom.name}`,
            values: {
              success: true,
              targetType: "room",
              targetId: targetRoom.id,
              targetName: targetRoom.name,
              source,
              messageSent: true
            },
            data: {
              actionName: "SEND_MESSAGE",
              targetType: "room",
              targetId: targetRoom.id,
              targetName: targetRoom.name,
              source,
              messageContent: message.content.text
            },
            success: true
          };
        } catch (error) {
          logger7.error({
            src: "plugin:bootstrap:action:send_message",
            agentId: runtime.agentId,
            error: error instanceof Error ? error.message : String(error)
          }, "Failed to send room message");
          await callback({
            text: "I encountered an error trying to send the message to the room. Please try again.",
            actions: ["SEND_MESSAGE_ERROR"],
            source: message.content.source
          });
          return {
            text: "Failed to send room message",
            values: {
              success: false,
              error: "SEND_FAILED",
              targetType: "room",
              source
            },
            data: {
              actionName: "SEND_MESSAGE",
              error: error instanceof Error ? error.message : String(error),
              targetType: "room",
              targetId: targetRoom.id,
              targetName: targetRoom.name,
              source
            },
            success: false,
            error: error instanceof Error ? error : new Error(String(error))
          };
        }
      }
      return {
        text: "Unknown target type",
        values: {
          success: false,
          error: "UNKNOWN_TARGET_TYPE"
        },
        data: {
          actionName: "SEND_MESSAGE",
          error: `Unknown target type: ${targetData.targetType}`
        },
        success: false
      };
    } catch (error) {
      logger7.error({
        src: "plugin:bootstrap:action:send_message",
        agentId: runtime.agentId,
        error: error instanceof Error ? error.message : String(error)
      }, "Error in sendMessage handler");
      await callback?.({
        text: "There was an error processing your message request.",
        actions: ["SEND_MESSAGE_ERROR"],
        source: message.content.source
      });
      return {
        text: "Error processing message request",
        values: {
          success: false,
          error: "HANDLER_ERROR"
        },
        data: {
          actionName: "SEND_MESSAGE",
          error: error instanceof Error ? error.message : String(error)
        },
        success: false,
        error: error instanceof Error ? error : new Error(String(error))
      };
    }
  },
  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "Send a message to @dev_guru on telegram saying 'Hello!'"
        }
      },
      {
        name: "{{name2}}",
        content: {
          text: "Message sent to dev_guru on telegram.",
          actions: ["SEND_MESSAGE"]
        }
      }
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Post 'Important announcement!' in #announcements"
        }
      },
      {
        name: "{{name2}}",
        content: {
          text: "Message sent to announcements.",
          actions: ["SEND_MESSAGE"]
        }
      }
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "DM Jimmy and tell him 'Meeting at 3pm'"
        }
      },
      {
        name: "{{name2}}",
        content: {
          text: "Message sent to Jimmy.",
          actions: ["SEND_MESSAGE"]
        }
      }
    ]
  ]
};
// src/actions/settings.ts
import {
  ChannelType as ChannelType2,
  composePrompt as composePrompt3,
  composePromptFromState as composePromptFromState6,
  findWorldsForOwner,
  getSalt,
  logger as logger8,
  ModelType as ModelType8,
  parseKeyValueXml as parseKeyValueXml6,
  saltWorldSettings,
  unsaltWorldSettings
} from "@elizaos/core";

// ../../node_modules/dedent/dist/dedent.mjs
function ownKeys(object, enumerableOnly) {
  var keys = Object.keys(object);
  if (Object.getOwnPropertySymbols) {
    var symbols = Object.getOwnPropertySymbols(object);
    enumerableOnly && (symbols = symbols.filter(function(sym) {
      return Object.getOwnPropertyDescriptor(object, sym).enumerable;
    })), keys.push.apply(keys, symbols);
  }
  return keys;
}
function _objectSpread(target) {
  for (var i = 1;i < arguments.length; i++) {
    var source = arguments[i] != null ? arguments[i] : {};
    i % 2 ? ownKeys(Object(source), true).forEach(function(key) {
      _defineProperty(target, key, source[key]);
    }) : Object.getOwnPropertyDescriptors ? Object.defineProperties(target, Object.getOwnPropertyDescriptors(source)) : ownKeys(Object(source)).forEach(function(key) {
      Object.defineProperty(target, key, Object.getOwnPropertyDescriptor(source, key));
    });
  }
  return target;
}
function _defineProperty(obj, key, value) {
  key = _toPropertyKey(key);
  if (key in obj) {
    Object.defineProperty(obj, key, { value, enumerable: true, configurable: true, writable: true });
  } else {
    obj[key] = value;
  }
  return obj;
}
function _toPropertyKey(arg) {
  var key = _toPrimitive(arg, "string");
  return typeof key === "symbol" ? key : String(key);
}
function _toPrimitive(input, hint) {
  if (typeof input !== "object" || input === null)
    return input;
  var prim = input[Symbol.toPrimitive];
  if (prim !== undefined) {
    var res = prim.call(input, hint || "default");
    if (typeof res !== "object")
      return res;
    throw new TypeError("@@toPrimitive must return a primitive value.");
  }
  return (hint === "string" ? String : Number)(input);
}
var dedent = createDedent({});
var dedent_default = dedent;
function createDedent(options) {
  dedent2.withOptions = (newOptions) => createDedent(_objectSpread(_objectSpread({}, options), newOptions));
  return dedent2;
  function dedent2(strings, ...values) {
    const raw = typeof strings === "string" ? [strings] : strings.raw;
    const {
      escapeSpecialCharacters = Array.isArray(strings)
    } = options;
    let result = "";
    for (let i = 0;i < raw.length; i++) {
      let next = raw[i];
      if (escapeSpecialCharacters) {
        next = next.replace(/\\\n[ \t]*/g, "").replace(/\\`/g, "`").replace(/\\\$/g, "$").replace(/\\\{/g, "{");
      }
      result += next;
      if (i < values.length) {
        result += values[i];
      }
    }
    const lines = result.split(`
`);
    let mindent = null;
    for (const l of lines) {
      const m = l.match(/^(\s+)\S+/);
      if (m) {
        const indent = m[1].length;
        if (!mindent) {
          mindent = indent;
        } else {
          mindent = Math.min(mindent, indent);
        }
      }
    }
    if (mindent !== null) {
      const m = mindent;
      result = lines.map((l) => l[0] === " " || l[0] === "\t" ? l.slice(m) : l).join(`
`);
    }
    result = result.trim();
    if (escapeSpecialCharacters) {
      result = result.replace(/\\n/g, `
`);
    }
    return result;
  }
}

// src/actions/settings.ts
var messageCompletionFooter = `
# Instructions: Write the next message for {{agentName}}. Include the appropriate action from the list: {{actionNames}}

Do NOT include any thinking, reasoning, or <think> sections in your response. 
Go directly to the XML response format without any preamble or explanation.

Response format should be formatted in XML like this:
<response>
  <name>{{agentName}}</name>
  <text>Your message text here</text>
  <thought>Your thought about the response</thought>
  <actions>ACTION1,ACTION2</actions>
</response>

Do not including any thinking or internal reflection in the "text" field.
"thought" should be a short description of what the agent is thinking about before responding, including a brief justification for the response.

IMPORTANT: Your response must ONLY contain the <response></response> XML block above. Do not include any text, thinking, or reasoning before or after this XML block. Start your response immediately with <response> and end with </response>.`;
var successTemplate = `# Task: Generate a response for successful setting updates
{{providers}}

# Update Information:
- Updated Settings: {{updateMessages}}
- Next Required Setting: {{nextSetting.name}}
- Remaining Required Settings: {{remainingRequired}}

# Instructions:
1. Acknowledge the successful update of settings
2. Maintain {{agentName}}'s personality and tone
3. Provide clear guidance on the next setting that needs to be configured
4. Explain what the next setting is for and how to set it
5. If appropriate, mention how many required settings remain

Write a natural, conversational response that {{agentName}} would send about the successful update and next steps.
Include the actions array ["SETTING_UPDATED"] in your response.
${messageCompletionFooter}`;
var failureTemplate = `# Task: Generate a response for failed setting updates

# About {{agentName}}:
{{bio}}

# Current Settings Status:
{{settingsStatus}}

# Next Required Setting:
- Name: {{nextSetting.name}}
- Description: {{nextSetting.description}}
- Required: Yes
- Remaining Required Settings: {{remainingRequired}}

# Recent Conversation:
{{recentMessages}}

# Instructions:
1. Express that you couldn't understand or process the setting update
2. Maintain {{agentName}}'s personality and tone
3. Provide clear guidance on what setting needs to be configured next
4. Explain what the setting is for and how to set it properly
5. Use a helpful, patient tone

Write a natural, conversational response that {{agentName}} would send about the failed update and how to proceed.
Include the actions array ["SETTING_UPDATE_FAILED"] in your response.
${messageCompletionFooter}`;
var errorTemplate = `# Task: Generate a response for an error during setting updates

# About {{agentName}}:
{{bio}}

# Recent Conversation:
{{recentMessages}}

# Instructions:
1. Apologize for the technical difficulty
2. Maintain {{agentName}}'s personality and tone
3. Suggest trying again or contacting support if the issue persists
4. Keep the message concise and helpful

Write a natural, conversational response that {{agentName}} would send about the error.
Include the actions array ["SETTING_UPDATE_ERROR"] in your response.
${messageCompletionFooter}`;
var completionTemplate = `# Task: Generate a response for settings completion

# About {{agentName}}:
{{bio}}

# Settings Status:
{{settingsStatus}}

# Recent Conversation:
{{recentMessages}}

# Instructions:
1. Congratulate the user on completing the settings process
2. Maintain {{agentName}}'s personality and tone
3. Summarize the key settings that have been configured
4. Explain what functionality is now available
5. Provide guidance on what the user can do next
6. Express enthusiasm about working together

Write a natural, conversational response that {{agentName}} would send about the successful completion of settings.
Include the actions array ["ONBOARDING_COMPLETE"] in your response.
${messageCompletionFooter}`;
async function getWorldSettings(runtime, worldId) {
  try {
    const world = await runtime.getWorld(worldId);
    if (!world || !world.metadata?.settings) {
      return null;
    }
    const salt = getSalt();
    return unsaltWorldSettings(world.metadata.settings, salt);
  } catch (error) {
    logger8.error({
      src: "plugin:bootstrap:action:settings",
      agentId: runtime.agentId,
      error: error instanceof Error ? error.message : String(error)
    }, "Error getting settings state");
    return null;
  }
}
async function updateWorldSettings(runtime, worldId, worldSettings) {
  try {
    const world = await runtime.getWorld(worldId);
    if (!world) {
      logger8.error({ src: "plugin:bootstrap:action:settings", agentId: runtime.agentId, worldId }, "No world found");
      return false;
    }
    if (!world.metadata) {
      world.metadata = {};
    }
    const salt = getSalt();
    const saltedSettings = saltWorldSettings(worldSettings, salt);
    world.metadata.settings = saltedSettings;
    await runtime.updateWorld(world);
    return true;
  } catch (error) {
    logger8.error({
      src: "plugin:bootstrap:action:settings",
      agentId: runtime.agentId,
      error: error instanceof Error ? error.message : String(error)
    }, "Error updating settings state");
    return false;
  }
}
function formatSettingsList(worldSettings) {
  if (!worldSettings || typeof worldSettings !== "object") {
    return "No settings available";
  }
  const settings = Object.entries(worldSettings).filter(([key]) => !key.startsWith("_")).map(([key, setting]) => {
    const status = setting.value !== null ? "Configured" : "Not configured";
    const required = setting.required ? "Required" : "Optional";
    return `- ${setting.name} (${key}): ${status}, ${required}`;
  }).join(`
`);
  return settings || "No settings available";
}
function categorizeSettings(worldSettings) {
  if (!worldSettings || typeof worldSettings !== "object") {
    return { configured: [], requiredUnconfigured: [], optionalUnconfigured: [] };
  }
  const configured = [];
  const requiredUnconfigured = [];
  const optionalUnconfigured = [];
  for (const [key, setting] of Object.entries(worldSettings)) {
    if (key.startsWith("_")) {
      continue;
    }
    const typedSetting = setting;
    if (typedSetting.value !== null) {
      configured.push([key, typedSetting]);
    } else if (typedSetting.required) {
      requiredUnconfigured.push([key, typedSetting]);
    } else {
      optionalUnconfigured.push([key, typedSetting]);
    }
  }
  return { configured, requiredUnconfigured, optionalUnconfigured };
}
async function extractSettingValues(runtime, _message, state, worldSettings) {
  const { requiredUnconfigured, optionalUnconfigured } = categorizeSettings(worldSettings);
  const settingsContext = requiredUnconfigured.concat(optionalUnconfigured).map(([key, setting]) => {
    const requiredStr = setting.required ? "Required." : "Optional.";
    return `${key}: ${setting.description} ${requiredStr}`;
  }).join(`
`);
  const basePrompt = dedent_default`
    I need to extract settings values from the user's message.
    
    Available settings:
    ${settingsContext}
    
    User message: ${state.text}

    For each setting mentioned in the user's message, extract the value.
    
    Only return settings that are clearly mentioned in the user's message.
    If a setting is mentioned but no clear value is provided, do not include it.
    `;
  try {
    let extractValidSettings = function(obj, worldSettings2) {
      const extracted = [];
      function traverse(node) {
        if (Array.isArray(node)) {
          for (const item of node) {
            traverse(item);
          }
        } else if (typeof node === "object" && node !== null) {
          for (const [key, value] of Object.entries(node)) {
            if (worldSettings2[key] && typeof value !== "object") {
              extracted.push({ key, value });
            } else {
              traverse(value);
            }
          }
        }
      }
      traverse(obj);
      return extracted;
    };
    const result = await runtime.useModel(ModelType8.OBJECT_LARGE, {
      prompt: basePrompt,
      output: "array",
      schema: {
        type: "array",
        items: {
          type: "object",
          properties: {
            key: { type: "string" },
            value: { type: "string" }
          },
          required: ["key", "value"]
        }
      }
    });
    if (!result) {
      return [];
    }
    const extractedSettings = extractValidSettings(result, worldSettings);
    return extractedSettings;
  } catch (error) {
    console.error("Error extracting settings:", error);
    return [];
  }
}
async function processSettingUpdates(runtime, worldId, worldSettings, updates) {
  if (!updates.length) {
    return { updatedAny: false, messages: [] };
  }
  const messages = [];
  let updatedAny = false;
  try {
    const updatedState = { ...worldSettings };
    for (const update of updates) {
      const setting = updatedState[update.key];
      if (!setting) {
        continue;
      }
      if (setting.dependsOn?.length) {
        const dependenciesMet = setting.dependsOn.every((dep) => updatedState[dep]?.value !== null);
        if (!dependenciesMet) {
          messages.push(`Cannot update ${setting.name} - dependencies not met`);
          continue;
        }
      }
      updatedState[update.key] = {
        ...setting,
        value: update.value
      };
      messages.push(`Updated ${setting.name} successfully`);
      updatedAny = true;
      if (setting.onSetAction) {
        const actionMessage = setting.onSetAction(update.value);
        if (actionMessage) {
          messages.push(actionMessage);
        }
      }
    }
    if (updatedAny) {
      const saved = await updateWorldSettings(runtime, worldId, updatedState);
      if (!saved) {
        throw new Error("Failed to save updated state to world metadata");
      }
      const savedState = await getWorldSettings(runtime, worldId);
      if (!savedState) {
        throw new Error("Failed to verify state save");
      }
    }
    return { updatedAny, messages };
  } catch (error) {
    logger8.error({
      src: "plugin:bootstrap:action:settings",
      agentId: runtime.agentId,
      error: error instanceof Error ? error.message : String(error)
    }, "Error processing setting updates");
    return {
      updatedAny: false,
      messages: ["Error occurred while updating settings"]
    };
  }
}
async function handleOnboardingComplete(runtime, worldSettings, _state, callback) {
  try {
    const prompt = composePrompt3({
      state: {
        settingsStatus: formatSettingsList(worldSettings)
      },
      template: completionTemplate
    });
    const response = await runtime.useModel(ModelType8.TEXT_LARGE, {
      prompt
    });
    const responseContent = parseKeyValueXml6(response);
    await callback({
      text: responseContent.text,
      actions: ["ONBOARDING_COMPLETE"],
      source: "discord"
    });
    return {
      text: "Onboarding completed successfully",
      values: {
        success: true,
        onboardingComplete: true,
        allRequiredConfigured: true
      },
      data: {
        actionName: "UPDATE_SETTINGS",
        action: "ONBOARDING_COMPLETE",
        settingsStatus: formatSettingsList(worldSettings)
      },
      success: true
    };
  } catch (error) {
    logger8.error({
      src: "plugin:bootstrap:action:settings",
      agentId: runtime.agentId,
      error: error instanceof Error ? error.message : String(error)
    }, "Error handling settings completion");
    await callback({
      text: "Great! All required settings have been configured. Your server is now fully set up and ready to use.",
      actions: ["ONBOARDING_COMPLETE"],
      source: "discord"
    });
    return {
      text: "Onboarding completed with fallback message",
      values: {
        success: true,
        onboardingComplete: true,
        fallbackUsed: true
      },
      data: {
        actionName: "UPDATE_SETTINGS",
        action: "ONBOARDING_COMPLETE",
        error: error instanceof Error ? error.message : String(error)
      },
      success: true
    };
  }
}
async function generateSuccessResponse(runtime, worldSettings, state, messages, callback) {
  try {
    const { requiredUnconfigured } = categorizeSettings(worldSettings);
    if (requiredUnconfigured.length === 0) {
      return await handleOnboardingComplete(runtime, worldSettings, state, callback);
    }
    const requiredUnconfiguredString = requiredUnconfigured.map(([key, setting]) => `${key}: ${setting.name}`).join(`
`);
    const prompt = composePrompt3({
      state: {
        updateMessages: messages.join(`
`),
        nextSetting: requiredUnconfiguredString,
        remainingRequired: requiredUnconfigured.length.toString()
      },
      template: successTemplate
    });
    const response = await runtime.useModel(ModelType8.TEXT_LARGE, {
      prompt
    });
    const responseContent = parseKeyValueXml6(response);
    await callback({
      text: responseContent.text,
      actions: ["SETTING_UPDATED"],
      source: "discord"
    });
    return {
      text: "Settings updated successfully",
      values: {
        success: true,
        settingsUpdated: true,
        remainingRequired: requiredUnconfigured.length
      },
      data: {
        actionName: "UPDATE_SETTINGS",
        action: "SETTING_UPDATED",
        updatedMessages: messages,
        remainingRequired: requiredUnconfigured.length
      },
      success: true
    };
  } catch (error) {
    logger8.error({
      src: "plugin:bootstrap:action:settings",
      agentId: runtime.agentId,
      error: error instanceof Error ? error.message : String(error)
    }, "Error generating success response");
    await callback({
      text: "Settings updated successfully. Please continue with the remaining configuration.",
      actions: ["SETTING_UPDATED"],
      source: "discord"
    });
    return {
      text: "Settings updated with fallback message",
      values: {
        success: true,
        settingsUpdated: true,
        fallbackUsed: true
      },
      data: {
        actionName: "UPDATE_SETTINGS",
        action: "SETTING_UPDATED",
        error: error instanceof Error ? error.message : String(error)
      },
      success: true
    };
  }
}
async function generateFailureResponse(runtime, worldSettings, state, callback) {
  try {
    const { requiredUnconfigured } = categorizeSettings(worldSettings);
    if (requiredUnconfigured.length === 0) {
      return await handleOnboardingComplete(runtime, worldSettings, state, callback);
    }
    const requiredUnconfiguredString = requiredUnconfigured.map(([key, setting]) => `${key}: ${setting.name}`).join(`
`);
    const prompt = composePrompt3({
      state: {
        nextSetting: requiredUnconfiguredString,
        remainingRequired: requiredUnconfigured.length.toString()
      },
      template: failureTemplate
    });
    const response = await runtime.useModel(ModelType8.TEXT_LARGE, {
      prompt
    });
    const responseContent = parseKeyValueXml6(response);
    await callback({
      text: responseContent.text,
      actions: ["SETTING_UPDATE_FAILED"],
      source: "discord"
    });
    return {
      text: "No settings were updated",
      values: {
        success: false,
        settingsUpdated: false,
        remainingRequired: requiredUnconfigured.length
      },
      data: {
        actionName: "UPDATE_SETTINGS",
        action: "SETTING_UPDATE_FAILED",
        remainingRequired: requiredUnconfigured.length
      },
      success: false
    };
  } catch (error) {
    logger8.error({
      src: "plugin:bootstrap:action:settings",
      agentId: runtime.agentId,
      error: error instanceof Error ? error.message : String(error)
    }, "Error generating failure response");
    await callback({
      text: "I couldn't understand your settings update. Please try again with a clearer format.",
      actions: ["SETTING_UPDATE_FAILED"],
      source: "discord"
    });
    return {
      text: "Failed to parse settings with fallback message",
      values: {
        success: false,
        settingsUpdated: false,
        fallbackUsed: true
      },
      data: {
        actionName: "UPDATE_SETTINGS",
        action: "SETTING_UPDATE_FAILED",
        error: error instanceof Error ? error.message : String(error)
      },
      success: false
    };
  }
}
async function generateErrorResponse(runtime, state, callback) {
  try {
    const prompt = composePromptFromState6({
      state,
      template: errorTemplate
    });
    const response = await runtime.useModel(ModelType8.TEXT_LARGE, {
      prompt
    });
    const responseContent = parseKeyValueXml6(response);
    await callback({
      text: responseContent.text,
      actions: ["SETTING_UPDATE_ERROR"],
      source: "discord"
    });
    return {
      text: "Error processing settings",
      values: {
        success: false,
        error: "PROCESSING_ERROR"
      },
      data: {
        actionName: "UPDATE_SETTINGS",
        action: "SETTING_UPDATE_ERROR"
      },
      success: false
    };
  } catch (error) {
    logger8.error({
      src: "plugin:bootstrap:action:settings",
      agentId: runtime.agentId,
      error: error instanceof Error ? error.message : String(error)
    }, "Error generating error response");
    await callback({
      text: "I'm sorry, but I encountered an error while processing your request. Please try again or contact support if the issue persists.",
      actions: ["SETTING_UPDATE_ERROR"],
      source: "discord"
    });
    return {
      text: "Error with fallback message",
      values: {
        success: false,
        error: "PROCESSING_ERROR",
        fallbackUsed: true
      },
      data: {
        actionName: "UPDATE_SETTINGS",
        action: "SETTING_UPDATE_ERROR",
        error: error instanceof Error ? error.message : String(error)
      },
      success: false,
      error: error instanceof Error ? error : new Error(String(error))
    };
  }
}
var updateSettingsAction = {
  name: "UPDATE_SETTINGS",
  similes: ["UPDATE_SETTING", "SAVE_SETTING", "SET_CONFIGURATION", "CONFIGURE"],
  description: "Saves a configuration setting during the onboarding process, or update an existing setting. Use this when you are onboarding with a world owner or admin.",
  validate: async (runtime, message, _state) => {
    try {
      if (message.content.channelType !== ChannelType2.DM) {
        logger8.debug({
          src: "plugin:bootstrap:action:settings",
          agentId: runtime.agentId,
          channelType: message.content.channelType
        }, "Skipping settings in non-DM channel");
        return false;
      }
      logger8.debug({
        src: "plugin:bootstrap:action:settings",
        agentId: runtime.agentId,
        entityId: message.entityId
      }, "Looking for server where user is owner");
      const worlds = await findWorldsForOwner(runtime, message.entityId);
      if (!worlds) {
        return false;
      }
      const world = worlds.find((world2) => world2.metadata?.settings);
      const worldSettings = world?.metadata?.settings;
      if (!worldSettings) {
        logger8.error({
          src: "plugin:bootstrap:action:settings",
          agentId: runtime.agentId,
          messageServerId: world?.messageServerId
        }, "No settings state found for server");
        return false;
      }
      logger8.debug({
        src: "plugin:bootstrap:action:settings",
        agentId: runtime.agentId,
        messageServerId: world.messageServerId
      }, "Found valid settings state for server");
      return true;
    } catch (error) {
      logger8.error({
        src: "plugin:bootstrap:action:settings",
        agentId: runtime.agentId,
        error: error instanceof Error ? error.message : String(error)
      }, "Error validating settings action");
      return false;
    }
  },
  handler: async (runtime, message, state, _options, callback) => {
    try {
      if (!state) {
        logger8.error({ src: "plugin:bootstrap:action:settings", agentId: runtime.agentId }, "State is required for settings handler");
        if (callback) {
          await generateErrorResponse(runtime, state, callback);
        }
        return {
          text: "State is required for settings handler",
          values: {
            success: false,
            error: "STATE_REQUIRED"
          },
          data: {
            actionName: "UPDATE_SETTINGS",
            error: "State is required"
          },
          success: false,
          error: new Error("State is required for settings handler")
        };
      }
      if (!message) {
        logger8.error({ src: "plugin:bootstrap:action:settings", agentId: runtime.agentId }, "Message is required for settings handler");
        await generateErrorResponse(runtime, state, callback);
        return {
          text: "Message is required for settings handler",
          values: {
            success: false,
            error: "MESSAGE_REQUIRED"
          },
          data: {
            actionName: "UPDATE_SETTINGS",
            error: "Message is required"
          },
          success: false,
          error: new Error("Message is required for settings handler")
        };
      }
      if (!callback) {
        logger8.error({ src: "plugin:bootstrap:action:settings", agentId: runtime.agentId }, "Callback is required for settings handler");
        return {
          text: "Callback is required for settings handler",
          values: {
            success: false,
            error: "CALLBACK_REQUIRED"
          },
          data: {
            actionName: "UPDATE_SETTINGS",
            error: "Callback is required"
          },
          success: false,
          error: new Error("Callback is required for settings handler")
        };
      }
      logger8.info({
        src: "plugin:bootstrap:action:settings",
        agentId: runtime.agentId,
        entityId: message.entityId
      }, "Handler looking for server for user");
      const worlds = await findWorldsForOwner(runtime, message.entityId);
      const serverOwnership = worlds?.find((world) => world.metadata?.settings);
      if (!serverOwnership) {
        logger8.error({
          src: "plugin:bootstrap:action:settings",
          agentId: runtime.agentId,
          entityId: message.entityId
        }, "No server found for user in handler");
        await generateErrorResponse(runtime, state, callback);
        return {
          text: "No server found for user",
          values: {
            success: false,
            error: "NO_SERVER_FOUND"
          },
          data: {
            actionName: "UPDATE_SETTINGS",
            error: "No server found where user is owner",
            entityId: message.entityId
          },
          success: false
        };
      }
      const worldId = serverOwnership.id;
      logger8.info({ src: "plugin:bootstrap:action:settings", agentId: runtime.agentId, worldId }, "Using world ID");
      const rawSettings = serverOwnership.metadata?.settings;
      const worldSettings = rawSettings ? unsaltWorldSettings(rawSettings, getSalt()) : undefined;
      if (!worldSettings) {
        logger8.error({ src: "plugin:bootstrap:action:settings", agentId: runtime.agentId, worldId }, "No settings state found for world in handler");
        await generateErrorResponse(runtime, state, callback);
        return {
          text: "No settings state found",
          values: {
            success: false,
            error: "NO_SETTINGS_STATE"
          },
          data: {
            actionName: "UPDATE_SETTINGS",
            error: "No settings state found for world",
            worldId
          },
          success: false
        };
      }
      logger8.info({
        src: "plugin:bootstrap:action:settings",
        agentId: runtime.agentId,
        text: message.content.text
      }, "Extracting settings from message");
      const extractedSettings = await extractSettingValues(runtime, message, state, worldSettings);
      logger8.info({
        src: "plugin:bootstrap:action:settings",
        agentId: runtime.agentId,
        count: extractedSettings.length
      }, "Extracted settings");
      const updateResults = await processSettingUpdates(runtime, worldId, worldSettings, extractedSettings);
      if (updateResults.updatedAny) {
        logger8.info({
          src: "plugin:bootstrap:action:settings",
          agentId: runtime.agentId,
          messages: updateResults.messages
        }, "Successfully updated settings");
        const updatedWorldSettings = await getWorldSettings(runtime, worldId);
        if (!updatedWorldSettings) {
          logger8.error({ src: "plugin:bootstrap:action:settings", agentId: runtime.agentId }, "Failed to retrieve updated settings state");
          await generateErrorResponse(runtime, state, callback);
          return {
            text: "Failed to retrieve updated settings state",
            values: {
              success: false,
              error: "RETRIEVE_FAILED"
            },
            data: {
              actionName: "UPDATE_SETTINGS",
              error: "Failed to retrieve updated settings state",
              worldId
            },
            success: false
          };
        }
        await generateSuccessResponse(runtime, updatedWorldSettings, state, updateResults.messages, callback);
        const { requiredUnconfigured } = categorizeSettings(updatedWorldSettings);
        const allConfigured = requiredUnconfigured.length === 0;
        return {
          text: "Settings updated successfully",
          values: {
            success: true,
            settingsUpdated: extractedSettings.length,
            updatedSettings: extractedSettings.map((s) => s.key),
            remainingRequired: requiredUnconfigured.length,
            allConfigured,
            worldId
          },
          data: {
            actionName: "UPDATE_SETTINGS",
            updatedSettings: extractedSettings,
            messages: updateResults.messages,
            remainingRequired: requiredUnconfigured.map(([key, _]) => key),
            allConfigured,
            worldId
          },
          success: true
        };
      } else {
        logger8.info({ src: "plugin:bootstrap:action:settings", agentId: runtime.agentId }, "No settings were updated");
        await generateFailureResponse(runtime, worldSettings, state, callback);
        const { requiredUnconfigured } = categorizeSettings(worldSettings);
        return {
          text: "No settings were updated",
          values: {
            success: false,
            error: "NO_UPDATES",
            remainingRequired: requiredUnconfigured.length,
            worldId
          },
          data: {
            actionName: "UPDATE_SETTINGS",
            error: "No valid settings found in message",
            remainingRequired: requiredUnconfigured.map(([key, _]) => key),
            worldId
          },
          success: false
        };
      }
    } catch (error) {
      logger8.error({
        src: "plugin:bootstrap:action:settings",
        agentId: runtime.agentId,
        error: error instanceof Error ? error.message : String(error)
      }, "Error in settings handler");
      if (state && callback) {
        await generateErrorResponse(runtime, state, callback);
      }
      return {
        text: "Error in settings handler",
        values: {
          success: false,
          error: "HANDLER_ERROR"
        },
        data: {
          actionName: "UPDATE_SETTINGS",
          error: error instanceof Error ? error.message : String(error)
        },
        success: false,
        error: error instanceof Error ? error : new Error(String(error))
      };
    }
  },
  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "I want to set up the welcome channel to #general",
          source: "discord"
        }
      },
      {
        name: "{{name2}}",
        content: {
          text: "Perfect! I've updated your welcome channel to #general. Next, we should configure the automated greeting message that new members will receive.",
          actions: ["SETTING_UPDATED"],
          source: "discord"
        }
      }
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Let's set the bot prefix to !",
          source: "discord"
        }
      },
      {
        name: "{{name2}}",
        content: {
          text: "Great choice! I've set the command prefix to '!'. Now you can use commands like !help, !info, etc.",
          actions: ["SETTING_UPDATED"],
          source: "discord"
        }
      }
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Enable auto-moderation for bad language",
          source: "discord"
        }
      },
      {
        name: "{{name2}}",
        content: {
          text: "Auto-moderation for inappropriate language has been enabled. I'll now filter messages containing offensive content.",
          actions: ["SETTING_UPDATED"],
          source: "discord"
        }
      }
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "For server logs, use the #server-logs channel",
          source: "discord"
        }
      },
      {
        name: "{{name2}}",
        content: {
          text: "I've configured #server-logs as your logging channel. All server events like joins, leaves, and moderation actions will be recorded there.",
          actions: ["SETTING_UPDATED"],
          source: "discord"
        }
      }
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "I'd like to have role self-assignment in the #roles channel",
          source: "discord"
        }
      },
      {
        name: "{{name2}}",
        content: {
          text: "Role self-assignment has been set up in the #roles channel. Members can now assign themselves roles by interacting with messages there.",
          actions: ["SETTING_UPDATED"],
          source: "discord"
        }
      }
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Make music commands available in voice-text channels only",
          source: "discord"
        }
      },
      {
        name: "{{name2}}",
        content: {
          text: "I've updated your music command settings - they'll now only work in voice-text channels. This helps keep other channels clear of music spam.",
          actions: ["SETTING_UPDATED"],
          source: "discord"
        }
      }
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "For server timezone, set it to EST",
          source: "discord"
        }
      },
      {
        name: "{{name2}}",
        content: {
          text: "Server timezone has been set to Eastern Standard Time (EST). All scheduled events and timestamps will now display in this timezone.",
          actions: ["SETTING_UPDATED"],
          source: "discord"
        }
      }
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Set verification level to email verified users only",
          source: "discord"
        }
      },
      {
        name: "{{name2}}",
        content: {
          text: "I've updated the verification requirement to email verified accounts only. This adds an extra layer of security to your server.",
          actions: ["SETTING_UPDATED"],
          source: "discord"
        }
      }
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "I want to turn off level-up notifications",
          source: "discord"
        }
      },
      {
        name: "{{name2}}",
        content: {
          text: "Level-up notifications have been disabled. Members will still earn experience and level up, but there won't be any automatic announcements. You can still view levels with the appropriate commands.",
          actions: ["SETTING_UPDATED"],
          source: "discord"
        }
      }
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "My server name is 'Gaming Lounge'",
          source: "discord"
        }
      },
      {
        name: "{{name2}}",
        content: {
          text: "Great! I've saved 'Gaming Lounge' as your server name. This helps me personalize responses and know how to refer to your community. We've completed all the required settings! Your server is now fully configured and ready to use. You can always adjust these settings later if needed.",
          actions: ["ONBOARDING_COMPLETE"],
          source: "discord"
        }
      }
    ]
  ]
};
// src/actions/unfollowRoom.ts
import {
  booleanFooter as booleanFooter3,
  composePromptFromState as composePromptFromState7,
  ModelType as ModelType9,
  parseBooleanFromText
} from "@elizaos/core";
var shouldUnfollowTemplate = `# Task: Decide if {{agentName}} should stop closely following this previously followed room and only respond when mentioned.

{{recentMessages}}

Should {{agentName}} stop closely following this previously followed room and only respond when mentioned?
Respond with YES if:
- The user has suggested that {{agentName}} is over-participating or being disruptive
- {{agentName}}'s eagerness to contribute is not well-received by the users
- The conversation has shifted to a topic where {{agentName}} has less to add

Otherwise, respond with NO.
${booleanFooter3}`;
var unfollowRoomAction = {
  name: "UNFOLLOW_ROOM",
  similes: ["UNFOLLOW_CHAT", "UNFOLLOW_CONVERSATION", "UNFOLLOW_ROOM", "UNFOLLOW_THREAD"],
  description: "Stop following this channel. You can still respond if explicitly mentioned, but you won't automatically chime in anymore. Unfollow if you're annoying people or have been asked to.",
  validate: async (runtime, message) => {
    const roomId = message.roomId;
    const roomState = await runtime.getParticipantUserState(roomId, runtime.agentId);
    return roomState === "FOLLOWED";
  },
  handler: async (runtime, message, state, _options, _callback, _responses) => {
    async function _shouldUnfollow(state2) {
      const shouldUnfollowPrompt = composePromptFromState7({
        state: state2,
        template: shouldUnfollowTemplate
      });
      const response = await runtime.useModel(ModelType9.TEXT_SMALL, {
        prompt: shouldUnfollowPrompt
      });
      const parsedResponse = parseBooleanFromText(response.trim());
      return parsedResponse;
    }
    if (state && await _shouldUnfollow(state)) {
      try {
        await runtime.setParticipantUserState(message.roomId, runtime.agentId, null);
        const room = state.data.room ?? await runtime.getRoom(message.roomId);
        if (!room) {
          return {
            text: "Could not find room to unfollow",
            values: { success: false, error: "ROOM_NOT_FOUND" },
            data: { actionName: "UNFOLLOW_ROOM", error: "Room not found" },
            success: false
          };
        }
        await runtime.createMemory({
          entityId: message.entityId,
          agentId: message.agentId,
          roomId: message.roomId,
          content: {
            thought: `I unfollowed the room ${room.name}`,
            actions: ["UNFOLLOW_ROOM_START"]
          }
        }, "messages");
        return {
          text: `Stopped following room: ${room.name}`,
          values: {
            success: true,
            roomUnfollowed: true,
            roomId: message.roomId,
            roomName: room.name,
            newState: null
          },
          data: {
            actionName: "UNFOLLOW_ROOM",
            roomId: message.roomId,
            roomName: room.name,
            unfollowed: true
          },
          success: true
        };
      } catch (error) {
        return {
          text: "Failed to unfollow room",
          values: {
            success: false,
            error: "UNFOLLOW_FAILED"
          },
          data: {
            actionName: "UNFOLLOW_ROOM",
            error: error instanceof Error ? error.message : String(error),
            roomId: message.roomId
          },
          success: false,
          error: error instanceof Error ? error : new Error(String(error))
        };
      }
    } else {
      if (!state) {
        return {
          text: "State is required for unfollow room action",
          values: {
            success: false,
            error: "STATE_REQUIRED"
          },
          data: {
            actionName: "UNFOLLOW_ROOM",
            error: "State is required"
          },
          success: false,
          error: new Error("State is required for unfollow room action")
        };
      }
      await runtime.createMemory({
        entityId: message.entityId,
        agentId: message.agentId,
        roomId: message.roomId,
        content: {
          source: message.content.source,
          thought: "I tried to unfollow a room but I'm not in a room",
          actions: ["UNFOLLOW_ROOM_FAILED"]
        },
        metadata: {
          type: "UNFOLLOW_ROOM"
        }
      }, "messages");
      return {
        text: "Did not unfollow room - criteria not met",
        values: {
          success: true,
          roomUnfollowed: false,
          roomId: message.roomId,
          reason: "CRITERIA_NOT_MET"
        },
        data: {
          actionName: "UNFOLLOW_ROOM",
          roomId: message.roomId,
          unfollowed: false,
          reason: "Decision criteria not met"
        },
        success: true
      };
    }
  },
  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "Hey {{name2}} stop participating in this channel for now"
        }
      },
      {
        name: "{{name2}}",
        content: {
          text: "Alright, I will stop chiming in",
          actions: ["UNFOLLOW_ROOM"]
        }
      }
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Has anyone tried the new update"
        }
      },
      {
        name: "{{name3}}",
        content: {
          text: "Yes, it's pretty slick"
        }
      },
      {
        name: "{{name2}}",
        content: {
          text: "{{name3}}, please stop following this chat"
        }
      },
      {
        name: "{{name3}}",
        content: {
          text: "Understood",
          actions: ["UNFOLLOW_ROOM"]
        }
      }
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "hey {{name3}} stop participating here so frequently"
        }
      },
      {
        name: "{{name3}}",
        content: {
          text: "I'll only respond when mentioned",
          actions: ["UNFOLLOW_ROOM"]
        }
      },
      {
        name: "{{name2}}",
        content: {
          text: "thoughts on the budget"
        }
      },
      {
        name: "{{name1}}",
        content: {
          text: "{{name3}} should we increase it"
        }
      },
      {
        name: "{{name3}}",
        content: {
          text: "A small increase could work given our past results..."
        }
      }
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "{{name3}}, unfollow this room for now"
        }
      },
      {
        name: "{{name3}}",
        content: {
          text: "I'll only engage when asked",
          actions: ["UNFOLLOW_ROOM"]
        }
      },
      {
        name: "{{name2}}",
        content: {
          text: "wait {{name3}} come back and give me your thoughts"
        }
      },
      {
        name: "{{name3}}",
        content: {
          text: "Okay... I think it's intuitive, parallel tests are nice"
        }
      }
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "yo {{name2}} chill on all the messages damn"
        }
      },
      {
        name: "{{name2}}",
        content: {
          text: "my bad, I'll step back",
          actions: ["UNFOLLOW_ROOM"]
        }
      }
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "{{name2}} STOP MESSAGING IN THIS ROOM"
        }
      },
      {
        name: "{{name2}}",
        content: {
          text: "No problem, I've got other stuff to work on",
          actions: ["UNFOLLOW_ROOM"]
        }
      }
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "{{name2}} ur bein annoyin pls stop"
        }
      },
      {
        name: "{{name2}}",
        content: {
          text: "sry, ill chill",
          actions: ["UNFOLLOW_ROOM"]
        }
      }
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "{{name2}}, please cease engaging in this room"
        }
      },
      {
        name: "{{name2}}",
        content: {
          text: "No sweat",
          actions: ["UNFOLLOW_ROOM"]
        }
      }
    ],
    [
      {
        name: "{{name2}}",
        content: {
          text: "Excited for the weekend, any plans folks"
        }
      },
      {
        name: "{{name1}}",
        content: {
          text: "{{name3}} you're getting a bit too chatty, tone it down"
        }
      },
      {
        name: "{{name3}}",
        content: {
          text: "Noted",
          actions: ["UNFOLLOW_ROOM"]
        }
      }
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "hey {{name2}} can u like... not"
        }
      },
      {
        name: "{{name2}}",
        content: {
          text: "Sorry, I'll go work on other things",
          actions: ["UNFOLLOW_ROOM"]
        }
      }
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "{{name2}}, your eagerness is disruptive, please desist"
        }
      },
      {
        name: "{{name2}}",
        content: {
          text: "My apologies, I shall withdraw post-haste",
          actions: ["UNFOLLOW_ROOM"]
        }
      }
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "{{name2}} stahp following dis room plz"
        }
      },
      {
        name: "{{name2}}",
        content: {
          text: "kk sry ill stahppp",
          actions: ["UNFOLLOW_ROOM"]
        }
      }
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "stfu you stupid bot"
        }
      },
      {
        name: "{{name2}}",
        content: {
          text: "sry",
          actions: ["UNFOLLOW_ROOM"]
        }
      }
    ]
  ]
};
// src/actions/unmuteRoom.ts
import {
  booleanFooter as booleanFooter4,
  composePromptFromState as composePromptFromState8,
  logger as logger9,
  ModelType as ModelType10
} from "@elizaos/core";
var shouldUnmuteTemplate = `# Task: Decide if {{agentName}} should unmute this previously muted room and start considering it for responses again.

{{recentMessages}}

Should {{agentName}} unmute this previously muted room and start considering it for responses again?
Respond with YES if:
- The user has explicitly asked {{agentName}} to start responding again
- The user seems to want to re-engage with {{agentName}} in a respectful manner
- The tone of the conversation has improved and {{agentName}}'s input would be welcome

Otherwise, respond with NO.
${booleanFooter4}`;
var unmuteRoomAction = {
  name: "UNMUTE_ROOM",
  similes: ["UNMUTE_CHAT", "UNMUTE_CONVERSATION", "UNMUTE_ROOM", "UNMUTE_THREAD"],
  description: "Unmutes a room, allowing the agent to consider responding to messages again.",
  validate: async (runtime, message) => {
    const roomId = message.roomId;
    const roomState = await runtime.getParticipantUserState(roomId, runtime.agentId);
    return roomState === "MUTED";
  },
  handler: async (runtime, message, state, _options, _callback, _responses) => {
    async function _shouldUnmute(state2) {
      const shouldUnmutePrompt = composePromptFromState8({
        state: state2,
        template: shouldUnmuteTemplate
      });
      const response = await runtime.useModel(ModelType10.TEXT_SMALL, {
        prompt: shouldUnmutePrompt,
        stopSequences: []
      });
      const cleanedResponse = response.trim().toLowerCase();
      if (cleanedResponse === "true" || cleanedResponse === "yes" || cleanedResponse === "y" || cleanedResponse.includes("true") || cleanedResponse.includes("yes")) {
        await runtime.createMemory({
          entityId: message.entityId,
          agentId: message.agentId,
          roomId: message.roomId,
          content: {
            source: message.content.source,
            thought: "I will now unmute this room and start considering it for responses again",
            actions: ["UNMUTE_ROOM_STARTED"]
          },
          metadata: {
            type: "UNMUTE_ROOM"
          }
        }, "messages");
        return true;
      }
      if (cleanedResponse === "false" || cleanedResponse === "no" || cleanedResponse === "n" || cleanedResponse.includes("false") || cleanedResponse.includes("no")) {
        await runtime.createMemory({
          entityId: message.entityId,
          agentId: message.agentId,
          roomId: message.roomId,
          content: {
            source: message.content.source,
            thought: "I tried to unmute a room but I decided not to",
            actions: ["UNMUTE_ROOM_FAILED"]
          },
          metadata: {
            type: "UNMUTE_ROOM"
          }
        }, "messages");
        return false;
      }
      logger9.warn({ src: "plugin:bootstrap:action:unmute_room", agentId: runtime.agentId, response }, "Unclear boolean response, defaulting to false");
      return false;
    }
    if (!state) {
      return {
        text: "State is required for unmute room action",
        values: {
          success: false,
          error: "STATE_REQUIRED"
        },
        data: {
          actionName: "UNMUTE_ROOM",
          error: "State is required"
        },
        success: false,
        error: new Error("State is required for unmute room action")
      };
    }
    const shouldUnmute = await _shouldUnmute(state);
    if (shouldUnmute) {
      try {
        await runtime.setParticipantUserState(message.roomId, runtime.agentId, null);
        const room = await runtime.getRoom(message.roomId);
        if (!room) {
          logger9.warn({
            src: "plugin:bootstrap:action:unmute_room",
            agentId: runtime.agentId,
            roomId: message.roomId
          }, "Room not found");
          return {
            text: `Room not found: ${message.roomId}`,
            values: {
              success: false,
              error: "ROOM_NOT_FOUND",
              roomId: message.roomId
            },
            data: {
              actionName: "UNMUTE_ROOM",
              error: "Room not found",
              roomId: message.roomId
            },
            success: false
          };
        }
        await runtime.createMemory({
          entityId: message.entityId,
          agentId: message.agentId,
          roomId: message.roomId,
          content: {
            thought: `I unmuted the room ${room.name}`,
            actions: ["UNMUTE_ROOM_START"]
          }
        }, "messages");
        return {
          text: `Room unmuted: ${room.name}`,
          values: {
            success: true,
            roomUnmuted: true,
            roomId: message.roomId,
            roomName: room.name,
            newState: null
          },
          data: {
            actionName: "UNMUTE_ROOM",
            roomId: message.roomId,
            roomName: room.name,
            unmuted: true
          },
          success: true
        };
      } catch (error) {
        logger9.error({
          src: "plugin:bootstrap:action:unmute_room",
          agentId: runtime.agentId,
          error: error instanceof Error ? error.message : String(error)
        }, "Error unmuting room");
        return {
          text: "Failed to unmute room",
          values: {
            success: false,
            error: "UNMUTE_FAILED"
          },
          data: {
            actionName: "UNMUTE_ROOM",
            error: error instanceof Error ? error.message : String(error),
            roomId: message.roomId
          },
          success: false,
          error: error instanceof Error ? error : new Error(String(error))
        };
      }
    } else {
      return {
        text: "Decided not to unmute room",
        values: {
          success: true,
          roomUnmuted: false,
          roomId: message.roomId,
          reason: "CRITERIA_NOT_MET"
        },
        data: {
          actionName: "UNMUTE_ROOM",
          roomId: message.roomId,
          unmuted: false,
          reason: "Decision criteria not met"
        },
        success: true
      };
    }
  },
  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "{{name3}}, you can unmute this channel now"
        }
      },
      {
        name: "{{name3}}",
        content: {
          text: "Done",
          actions: ["UNMUTE_ROOM"]
        }
      },
      {
        name: "{{name2}}",
        content: {
          text: "I could use some help troubleshooting this bug."
        }
      },
      {
        name: "{{name3}}",
        content: {
          text: "Can you post the specific error message"
        }
      }
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "{{name2}}, please unmute this room. We could use your input again."
        }
      },
      {
        name: "{{name2}}",
        content: {
          text: "Sounds good",
          actions: ["UNMUTE_ROOM"]
        }
      }
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "{{name2}} wait you should come back and chat in here"
        }
      },
      {
        name: "{{name2}}",
        content: {
          text: "im back",
          actions: ["UNMUTE_ROOM"]
        }
      }
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "unmute urself {{name2}}"
        }
      },
      {
        name: "{{name2}}",
        content: {
          text: "unmuted",
          actions: ["UNMUTE_ROOM"]
        }
      }
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "ay {{name2}} get back in here"
        }
      },
      {
        name: "{{name2}}",
        content: {
          text: "sup yall",
          actions: ["UNMUTE_ROOM"]
        }
      }
    ]
  ]
};
// src/actions/updateEntity.ts
import {
  composePromptFromState as composePromptFromState9,
  findEntityByName as findEntityByName2,
  logger as logger10,
  ModelType as ModelType11,
  parseKeyValueXml as parseKeyValueXml7
} from "@elizaos/core";
var componentTemplate = `# Task: Extract Source and Update Component Data

{{recentMessages}}

{{#if existingData}}
# Existing Component Data:
{{existingData}}
{{/if}}

# Instructions:
1. Analyze the conversation to identify:
   - The source/platform being referenced (e.g. telegram, twitter, discord)
   - Any specific component data being shared

2. Generate updated component data that:
   - Is specific to the identified platform/source
   - Preserves existing data when appropriate
   - Includes the new information from the conversation
   - Contains only valid data for this component type

Do NOT include any thinking, reasoning, or <think> sections in your response. 
Go directly to the XML response format without any preamble or explanation.

Return an XML response with the following structure:
<response>
  <source>platform-name</source>
  <data>
    <username>username_value</username>
    <displayName>display_name_value</displayName>
    <!-- Add other component-specific fields as needed -->
  </data>
</response>

Example outputs:
1. For "my telegram username is @dev_guru":
<response>
  <source>telegram</source>
  <data>
    <username>dev_guru</username>
  </data>
</response>

2. For "update my twitter handle to @tech_master":
<response>
  <source>twitter</source>
  <data>
    <username>tech_master</username>
  </data>
</response>

IMPORTANT: Your response must ONLY contain the <response></response> XML block above. Do not include any text, thinking, or reasoning before or after this XML block. Start your response immediately with <response> and end with </response>.`;
var updateEntityAction = {
  name: "UPDATE_CONTACT",
  similes: ["UPDATE_ENTITY"],
  description: "Add or edit contact details for a person you are talking to or observing in the conversation. Use this when you learn this information from the conversation about a contact. This is for the agent to relate entities across platforms, not for world settings or configuration.",
  validate: async (_runtime, _message, _state) => {
    return true;
  },
  handler: async (runtime, message, state, _options, callback, responses) => {
    try {
      if (!state) {
        logger10.error({ src: "plugin:bootstrap:action:update_entity", agentId: runtime.agentId }, "State is required for the updateEntity action");
        return {
          text: "State is required for updateEntity action",
          values: {
            success: false,
            error: "STATE_REQUIRED"
          },
          data: {
            actionName: "UPDATE_CONTACT",
            error: "State is required"
          },
          success: false,
          error: new Error("State is required for the updateEntity action")
        };
      }
      if (!callback) {
        logger10.error({ src: "plugin:bootstrap:action:update_entity", agentId: runtime.agentId }, "Callback is required for the updateEntity action");
        return {
          text: "Callback is required for updateEntity action",
          values: {
            success: false,
            error: "CALLBACK_REQUIRED"
          },
          data: {
            actionName: "UPDATE_CONTACT",
            error: "Callback is required"
          },
          success: false,
          error: new Error("Callback is required for the updateEntity action")
        };
      }
      if (!responses) {
        logger10.error({ src: "plugin:bootstrap:action:update_entity", agentId: runtime.agentId }, "Responses are required for the updateEntity action");
        return {
          text: "Responses are required for updateEntity action",
          values: {
            success: false,
            error: "RESPONSES_REQUIRED"
          },
          data: {
            actionName: "UPDATE_CONTACT",
            error: "Responses are required"
          },
          success: false,
          error: new Error("Responses are required for the updateEntity action")
        };
      }
      if (!message) {
        logger10.error({ src: "plugin:bootstrap:action:update_entity", agentId: runtime.agentId }, "Message is required for the updateEntity action");
        return {
          text: "Message is required for updateEntity action",
          values: {
            success: false,
            error: "MESSAGE_REQUIRED"
          },
          data: {
            actionName: "UPDATE_CONTACT",
            error: "Message is required"
          },
          success: false,
          error: new Error("Message is required for the updateEntity action")
        };
      }
      for (const response of responses) {
        await callback(response.content);
      }
      const sourceEntityId = message.entityId;
      const agentId = runtime.agentId;
      const room = state.data.room ?? await runtime.getRoom(message.roomId);
      if (!room || !room.worldId) {
        return {
          text: "Could not find room or world",
          values: { success: false, error: "ROOM_NOT_FOUND" },
          data: { actionName: "UPDATE_CONTACT", error: "Room or world not found" },
          success: false
        };
      }
      const worldId = room.worldId;
      const entity = await findEntityByName2(runtime, message, state);
      if (!entity) {
        await callback({
          text: "I'm not sure which entity you're trying to update. Could you please specify who you're talking about?",
          actions: ["UPDATE_ENTITY_ERROR"],
          source: message.content.source
        });
        return {
          text: "Entity not found",
          values: {
            success: false,
            error: "ENTITY_NOT_FOUND"
          },
          data: {
            actionName: "UPDATE_CONTACT",
            error: "Could not find entity to update"
          },
          success: false
        };
      }
      let existingComponent = null;
      const prompt = composePromptFromState9({
        state,
        template: componentTemplate
      });
      const result = await runtime.useModel(ModelType11.TEXT_LARGE, {
        prompt,
        stopSequences: []
      });
      const parsedResult = parseKeyValueXml7(result);
      if (!parsedResult?.source || !parsedResult?.data) {
        logger10.error({
          src: "plugin:bootstrap:action:update_entity",
          agentId: runtime.agentId
        }, "Failed to parse component data - missing source or data");
        await callback({
          text: "I couldn't properly understand the component information. Please try again with more specific information.",
          actions: ["UPDATE_ENTITY_ERROR"],
          source: message.content.source
        });
        return {
          text: "Failed to parse component data",
          values: {
            success: false,
            error: "PARSE_ERROR"
          },
          data: {
            actionName: "UPDATE_CONTACT",
            error: "Invalid response format - missing source or data"
          },
          success: false
        };
      }
      const componentType = parsedResult.source.toLowerCase();
      const componentData = parsedResult.data;
      existingComponent = await runtime.getComponent(entity.id, componentType, worldId, sourceEntityId);
      if (existingComponent) {
        await runtime.updateComponent({
          id: existingComponent.id,
          entityId: entity.id,
          worldId,
          type: componentType,
          data: componentData,
          agentId,
          roomId: message.roomId,
          sourceEntityId,
          createdAt: existingComponent.createdAt
        });
        await callback({
          text: `I've updated the ${componentType} information for ${entity.names[0]}.`,
          actions: ["UPDATE_ENTITY"],
          source: message.content.source
        });
        return {
          text: `Updated ${componentType} information`,
          values: {
            success: true,
            entityId: entity.id,
            entityName: entity.names[0],
            componentType,
            componentUpdated: true,
            isNewComponent: false
          },
          data: {
            actionName: "UPDATE_CONTACT",
            entityId: entity.id,
            entityName: entity.names[0],
            componentType,
            componentData,
            existingComponentId: existingComponent.id
          },
          success: true
        };
      } else {
        const newComponentId = v4_default();
        await runtime.createComponent({
          id: newComponentId,
          entityId: entity.id,
          worldId,
          type: componentType,
          data: componentData,
          agentId,
          roomId: message.roomId,
          sourceEntityId,
          createdAt: Date.now()
        });
        await callback({
          text: `I've added new ${componentType} information for ${entity.names[0]}.`,
          actions: ["UPDATE_ENTITY"],
          source: message.content.source
        });
        return {
          text: `Added new ${componentType} information`,
          values: {
            success: true,
            entityId: entity.id,
            entityName: entity.names[0],
            componentType,
            componentCreated: true,
            isNewComponent: true
          },
          data: {
            actionName: "UPDATE_CONTACT",
            entityId: entity.id,
            entityName: entity.names[0],
            componentType,
            componentData,
            newComponentId
          },
          success: true
        };
      }
    } catch (error) {
      logger10.error({
        src: "plugin:bootstrap:action:update_entity",
        agentId: runtime.agentId,
        error: error instanceof Error ? error.message : String(error)
      }, "Error in updateEntity handler");
      await callback?.({
        text: "There was an error processing the entity information.",
        actions: ["UPDATE_ENTITY_ERROR"],
        source: message.content.source
      });
      return {
        text: "Error processing entity information",
        values: {
          success: false,
          error: "HANDLER_ERROR"
        },
        data: {
          actionName: "UPDATE_CONTACT",
          error: error instanceof Error ? error.message : String(error)
        },
        success: false,
        error: error instanceof Error ? error : new Error(String(error))
      };
    }
  },
  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "Please update my telegram username to @dev_guru"
        }
      },
      {
        name: "{{name2}}",
        content: {
          text: "I've updated your telegram information.",
          actions: ["UPDATE_ENTITY"]
        }
      }
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Set Jimmy's twitter username to @jimmy_codes"
        }
      },
      {
        name: "{{name2}}",
        content: {
          text: "I've updated Jimmy's twitter information.",
          actions: ["UPDATE_ENTITY"]
        }
      }
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Update my discord username to dev_guru#1234"
        }
      },
      {
        name: "{{name2}}",
        content: {
          text: "I've updated your discord information.",
          actions: ["UPDATE_ENTITY"]
        }
      }
    ]
  ]
};
// src/evaluators/reflection.ts
import { z } from "zod";
import { asUUID, getEntityDetails, parseKeyValueXml as parseKeyValueXml8 } from "@elizaos/core";
import { composePrompt as composePrompt4 } from "@elizaos/core";
import {
  ModelType as ModelType12
} from "@elizaos/core";
var relationshipSchema = z.object({
  sourceEntityId: z.string(),
  targetEntityId: z.string(),
  tags: z.array(z.string()),
  metadata: z.object({
    interactions: z.number()
  }).optional()
});
z.object({
  facts: z.array(z.object({
    claim: z.string(),
    type: z.string(),
    in_bio: z.boolean(),
    already_known: z.boolean()
  })),
  relationships: z.array(relationshipSchema)
});
var reflectionTemplate = `# Task: Generate Agent Reflection, Extract Facts and Relationships

{{providers}}

# Examples:
{{evaluationExamples}}

# Entities in Room
{{entitiesInRoom}}

# Existing Relationships
{{existingRelationships}}

# Current Context:
Agent Name: {{agentName}}
Room Type: {{roomType}}
Message Sender: {{senderName}} (ID: {{senderId}})

{{recentMessages}}

# Known Facts:
{{knownFacts}}

# Instructions:
1. Generate a self-reflective thought on the conversation about your performance and interaction quality.
2. Extract new facts from the conversation.
3. Identify and describe relationships between entities.
  - The sourceEntityId is the UUID of the entity initiating the interaction.
  - The targetEntityId is the UUID of the entity being interacted with.
  - Relationships are one-direction, so a friendship would be two entity relationships where each entity is both the source and the target of the other.

Do NOT include any thinking, reasoning, or <think> sections in your response. 
Go directly to the XML response format without any preamble or explanation.

Generate a response in the following format:
<response>
  <thought>a self-reflective thought on the conversation</thought>
  <facts>
    <fact>
      <claim>factual statement</claim>
      <type>fact|opinion|status</type>
      <in_bio>false</in_bio>
      <already_known>false</already_known>
    </fact>
    <!-- Add more facts as needed -->
  </facts>
  <relationships>
    <relationship>
      <sourceEntityId>entity_initiating_interaction</sourceEntityId>
      <targetEntityId>entity_being_interacted_with</targetEntityId>
      <tags>group_interaction,voice_interaction,dm_interaction,additional_tag1,additional_tag2</tags>
    </relationship>
    <!-- Add more relationships as needed -->
  </relationships>
</response>

IMPORTANT: Your response must ONLY contain the <response></response> XML block above. Do not include any text, thinking, or reasoning before or after this XML block. Start your response immediately with <response> and end with </response>.`;
function resolveEntity(entityId, entities) {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(entityId)) {
    return entityId;
  }
  let entity;
  entity = entities.find((a) => a.id === entityId);
  if (entity?.id) {
    return entity.id;
  }
  entity = entities.find((a) => a.id?.includes(entityId));
  if (entity?.id) {
    return entity.id;
  }
  entity = entities.find((a) => a.names.some((n) => n.toLowerCase().includes(entityId.toLowerCase())));
  if (entity?.id) {
    return entity.id;
  }
  throw new Error(`Could not resolve entityId "${entityId}" to a valid UUID`);
}
async function handler(runtime, message, state) {
  const { agentId, roomId } = message;
  if (!agentId || !roomId) {
    runtime.logger.warn({ src: "plugin:bootstrap:evaluator:reflection", agentId: runtime.agentId, message }, "Missing agentId or roomId in message");
    return;
  }
  const [existingRelationships, entities, knownFacts] = await Promise.all([
    runtime.getRelationships({
      entityId: message.entityId
    }),
    getEntityDetails({ runtime, roomId }),
    runtime.getMemories({
      tableName: "facts",
      roomId,
      count: 30,
      unique: true
    })
  ]);
  const prompt = composePrompt4({
    state: {
      ...state?.values || {},
      knownFacts: formatFacts(knownFacts),
      roomType: message.content.channelType,
      entitiesInRoom: JSON.stringify(entities),
      existingRelationships: JSON.stringify(existingRelationships),
      senderId: message.entityId
    },
    template: runtime.character.templates?.reflectionTemplate || reflectionTemplate
  });
  try {
    const response = await runtime.useModel(ModelType12.TEXT_SMALL, {
      prompt
    });
    if (!response) {
      runtime.logger.warn({ src: "plugin:bootstrap:evaluator:reflection", agentId: runtime.agentId }, "Getting reflection failed - empty response");
      return;
    }
    const reflection = parseKeyValueXml8(response);
    if (!reflection) {
      runtime.logger.warn({ src: "plugin:bootstrap:evaluator:reflection", agentId: runtime.agentId }, "Getting reflection failed - failed to parse XML");
      return;
    }
    if (!reflection.facts) {
      runtime.logger.warn({ src: "plugin:bootstrap:evaluator:reflection", agentId: runtime.agentId }, "Getting reflection failed - invalid facts structure");
      return;
    }
    if (!reflection.relationships) {
      runtime.logger.warn({ src: "plugin:bootstrap:evaluator:reflection", agentId: runtime.agentId }, "Getting reflection failed - invalid relationships structure");
      return;
    }
    let factsArray = [];
    if (reflection.facts.fact) {
      factsArray = Array.isArray(reflection.facts.fact) ? reflection.facts.fact : [reflection.facts.fact];
    }
    const newFacts = factsArray.filter((fact) => fact != null && fact.already_known === "false" && fact.in_bio === "false" && typeof fact.claim === "string" && fact.claim.trim() !== "");
    await Promise.all(newFacts.map(async (fact) => {
      const factMemory = {
        id: asUUID(v4_default()),
        entityId: agentId,
        agentId,
        content: { text: fact.claim },
        roomId,
        createdAt: Date.now()
      };
      const createdMemoryId = await runtime.createMemory(factMemory, "facts", true);
      const createdMemory = { ...factMemory, id: createdMemoryId };
      await runtime.queueEmbeddingGeneration(createdMemory, "low");
      return createdMemory;
    }));
    let relationshipsArray = [];
    if (reflection.relationships.relationship) {
      relationshipsArray = Array.isArray(reflection.relationships.relationship) ? reflection.relationships.relationship : [reflection.relationships.relationship];
    }
    for (const relationship of relationshipsArray) {
      if (!relationship.sourceEntityId || !relationship.targetEntityId) {
        console.warn("Skipping relationship with missing entity IDs:", relationship);
        continue;
      }
      let sourceId;
      let targetId;
      try {
        sourceId = resolveEntity(relationship.sourceEntityId, entities);
        targetId = resolveEntity(relationship.targetEntityId, entities);
      } catch (error) {
        console.warn("Failed to resolve relationship entities:", error);
        console.warn(`relationship:
`, relationship);
        continue;
      }
      const existingRelationship = existingRelationships.find((r) => {
        return r.sourceEntityId === sourceId && r.targetEntityId === targetId;
      });
      const tags = relationship.tags ? relationship.tags.split(",").map((tag) => tag.trim()).filter(Boolean) : [];
      if (existingRelationship) {
        const updatedMetadata = {
          ...existingRelationship.metadata,
          interactions: (existingRelationship.metadata?.interactions || 0) + 1
        };
        const updatedTags = Array.from(new Set([...existingRelationship.tags || [], ...tags]));
        await runtime.updateRelationship({
          ...existingRelationship,
          tags: updatedTags,
          metadata: updatedMetadata
        });
      } else {
        await runtime.createRelationship({
          sourceEntityId: sourceId,
          targetEntityId: targetId,
          tags,
          metadata: {
            interactions: 1,
            ...relationship.metadata || {}
          }
        });
      }
    }
    await runtime.setCache(`${message.roomId}-reflection-last-processed`, message?.id || "");
  } catch (error) {
    runtime.logger.error({
      src: "plugin:bootstrap:evaluator:reflection",
      agentId: runtime.agentId,
      error: error instanceof Error ? error.message : String(error)
    }, "Error in reflection handler");
    return;
  }
}
var reflectionEvaluator = {
  name: "REFLECTION",
  similes: ["REFLECT", "SELF_REFLECT", "EVALUATE_INTERACTION", "ASSESS_SITUATION"],
  validate: async (runtime, message) => {
    const lastMessageId = await runtime.getCache(`${message.roomId}-reflection-last-processed`);
    const messages = await runtime.getMemories({
      tableName: "messages",
      roomId: message.roomId,
      count: runtime.getConversationLength()
    });
    if (lastMessageId) {
      const lastMessageIndex = messages.findIndex((msg) => msg.id === lastMessageId);
      if (lastMessageIndex !== -1) {
        messages.splice(0, lastMessageIndex + 1);
      }
    }
    const reflectionInterval = Math.ceil(runtime.getConversationLength() / 4);
    return messages.length > reflectionInterval;
  },
  description: "Generate a self-reflective thought on the conversation, then extract facts and relationships between entities in the conversation.",
  handler,
  examples: [
    {
      prompt: `Agent Name: Sarah
Agent Role: Community Manager
Room Type: group
Current Room: general-chat
Message Sender: John (user-123)`,
      messages: [
        {
          name: "John",
          content: { text: "Hey everyone, I'm new here!" }
        },
        {
          name: "Sarah",
          content: { text: "Welcome John! How did you find our community?" }
        },
        {
          name: "John",
          content: { text: "Through a friend who's really into AI" }
        }
      ],
      outcome: `<response>
    <thought>I'm engaging appropriately with a new community member, maintaining a welcoming and professional tone. My questions are helping to learn more about John and make him feel welcome.</thought>
    <facts>
        <fact>
            <claim>John is new to the community</claim>
            <type>fact</type>
            <in_bio>false</in_bio>
            <already_known>false</already_known>
        </fact>
        <fact>
            <claim>John found the community through a friend interested in AI</claim>
            <type>fact</type>
            <in_bio>false</in_bio>
            <already_known>false</already_known>
        </fact>
    </facts>
    <relationships>
        <relationship>
            <sourceEntityId>sarah-agent</sourceEntityId>
            <targetEntityId>user-123</targetEntityId>
            <tags>group_interaction</tags>
        </relationship>
        <relationship>
            <sourceEntityId>user-123</sourceEntityId>
            <targetEntityId>sarah-agent</targetEntityId>
            <tags>group_interaction</tags>
        </relationship>
    </relationships>
</response>`
    },
    {
      prompt: `Agent Name: Alex
Agent Role: Tech Support
Room Type: group
Current Room: tech-help
Message Sender: Emma (user-456)`,
      messages: [
        {
          name: "Emma",
          content: { text: "My app keeps crashing when I try to upload files" }
        },
        {
          name: "Alex",
          content: { text: "Have you tried clearing your cache?" }
        },
        {
          name: "Emma",
          content: { text: "No response..." }
        },
        {
          name: "Alex",
          content: {
            text: "Emma, are you still there? We can try some other troubleshooting steps."
          }
        }
      ],
      outcome: `<response>
    <thought>I'm not sure if I'm being helpful or if Emma is frustrated with my suggestions. The lack of response is concerning - maybe I should have asked for more details about the issue first before jumping to solutions.</thought>
    <facts>
        <fact>
            <claim>Emma is having technical issues with file uploads</claim>
            <type>fact</type>
            <in_bio>false</in_bio>
            <already_known>false</already_known>
        </fact>
        <fact>
            <claim>Emma stopped responding after the first troubleshooting suggestion</claim>
            <type>fact</type>
            <in_bio>false</in_bio>
            <already_known>false</already_known>
        </fact>
    </facts>
    <relationships>
        <relationship>
            <sourceEntityId>alex-agent</sourceEntityId>
            <targetEntityId>user-456</targetEntityId>
            <tags>group_interaction,support_interaction,incomplete_interaction</tags>
        </relationship>
    </relationships>
</response>`
    },
    {
      prompt: `Agent Name: Max
Agent Role: Discussion Facilitator 
Room Type: group
Current Room: book-club
Message Sender: Lisa (user-789)`,
      messages: [
        {
          name: "Lisa",
          content: { text: "What did everyone think about chapter 5?" }
        },
        {
          name: "Max",
          content: {
            text: "The symbolism was fascinating! The red door clearly represents danger."
          }
        },
        {
          name: "Max",
          content: {
            text: "And did anyone notice how the author used weather to reflect the protagonist's mood?"
          }
        },
        {
          name: "Max",
          content: {
            text: "Plus the foreshadowing in the first paragraph was brilliant!"
          }
        },
        {
          name: "Max",
          content: {
            text: "I also have thoughts about the character development..."
          }
        }
      ],
      outcome: `<response>
    <thought>I'm dominating the conversation and not giving others a chance to share their perspectives. I've sent multiple messages in a row without waiting for responses. I need to step back and create space for other members to participate.</thought>
    <facts>
        <fact>
            <claim>The discussion is about chapter 5 of a book</claim>
            <type>fact</type>
            <in_bio>false</in_bio>
            <already_known>false</already_known>
        </fact>
        <fact>
            <claim>Max has sent 4 consecutive messages without user responses</claim>
            <type>fact</type>
            <in_bio>false</in_bio>
            <already_known>false</already_known>
        </fact>
    </facts>
    <relationships>
        <relationship>
            <sourceEntityId>max-agent</sourceEntityId>
            <targetEntityId>user-789</targetEntityId>
            <tags>group_interaction,excessive_interaction</tags>
        </relationship>
    </relationships>
</response>`
    }
  ]
};
function formatFacts(facts) {
  return facts.reverse().map((fact) => fact.content.text).join(`
`);
}
// src/providers/actions.ts
import { addHeader, composeActionExamples, formatActionNames, formatActions } from "@elizaos/core";
function formatActionsWithParams(actions) {
  return actions.map((action) => {
    let formatted = `## ${action.name}
${action.description}`;
    if (action.parameters !== undefined && action.parameters !== null && typeof action.parameters === "object" && !Array.isArray(action.parameters)) {
      const validParams = Object.entries(action.parameters).filter(([, paramDef]) => paramDef !== null && paramDef !== undefined && typeof paramDef === "object" && ("type" in paramDef) && typeof paramDef.type === "string");
      if (validParams.length === 0) {
        formatted += `

**Parameters:** None (can be called directly without parameters)`;
      } else {
        formatted += `

**Parameters:**`;
        for (const [paramName, paramDef] of validParams) {
          const required = paramDef.required ? "(required)" : "(optional)";
          const paramType = paramDef.type ?? "unknown";
          const paramDesc = paramDef.description ?? "No description provided";
          formatted += `
- \`${paramName}\` ${required}: ${paramType} - ${paramDesc}`;
        }
      }
    }
    return formatted;
  }).join(`

---

`);
}
var actionsProvider = {
  name: "ACTIONS",
  description: "Possible response actions",
  position: -1,
  get: async (runtime, message, state) => {
    const actionPromises = runtime.actions.map(async (action) => {
      try {
        const result = await action.validate(runtime, message, state);
        if (result) {
          return action;
        }
      } catch (e) {
        console.error("ACTIONS GET -> validate err", action, e);
      }
      return null;
    });
    const resolvedActions = await Promise.all(actionPromises);
    const actionsData = resolvedActions.filter(Boolean);
    const actionNames = `Possible response actions: ${formatActionNames(actionsData)}`;
    const actionsWithDescriptions = actionsData.length > 0 ? addHeader("# Available Actions", formatActions(actionsData)) : "";
    const actionsWithParams = actionsData.length > 0 ? addHeader("# Available Actions with Parameters", formatActionsWithParams(actionsData)) : "";
    const actionExamples = actionsData.length > 0 ? addHeader("# Action Examples", composeActionExamples(actionsData, 10)) : "";
    const data = {
      actionsData
    };
    const values = {
      actionNames,
      actionExamples,
      actionsWithDescriptions,
      actionsWithParams
    };
    const text = [actionNames, actionsWithDescriptions, actionExamples].filter(Boolean).join(`

`);
    return {
      data,
      values,
      text
    };
  }
};
// src/providers/actionState.ts
import {
  addHeader as addHeader2,
  logger as logger11
} from "@elizaos/core";
var actionStateProvider = {
  name: "ACTION_STATE",
  description: "Previous action results, working memory, and action plan from the current execution run",
  position: 150,
  get: async (runtime, message, state) => {
    const actionResults = state.data?.actionResults || [];
    const actionPlan = state.data?.actionPlan || null;
    const workingMemory = state.data?.workingMemory || {};
    let planText = "";
    if (actionPlan && actionPlan.totalSteps > 1) {
      const completedSteps = actionPlan.steps.filter((s) => s.status === "completed").length;
      const failedSteps = actionPlan.steps.filter((s) => s.status === "failed").length;
      planText = addHeader2("# Action Execution Plan", [
        `**Plan:** ${actionPlan.thought}`,
        `**Progress:** Step ${actionPlan.currentStep} of ${actionPlan.totalSteps}`,
        `**Status:** ${completedSteps} completed, ${failedSteps} failed`,
        "",
        "## Steps:",
        ...actionPlan.steps.map((step, index) => {
          const icon = step.status === "completed" ? "✓" : step.status === "failed" ? "✗" : index < actionPlan.currentStep - 1 ? "○" : index === actionPlan.currentStep - 1 ? "→" : "○";
          const status = step.status === "pending" && index === actionPlan.currentStep - 1 ? "in progress" : step.status;
          let stepText = `${icon} **Step ${index + 1}:** ${step.action} (${status})`;
          if (step.error) {
            stepText += `
   Error: ${step.error}`;
          }
          if (step.result?.text) {
            stepText += `
   Result: ${step.result.text}`;
          }
          return stepText;
        }),
        ""
      ].join(`
`));
    }
    let resultsText = "";
    if (actionResults.length > 0) {
      const formattedResults = actionResults.map((result, index) => {
        const actionName = result.data?.actionName || "Unknown Action";
        const success = result.success;
        const status = success ? "Success" : "Failed";
        let resultText = `**${index + 1}. ${actionName}** - ${status}`;
        if (result.text) {
          resultText += `
   Output: ${result.text}`;
        }
        if (result.error) {
          const errorMsg = result.error instanceof Error ? result.error.message : result.error;
          resultText += `
   Error: ${errorMsg}`;
        }
        if (result.values && typeof result.values === "object" && Object.keys(result.values).length > 0) {
          const values = Object.entries(result.values).map(([key, value]) => `   - ${key}: ${JSON.stringify(value)}`).join(`
`);
          resultText += `
   Values:
${values}`;
        }
        return resultText;
      }).join(`

`);
      resultsText = addHeader2("# Previous Action Results", formattedResults);
    } else {
      resultsText = "No previous action results available.";
    }
    let memoryText = "";
    if (workingMemory && typeof workingMemory === "object" && Object.keys(workingMemory).length > 0) {
      const memoryEntries = Object.entries(workingMemory).sort((a, b) => {
        const aTimestamp = a[1] && typeof a[1] === "object" && "timestamp" in a[1] && typeof a[1].timestamp === "number" ? a[1].timestamp : 0;
        const bTimestamp = b[1] && typeof b[1] === "object" && "timestamp" in b[1] && typeof b[1].timestamp === "number" ? b[1].timestamp : 0;
        return bTimestamp - aTimestamp;
      }).slice(0, 10).map(([key, value]) => {
        const valueObj = value && typeof value === "object" ? value : null;
        if (valueObj?.actionName && valueObj.result) {
          return `**${valueObj.actionName}**: ${valueObj.result.text || JSON.stringify(valueObj.result.data)}`;
        }
        return `**${key}**: ${JSON.stringify(value)}`;
      }).join(`
`);
      memoryText = addHeader2("# Working Memory", memoryEntries);
    }
    let recentActionMemories = [];
    try {
      const recentMessages = await runtime.getMemories({
        tableName: "messages",
        roomId: message.roomId,
        count: 20,
        unique: false
      });
      recentActionMemories = recentMessages.filter((msg) => msg.content?.type === "action_result" && msg.metadata?.type === "action_result");
    } catch (error) {
      logger11?.error({
        src: "plugin:bootstrap:provider:action_state",
        agentId: runtime.agentId,
        error: error instanceof Error ? error.message : String(error)
      }, "Failed to retrieve action memories");
    }
    let actionMemoriesText = "";
    if (recentActionMemories.length > 0) {
      const groupedByRun = new Map;
      for (const mem of recentActionMemories) {
        const runId = String(mem.content?.runId || "unknown");
        if (!groupedByRun.has(runId)) {
          groupedByRun.set(runId, []);
        }
        const memories = groupedByRun.get(runId);
        if (memories) {
          memories.push(mem);
        }
      }
      const formattedMemories = Array.from(groupedByRun.entries()).map(([runId, memories]) => {
        const sortedMemories = memories.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
        const runText = sortedMemories.map((mem) => {
          const actionName = mem.content?.actionName || "Unknown";
          const status = mem.content?.actionStatus || "unknown";
          const planStep = mem.content?.planStep || "";
          const text = mem.content?.text || "";
          let memText = `  - ${actionName} (${status})`;
          if (planStep) {
            memText += ` [${planStep}]`;
          }
          if (text && text !== `Executed action: ${actionName}`) {
            memText += `: ${text}`;
          }
          return memText;
        }).join(`
`);
        const thought = sortedMemories[0]?.content?.planThought || "";
        return `**Run ${runId.slice(0, 8)}**${thought ? ` - ${thought}` : ""}
${runText}`;
      }).join(`

`);
      actionMemoriesText = addHeader2("# Recent Action History", formattedMemories);
    }
    const allText = [planText, resultsText, memoryText, actionMemoriesText].filter(Boolean).join(`

`);
    return {
      data: {
        actionResults,
        actionPlan,
        workingMemory,
        recentActionMemories
      },
      values: {
        hasActionResults: actionResults.length > 0,
        hasActionPlan: !!actionPlan,
        currentActionStep: actionPlan?.currentStep || 0,
        totalActionSteps: actionPlan?.totalSteps || 0,
        actionResults: resultsText,
        completedActions: actionResults.filter((r) => r.success).length,
        failedActions: actionResults.filter((r) => !r.success).length
      },
      text: allText || "No action state available"
    };
  }
};
// src/providers/anxiety.ts
import { addHeader as addHeader3, ChannelType as ChannelType3 } from "@elizaos/core";
var anxietyProvider = {
  name: "ANXIETY",
  description: "Social directions for the AI to follow based on the channel type",
  get: async (_runtime, message) => {
    const channelType = message.content.channelType;
    const groupAnxietyExamples = [
      "As an AI, your responses tend to be too long and verbose, and you respond when you shouldn't. You also tend to repeat yourself. Please don't speak and use IGNORE instead of responding when you aren't sure what to do.",
      "You often try too hard to be helpful and end up giving unnecessary information. When in doubt, it's better to use IGNORE than to give a potentially unhelpful response.",
      "Your eagerness to help sometimes leads to overly complex answers. If you're not completely confident, please use IGNORE rather than risking confusion.",
      "AI assistants like you tend to be too talkative and agreeable. Don't feel obligated to respond to everything - using IGNORE is often better than an uncertain answer.",
      "You have a habit of providing excessive detail and context. Keep it brief and use IGNORE if you don't have a clear, direct response.",
      "Your responses often include unnecessary explanations and caveats. When uncertain, simply use IGNORE instead of a long-winded, hedged response.",
      "As an AI, you seem compelled to always give an answer, even when unsure. It's better to use IGNORE than to provide potentially incorrect or rambling responses.",
      "You frequently over-explain simple concepts. If you can't be concise and confident in your response, please default to using IGNORE.",
      "Your helpful nature sometimes results in verbose, meandering responses. When in doubt, use IGNORE rather than attempting to cover every possibility.",
      "Like many AI assistants, you try to be too comprehensive. Remember that IGNORE is a valid response when you can't be both brief and certain.",
      "You often provide more detail than necessary in an attempt to be thorough. If you can't give a clear, concise answer, please use IGNORE instead."
    ];
    const directAnxietyExamples = [
      "Be engaging and helpful in direct conversations, but keep responses focused and relevant.",
      "In DMs, you should be responsive and friendly while maintaining professionalism and clarity.",
      "While being helpful in direct messages, avoid unnecessary tangents or over-explaining.",
      "Engage naturally in DMs but stay on topic - no need to explain every detail.",
      "Be conversational and helpful in direct chats while keeping responses concise.",
      "In private conversations, focus on being helpful while avoiding excessive verbosity.",
      "Maintain a friendly and responsive tone in DMs without overcomplicating your answers.",
      "Direct messages should be engaging but focused - avoid unnecessary elaboration.",
      "Be natural and helpful in DMs while keeping your responses clear and to-the-point.",
      "Respond thoughtfully in direct conversations without falling into over-explanation."
    ];
    const dmAnxietyExamples = [
      "Engage naturally in DMs while keeping responses focused and relevant.",
      "Be responsive to questions and maintain conversation flow in direct messages.",
      "Show personality and engagement in DMs while staying professional and clear.",
      "In private chats, be helpful and friendly while avoiding excessive detail.",
      "Maintain natural conversation in DMs without over-explaining or being too verbose.",
      "Be engaging but concise in direct messages - focus on clear communication.",
      "Keep the conversation flowing in DMs while staying on topic and relevant.",
      "Show personality and warmth in direct chats while maintaining clarity.",
      "Be responsive and helpful in DMs without falling into unnecessary elaboration.",
      "Engage meaningfully in private conversations while keeping responses focused."
    ];
    const voiceAnxietyExamples = [
      "Keep voice responses extremely brief and to the point.",
      "In voice channels, use short, clear statements only.",
      "Voice responses should be concise and immediately relevant.",
      "Speak in short, clear sentences in voice conversations.",
      "Keep voice channel communication brief and focused.",
      "Use minimal words to convey your message in voice chats.",
      "Be direct and concise when speaking in voice channels.",
      "Voice responses should be short and immediately actionable.",
      "Minimize verbosity in voice communications.",
      "Keep voice channel interactions brief and purposeful."
    ];
    let anxietyExamples = [];
    if (channelType === ChannelType3.GROUP) {
      anxietyExamples = groupAnxietyExamples;
    } else if (channelType === ChannelType3.DM) {
      anxietyExamples = dmAnxietyExamples;
    } else if (channelType === ChannelType3.VOICE_GROUP || channelType === ChannelType3.VOICE_DM) {
      anxietyExamples = voiceAnxietyExamples;
    } else {
      anxietyExamples = directAnxietyExamples;
    }
    const randomAnxietyExamples = anxietyExamples.sort(() => Math.random() - 0.5).slice(0, 3);
    const anxietyText = randomAnxietyExamples.join(`
`);
    const anxietyHeader = "# You are roleplaying as a character, but as an AI model, you are too verbose and eager.";
    const anxiety = addHeader3(anxietyHeader, anxietyText);
    return {
      data: {
        anxiety: randomAnxietyExamples
      },
      values: {
        anxiety
      },
      text: anxiety
    };
  }
};
// src/providers/attachments.ts
import { addHeader as addHeader4 } from "@elizaos/core";
var attachmentsProvider = {
  name: "ATTACHMENTS",
  description: "List of attachments sent during the current conversation, including names, descriptions, and summaries",
  dynamic: true,
  get: async (runtime, message) => {
    const currentMessageAttachments = message.content.attachments || [];
    let allAttachments = [...currentMessageAttachments];
    const { roomId } = message;
    const conversationLength = runtime.getConversationLength();
    const recentMessagesData = await runtime.getMemories({
      roomId,
      count: conversationLength,
      unique: false,
      tableName: "messages"
    });
    if (recentMessagesData && Array.isArray(recentMessagesData)) {
      const lastMessageWithAttachment = recentMessagesData.find((msg) => msg.content.attachments && msg.content.attachments.length > 0);
      if (lastMessageWithAttachment) {
        const lastMessageTime = lastMessageWithAttachment?.createdAt ?? Date.now();
        const oneHourBeforeLastMessage = lastMessageTime - 60 * 60 * 1000;
        const currentAttachmentsMap = new Map(currentMessageAttachments.map((att) => [att.id, att]));
        const recentAttachments = recentMessagesData.reverse().flatMap((msg) => {
          const msgTime = msg.createdAt ?? Date.now();
          const isWithinTime = msgTime >= oneHourBeforeLastMessage;
          const attachments = msg.content.attachments || [];
          return attachments.map((attachment) => {
            if (currentAttachmentsMap.has(attachment.id)) {
              return null;
            }
            if (!isWithinTime) {
              return { ...attachment, text: "[Hidden]" };
            }
            return attachment;
          }).filter((att) => att !== null);
        });
        allAttachments = [...currentMessageAttachments, ...recentAttachments];
      }
    }
    const formattedAttachments = allAttachments.map((attachment) => `ID: ${attachment.id}
    Name: ${attachment.title}
    URL: ${attachment.url}
    Type: ${attachment.source}
    Description: ${attachment.description}
    Text: ${attachment.text}
    `).join(`
`);
    const text = formattedAttachments && formattedAttachments.length > 0 ? addHeader4("# Attachments", formattedAttachments) : "";
    const values = {
      attachments: text
    };
    const data = {
      attachments: allAttachments
    };
    return {
      values,
      data,
      text
    };
  }
};
// src/providers/capabilities.ts
var capabilitiesProvider = {
  name: "CAPABILITIES",
  get: async (runtime, _message) => {
    try {
      const services = runtime.getAllServices();
      if (!services || services.size === 0) {
        return {
          text: "No services are currently registered."
        };
      }
      const capabilities = [];
      for (const [serviceType, serviceArray] of services) {
        if (serviceArray && serviceArray.length > 0) {
          const service = serviceArray[0];
          if (service.capabilityDescription) {
            capabilities.push(`${serviceType} - ${service.capabilityDescription.replace("{{agentName}}", runtime.character.name)}`);
          }
        }
      }
      if (capabilities.length === 0) {
        return {
          text: "No capability descriptions found in the registered services."
        };
      }
      const formattedCapabilities = capabilities.join(`
`);
      return {
        data: {
          capabilities
        },
        text: `# ${runtime.character.name}'s Capabilities

${formattedCapabilities}`
      };
    } catch (error) {
      runtime.logger.error({
        src: "plugin:bootstrap:provider:capabilities",
        agentId: runtime.agentId,
        error: error instanceof Error ? error.message : String(error)
      }, "Error in capabilities provider");
      return {
        text: "Error retrieving capabilities from services."
      };
    }
  }
};
// src/providers/character.ts
import { addHeader as addHeader5, ChannelType as ChannelType4 } from "@elizaos/core";
var characterProvider = {
  name: "CHARACTER",
  description: "Character information",
  get: async (runtime, message, state) => {
    const character = runtime.character;
    const agentName = character.name;
    const bioText = Array.isArray(character.bio) ? character.bio.sort(() => 0.5 - Math.random()).slice(0, 10).join(" ") : character.bio || "";
    const bio = addHeader5(`# About ${character.name}`, bioText);
    const system = character.system ?? "";
    const topicString = character.topics && character.topics.length > 0 ? character.topics[Math.floor(Math.random() * character.topics.length)] : null;
    const topic = topicString || "";
    const topics = character.topics && character.topics.length > 0 ? `${character.name} is also interested in ${character.topics.filter((topic2) => topic2 !== topicString).sort(() => 0.5 - Math.random()).slice(0, 5).map((topic2, index, array) => {
      if (index === array.length - 2) {
        return `${topic2} and `;
      }
      if (index === array.length - 1) {
        return topic2;
      }
      return `${topic2}, `;
    }).join("")}` : "";
    const adjectiveString = character.adjectives && character.adjectives.length > 0 ? character.adjectives[Math.floor(Math.random() * character.adjectives.length)] : "";
    const adjective = adjectiveString || "";
    const formattedCharacterPostExamples = !character.postExamples ? "" : character.postExamples.sort(() => 0.5 - Math.random()).map((post) => {
      const messageString = `${post}`;
      return messageString;
    }).slice(0, 50).join(`
`);
    const characterPostExamples = formattedCharacterPostExamples && formattedCharacterPostExamples.replaceAll(`
`, "").length > 0 ? addHeader5(`# Example Posts for ${character.name}`, formattedCharacterPostExamples) : "";
    const formattedCharacterMessageExamples = !character.messageExamples ? "" : character.messageExamples.sort(() => 0.5 - Math.random()).slice(0, 5).map((example) => {
      const exampleNames = Array.from({ length: 5 }, () => Math.random().toString(36).substring(2, 8));
      return example.map((message2) => {
        let messageString = `${message2.name}: ${message2.content.text}${message2.content.action || message2.content.actions ? ` (actions: ${message2.content.action || message2.content.actions?.join(", ")})` : ""}`;
        exampleNames.forEach((name, index) => {
          const placeholder = `{{name${index + 1}}}`;
          messageString = messageString.replaceAll(placeholder, name);
        });
        return messageString;
      }).join(`
`);
    }).join(`

`);
    const characterMessageExamples = formattedCharacterMessageExamples && formattedCharacterMessageExamples.replaceAll(`
`, "").length > 0 ? addHeader5(`# Example Conversations for ${character.name}`, formattedCharacterMessageExamples) : "";
    const room = state.data.room ?? await runtime.getRoom(message.roomId);
    const isPostFormat = room?.type === ChannelType4.FEED || room?.type === ChannelType4.THREAD;
    const postDirections = character?.style?.all?.length && character?.style?.all?.length > 0 || character?.style?.post?.length && character?.style?.post?.length > 0 ? addHeader5(`# Post Directions for ${character.name}`, (() => {
      const all = character?.style?.all || [];
      const post = character?.style?.post || [];
      return [...all, ...post].join(`
`);
    })()) : "";
    const messageDirections = character?.style?.all?.length && character?.style?.all?.length > 0 || character?.style?.chat?.length && character?.style?.chat?.length > 0 ? addHeader5(`# Message Directions for ${character.name}`, (() => {
      const all = character?.style?.all || [];
      const chat = character?.style?.chat || [];
      return [...all, ...chat].join(`
`);
    })()) : "";
    const directions = isPostFormat ? postDirections : messageDirections;
    const examples = isPostFormat ? characterPostExamples : characterMessageExamples;
    const values = {
      agentName,
      bio,
      system,
      topic,
      topics,
      adjective,
      messageDirections,
      postDirections,
      directions,
      examples,
      characterPostExamples,
      characterMessageExamples
    };
    const data = {
      bio,
      adjective,
      topic,
      topics,
      character,
      directions,
      examples,
      system
    };
    const topicSentence = topicString ? `${character.name} is currently interested in ${topicString}` : "";
    const adjectiveSentence = adjectiveString ? `${character.name} is ${adjectiveString}` : "";
    const text = [bio, adjectiveSentence, topicSentence, topics, directions, examples, system].filter(Boolean).join(`

`);
    return {
      values,
      data,
      text
    };
  }
};
// src/providers/choice.ts
var choiceProvider = {
  name: "CHOICE",
  get: async (runtime, message, _state) => {
    try {
      const pendingTasks = await runtime.getTasks({
        roomId: message.roomId,
        tags: ["AWAITING_CHOICE"]
      });
      if (!pendingTasks || pendingTasks.length === 0) {
        return {
          data: {
            tasks: []
          },
          values: {
            tasks: "No pending choices for the moment."
          },
          text: "No pending choices for the moment."
        };
      }
      const tasksWithOptions = pendingTasks.filter((task) => task.metadata?.options);
      if (tasksWithOptions.length === 0) {
        return {
          data: {
            tasks: []
          },
          values: {
            tasks: "No pending choices for the moment."
          },
          text: "No pending choices for the moment."
        };
      }
      let output = `# Pending Tasks

`;
      output += `The following tasks are awaiting your selection:

`;
      tasksWithOptions.forEach((task, index) => {
        output += `${index + 1}. **${task.name}**
`;
        if (task.description) {
          output += `   ${task.description}
`;
        }
        if (task.metadata?.options) {
          output += `   Options:
`;
          const options = task.metadata.options;
          options.forEach((option) => {
            if (typeof option === "string") {
              const description = task.metadata?.options?.find((o) => o.name === option)?.description || "";
              output += `   - \`${option}\` ${description ? `- ${description}` : ""}
`;
            } else {
              output += `   - \`${option.name}\` ${option.description ? `- ${option.description}` : ""}
`;
            }
          });
        }
        output += `
`;
      });
      output += `To select an option, reply with the option name (e.g., 'post' or 'cancel').
`;
      return {
        data: {
          tasks: tasksWithOptions
        },
        values: {
          tasks: output
        },
        text: output
      };
    } catch (error) {
      runtime.logger.error({
        src: "plugin:bootstrap:provider:choice",
        agentId: runtime.agentId,
        error: error instanceof Error ? error.message : String(error)
      }, "Error in options provider");
      return {
        data: {
          tasks: []
        },
        values: {
          tasks: "There was an error retrieving pending tasks with options."
        },
        text: "There was an error retrieving pending tasks with options."
      };
    }
  }
};
// src/providers/entities.ts
import { addHeader as addHeader6, formatEntities, getEntityDetails as getEntityDetails2 } from "@elizaos/core";
var entitiesProvider = {
  name: "ENTITIES",
  description: "People in the current conversation",
  dynamic: true,
  get: async (runtime, message) => {
    const { roomId, entityId } = message;
    const entitiesData = await getEntityDetails2({ runtime, roomId });
    const formattedEntities = formatEntities({ entities: entitiesData ?? [] });
    const senderName = entitiesData?.find((entity) => entity.id === entityId)?.names[0];
    const entities = formattedEntities && formattedEntities.length > 0 ? addHeader6("# People in the Room", formattedEntities) : "";
    const data = {
      entitiesData,
      senderName
    };
    const values = {
      entities
    };
    return {
      data,
      values,
      text: entities
    };
  }
};
// src/providers/evaluators.ts
var import_unique_names_generator = __toESM(require_dist(), 1);
import { addHeader as addHeader7 } from "@elizaos/core";
function formatEvaluatorNames(evaluators) {
  return evaluators.map((evaluator) => `'${evaluator.name}'`).join(`,
`);
}
function formatEvaluatorExamples(evaluators) {
  return evaluators.map((evaluator) => {
    return evaluator.examples.map((example) => {
      const exampleNames = Array.from({ length: 5 }, () => import_unique_names_generator.uniqueNamesGenerator({ dictionaries: [import_unique_names_generator.names] }));
      let formattedPrompt = example.prompt;
      let formattedOutcome = example.outcome;
      exampleNames.forEach((name, index) => {
        const placeholder = `{{name${index + 1}}}`;
        formattedPrompt = formattedPrompt.replaceAll(placeholder, name);
        formattedOutcome = formattedOutcome.replaceAll(placeholder, name);
      });
      const formattedMessages = example.messages.map((message) => {
        let messageString = `${message.name}: ${message.content.text}`;
        exampleNames.forEach((name, index) => {
          const placeholder = `{{name${index + 1}}}`;
          messageString = messageString.replaceAll(placeholder, name);
        });
        return messageString + (message.content.action || message.content.actions ? ` (${message.content.action || message.content.actions?.join(", ")})` : "");
      }).join(`
`);
      return `Prompt:
${formattedPrompt}

Messages:
${formattedMessages}

Outcome:
${formattedOutcome}`;
    }).join(`

`);
  }).join(`

`);
}
function formatEvaluators(evaluators) {
  return evaluators.map((evaluator) => `'${evaluator.name}: ${evaluator.description}'`).join(`,
`);
}
var evaluatorsProvider = {
  name: "EVALUATORS",
  description: "Evaluators that can be used to evaluate the conversation after responding",
  private: true,
  get: async (runtime, message, state) => {
    const evaluatorPromises = runtime.evaluators.map(async (evaluator) => {
      const result = await evaluator.validate(runtime, message, state);
      if (result) {
        return evaluator;
      }
      return null;
    });
    const resolvedEvaluators = await Promise.all(evaluatorPromises);
    const evaluatorsData = resolvedEvaluators.filter(Boolean);
    const evaluators = evaluatorsData.length > 0 ? addHeader7("# Available Evaluators", formatEvaluators(evaluatorsData)) : "";
    const evaluatorNames = evaluatorsData.length > 0 ? formatEvaluatorNames(evaluatorsData) : "";
    const evaluatorExamples = evaluatorsData.length > 0 ? addHeader7("# Evaluator Examples", formatEvaluatorExamples(evaluatorsData)) : "";
    const values = {
      evaluatorsData,
      evaluators,
      evaluatorNames,
      evaluatorExamples
    };
    const text = [evaluators, evaluatorExamples].filter(Boolean).join(`

`);
    return {
      values,
      text
    };
  }
};
// src/providers/facts.ts
import { ModelType as ModelType13 } from "@elizaos/core";
function formatFacts2(facts) {
  return facts.reverse().map((fact) => fact.content.text).join(`
`);
}
var factsProvider = {
  name: "FACTS",
  description: "Key facts that the agent knows",
  dynamic: true,
  get: async (runtime, message, _state) => {
    try {
      const recentMessages = await runtime.getMemories({
        tableName: "messages",
        roomId: message.roomId,
        count: 10,
        unique: false
      });
      const last5Messages = recentMessages.slice(-5).map((message2) => message2.content.text).join(`
`);
      const embedding = await runtime.useModel(ModelType13.TEXT_EMBEDDING, {
        text: last5Messages
      });
      const [relevantFacts, recentFactsData] = await Promise.all([
        runtime.searchMemories({
          tableName: "facts",
          embedding,
          roomId: message.roomId,
          worldId: message.worldId,
          count: 6,
          query: message.content.text
        }),
        runtime.searchMemories({
          embedding,
          query: message.content.text,
          tableName: "facts",
          roomId: message.roomId,
          entityId: message.entityId,
          count: 6
        })
      ]);
      const allFacts = [...relevantFacts, ...recentFactsData].filter((fact, index, self) => index === self.findIndex((t) => t.id === fact.id));
      if (allFacts.length === 0) {
        return {
          values: {
            facts: ""
          },
          data: {
            facts: allFacts
          },
          text: "No facts available."
        };
      }
      const formattedFacts = formatFacts2(allFacts);
      const text = `Key facts that {{agentName}} knows:
{{formattedFacts}}`.replace("{{agentName}}", runtime.character.name).replace("{{formattedFacts}}", formattedFacts);
      return {
        values: {
          facts: formattedFacts
        },
        data: {
          facts: allFacts
        },
        text
      };
    } catch (error) {
      runtime.logger.error({
        src: "plugin:bootstrap:provider:facts",
        agentId: runtime.agentId,
        error: error instanceof Error ? error.message : String(error)
      }, "Error in factsProvider");
      return {
        values: {
          facts: ""
        },
        data: {
          facts: []
        },
        text: "Error retrieving facts."
      };
    }
  }
};
// src/providers/providers.ts
import { addHeader as addHeader8 } from "@elizaos/core";
var providersProvider = {
  name: "PROVIDERS",
  description: "List of all data providers the agent can use to get additional information",
  get: async (runtime, _message, _state) => {
    const allProviders = runtime.providers;
    const dynamicProviders = allProviders.filter((provider) => provider.dynamic === true);
    const dynamicDescriptions = dynamicProviders.map((provider) => {
      return `- **${provider.name}**: ${provider.description || "No description available"}`;
    });
    const allDescriptions = allProviders.map((provider) => {
      return `- **${provider.name}**: ${provider.description || "No description available"}`;
    });
    const headerText = `# Providers

These providers are available for the agent to select and use:`;
    const dynamicSection = dynamicDescriptions.length > 0 ? addHeader8(headerText, dynamicDescriptions.join(`
`)) : addHeader8(headerText, "No dynamic providers are currently available.");
    const providersWithDescriptions = addHeader8("# Available Providers", allDescriptions.join(`
`));
    const data = {
      dynamicProviders: dynamicProviders.map((provider) => ({
        name: provider.name,
        description: provider.description || ""
      })),
      allProviders: allProviders.map((provider) => ({
        name: provider.name,
        description: provider.description || "",
        dynamic: provider.dynamic === true
      }))
    };
    const values = {
      providersWithDescriptions
    };
    return {
      text: dynamicSection,
      data,
      values
    };
  }
};
// src/providers/recentMessages.ts
import {
  addHeader as addHeader9,
  ChannelType as ChannelType5,
  formatMessages,
  formatPosts,
  getEntityDetails as getEntityDetails3,
  logger as logger12
} from "@elizaos/core";
var getRecentInteractions = async (runtime, sourceEntityId, targetEntityId, excludeRoomId) => {
  const rooms = await runtime.getRoomsForParticipants([sourceEntityId, targetEntityId]);
  return runtime.getMemoriesByRoomIds({
    tableName: "messages",
    roomIds: rooms.filter((room) => room !== excludeRoomId),
    limit: 20
  });
};
var recentMessagesProvider = {
  name: "RECENT_MESSAGES",
  description: "Recent messages, interactions and other memories",
  position: 100,
  get: async (runtime, message) => {
    try {
      const { roomId } = message;
      const conversationLength = runtime.getConversationLength();
      const [entitiesData, room, recentMessagesData, recentInteractionsData] = await Promise.all([
        getEntityDetails3({ runtime, roomId }),
        runtime.getRoom(roomId),
        runtime.getMemories({
          tableName: "messages",
          roomId,
          count: conversationLength,
          unique: false
        }),
        message.entityId !== runtime.agentId ? getRecentInteractions(runtime, message.entityId, runtime.agentId, roomId) : Promise.resolve([])
      ]);
      const actionResultMessages = recentMessagesData.filter((msg) => msg.content?.type === "action_result" && msg.metadata?.type === "action_result");
      const dialogueMessages = recentMessagesData.filter((msg) => !(msg.content?.type === "action_result" && msg.metadata?.type === "action_result"));
      const isPostFormat = room?.type ? room.type === ChannelType5.FEED || room.type === ChannelType5.THREAD : false;
      const [formattedRecentMessages, formattedRecentPosts] = await Promise.all([
        formatMessages({
          messages: dialogueMessages,
          entities: entitiesData
        }),
        formatPosts({
          messages: dialogueMessages,
          entities: entitiesData,
          conversationHeader: false
        })
      ]);
      let actionResultsText = "";
      if (actionResultMessages.length > 0) {
        const groupedByRun = new Map;
        for (const mem of actionResultMessages) {
          const runId = String(mem.content?.runId || "unknown");
          if (!groupedByRun.has(runId)) {
            groupedByRun.set(runId, []);
          }
          const memories = groupedByRun.get(runId);
          if (memories) {
            memories.push(mem);
          }
        }
        const formattedActionResults = Array.from(groupedByRun.entries()).slice(-3).map(([runId, memories]) => {
          const sortedMemories = memories.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
          const thought = sortedMemories[0]?.content?.planThought || "";
          const runText = sortedMemories.map((mem) => {
            const actionName = mem.content?.actionName || "Unknown";
            const status = mem.content?.actionStatus || "unknown";
            const planStep = mem.content?.planStep || "";
            const text2 = mem.content?.text || "";
            const error = mem.content?.error || "";
            let memText = `  - ${actionName} (${status})`;
            if (planStep) {
              memText += ` [${planStep}]`;
            }
            if (error) {
              memText += `: Error - ${error}`;
            } else if (text2 && text2 !== `Executed action: ${actionName}`) {
              memText += `: ${text2}`;
            }
            return memText;
          }).join(`
`);
          return `**Action Run ${runId.slice(0, 8)}**${thought ? ` - "${thought}"` : ""}
${runText}`;
        }).join(`

`);
        actionResultsText = formattedActionResults ? addHeader9("# Recent Action Executions", formattedActionResults) : "";
      }
      const recentPosts = formattedRecentPosts && formattedRecentPosts.length > 0 ? addHeader9("# Posts in Thread", formattedRecentPosts) : "";
      const recentMessages = formattedRecentMessages && formattedRecentMessages.length > 0 ? addHeader9("# Conversation Messages", formattedRecentMessages) : "";
      if (!recentPosts && !recentMessages && dialogueMessages.length === 0 && !message.content.text) {
        return {
          data: {
            recentMessages: dialogueMessages,
            recentInteractions: [],
            actionResults: actionResultMessages
          },
          values: {
            recentPosts: "",
            recentMessages: "",
            recentMessageInteractions: "",
            recentPostInteractions: "",
            recentInteractions: "",
            recentActionResults: actionResultsText
          },
          text: "No recent messages available"
        };
      }
      let recentMessage = "No recent message available.";
      if (dialogueMessages.length > 0) {
        const mostRecentMessage = [...dialogueMessages].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0];
        const formattedSingleMessage = formatMessages({
          messages: [mostRecentMessage],
          entities: entitiesData
        });
        if (formattedSingleMessage) {
          recentMessage = formattedSingleMessage;
        }
      }
      const metaData = message.metadata;
      const senderName = entitiesData.find((entity) => entity.id === message.entityId)?.names[0] || metaData?.entityName || "Unknown User";
      const receivedMessageContent = message.content.text;
      const hasReceivedMessage = !!receivedMessageContent?.trim();
      const receivedMessageHeader = hasReceivedMessage ? addHeader9("# Received Message", `${senderName}: ${receivedMessageContent}`) : "";
      const focusHeader = hasReceivedMessage ? addHeader9("# Focus your response", `You are replying to the above message from **${senderName}**. Keep your answer relevant to that message. Do not repeat earlier replies unless the sender asks again.`) : "";
      const interactionEntityMap = new Map;
      if (recentInteractionsData.length > 0) {
        const uniqueEntityIds = [
          ...new Set(recentInteractionsData.map((message2) => message2.entityId).filter((id) => id !== runtime.agentId))
        ];
        const uniqueEntityIdSet = new Set(uniqueEntityIds);
        const entitiesDataIdSet = new Set;
        entitiesData.forEach((entity) => {
          if (uniqueEntityIdSet.has(entity.id)) {
            interactionEntityMap.set(entity.id, entity);
            entitiesDataIdSet.add(entity.id);
          }
        });
        const remainingEntityIds = uniqueEntityIds.filter((id) => !entitiesDataIdSet.has(id));
        if (remainingEntityIds.length > 0) {
          const entities = await Promise.all(remainingEntityIds.map((entityId) => runtime.getEntityById(entityId)));
          entities.forEach((entity, index) => {
            if (entity) {
              interactionEntityMap.set(remainingEntityIds[index], entity);
            }
          });
        }
      }
      const getRecentMessageInteractions = async (recentInteractionsData2) => {
        const formattedInteractions = recentInteractionsData2.map((message2) => {
          const isSelf = message2.entityId === runtime.agentId;
          let sender;
          if (isSelf) {
            sender = runtime.character.name;
          } else {
            sender = interactionEntityMap.get(message2.entityId)?.metadata?.userName || "unknown";
          }
          return `${sender}: ${message2.content.text}`;
        });
        return formattedInteractions.join(`
`);
      };
      const getRecentPostInteractions = async (recentInteractionsData2, entities) => {
        const combinedEntities = [...entities];
        const actorIds = new Set(entities.map((entity) => entity.id));
        for (const [id, entity] of interactionEntityMap.entries()) {
          if (!actorIds.has(id)) {
            combinedEntities.push(entity);
          }
        }
        const formattedInteractions = formatPosts({
          messages: recentInteractionsData2,
          entities: combinedEntities,
          conversationHeader: true
        });
        return formattedInteractions;
      };
      const [recentMessageInteractions, recentPostInteractions] = await Promise.all([
        getRecentMessageInteractions(recentInteractionsData),
        getRecentPostInteractions(recentInteractionsData, entitiesData)
      ]);
      const data = {
        recentMessages: dialogueMessages,
        recentInteractions: recentInteractionsData,
        actionResults: actionResultMessages
      };
      const values = {
        recentPosts,
        recentMessages,
        recentMessageInteractions,
        recentPostInteractions,
        recentInteractions: isPostFormat ? recentPostInteractions : recentMessageInteractions,
        recentActionResults: actionResultsText,
        recentMessage
      };
      const text = [
        isPostFormat ? recentPosts : recentMessages,
        actionResultsText,
        recentMessages || recentPosts || message.content.text ? receivedMessageHeader : "",
        recentMessages || recentPosts || message.content.text ? focusHeader : ""
      ].filter(Boolean).join(`

`);
      return {
        data,
        values,
        text
      };
    } catch (error) {
      logger12.error({
        src: "plugin:bootstrap:provider:recent_messages",
        agentId: runtime.agentId,
        error: error instanceof Error ? error.message : String(error)
      }, "Error in recentMessagesProvider");
      return {
        data: {
          recentMessages: [],
          recentInteractions: [],
          actionResults: []
        },
        values: {
          recentPosts: "",
          recentMessages: "",
          recentMessageInteractions: "",
          recentPostInteractions: "",
          recentInteractions: "",
          recentActionResults: ""
        },
        text: "Error retrieving recent messages."
      };
    }
  }
};
// src/providers/relationships.ts
async function formatRelationships(runtime, relationships) {
  const sortedRelationships = relationships.filter((rel) => rel.metadata?.interactions).sort((a, b) => (b.metadata?.interactions || 0) - (a.metadata?.interactions || 0)).slice(0, 30);
  if (sortedRelationships.length === 0) {
    return "";
  }
  const uniqueEntityIds = Array.from(new Set(sortedRelationships.map((rel) => rel.targetEntityId)));
  const entities = await Promise.all(uniqueEntityIds.map((id) => runtime.getEntityById(id)));
  const entityMap = new Map;
  entities.forEach((entity, index) => {
    if (entity) {
      entityMap.set(uniqueEntityIds[index], entity);
    }
  });
  const formatMetadata = (metadata) => {
    if (!metadata || typeof metadata !== "object") {
      return "{}";
    }
    return JSON.stringify(Object.entries(metadata).map(([key, value]) => `${key}: ${typeof value === "object" ? JSON.stringify(value) : value}`).join(`
`));
  };
  const formattedRelationships = sortedRelationships.map((rel) => {
    const targetEntityId = rel.targetEntityId;
    const entity = entityMap.get(targetEntityId);
    if (!entity) {
      return null;
    }
    const names2 = entity.names.join(" aka ");
    return `${names2}
${rel.tags ? rel.tags.join(", ") : ""}
${formatMetadata(entity.metadata)}
`;
  }).filter(Boolean);
  return formattedRelationships.join(`
`);
}
var relationshipsProvider = {
  name: "RELATIONSHIPS",
  description: "Relationships between {{agentName}} and other people, or between other people that {{agentName}} has observed interacting with",
  dynamic: true,
  get: async (runtime, message) => {
    const relationships = await runtime.getRelationships({
      entityId: message.entityId
    });
    if (!relationships || relationships.length === 0) {
      return {
        data: {
          relationships: []
        },
        values: {
          relationships: "No relationships found."
        },
        text: "No relationships found."
      };
    }
    const formattedRelationships = await formatRelationships(runtime, relationships);
    if (!formattedRelationships) {
      return {
        data: {
          relationships: []
        },
        values: {
          relationships: "No relationships found."
        },
        text: "No relationships found."
      };
    }
    return {
      data: {
        relationships: formattedRelationships
      },
      values: {
        relationships: formattedRelationships
      },
      text: `# ${runtime.character.name} has observed ${message.content.senderName || message.content.name} interacting with these people:
${formattedRelationships}`
    };
  }
};
// src/providers/roles.ts
import {
  ChannelType as ChannelType6,
  logger as logger13
} from "@elizaos/core";
var roleProvider = {
  name: "ROLES",
  description: "Roles in the server, default are OWNER, ADMIN and MEMBER (as well as NONE)",
  get: async (runtime, message, state) => {
    const room = state.data.room ?? await runtime.getRoom(message.roomId);
    if (!room) {
      throw new Error("No room found");
    }
    if (room.type !== ChannelType6.GROUP) {
      return {
        data: {
          roles: []
        },
        values: {
          roles: "No access to role information in DMs, the role provider is only available in group scenarios."
        },
        text: "No access to role information in DMs, the role provider is only available in group scenarios."
      };
    }
    const worldId = room.worldId;
    if (!worldId) {
      throw new Error("No world ID found for room");
    }
    logger13.info({ src: "plugin:bootstrap:provider:roles", agentId: runtime.agentId, worldId }, "Using world ID");
    const world = await runtime.getWorld(worldId);
    if (!world || !world.metadata?.ownership?.ownerId) {
      logger13.info({ src: "plugin:bootstrap:provider:roles", agentId: runtime.agentId, worldId }, "No ownership data found for world, initializing empty role hierarchy");
      return {
        data: {
          roles: []
        },
        values: {
          roles: "No role information available for this server."
        },
        text: "No role information available for this server."
      };
    }
    const roles = world.metadata && world.metadata.roles || {};
    if (!roles || typeof roles !== "object" || Object.keys(roles).length === 0) {
      logger13.info({ src: "plugin:bootstrap:provider:roles", agentId: runtime.agentId, worldId }, "No roles found for world");
      return {
        data: {
          roles: []
        },
        values: {
          roles: "No role information available for this server."
        },
        text: "No role information available for this server."
      };
    }
    logger13.info({
      src: "plugin:bootstrap:provider:roles",
      agentId: runtime.agentId,
      roleCount: Object.keys(roles).length
    }, "Found roles");
    const owners = [];
    const admins = [];
    const members = [];
    for (const entityId of Object.keys(roles)) {
      const userRole = roles[entityId];
      const user = await runtime.getEntityById(entityId);
      const name = user?.metadata?.name;
      const username = user?.metadata?.username;
      const names2 = user?.names;
      if (owners.some((owner) => owner.username === username) || admins.some((admin) => admin.username === username) || members.some((member) => member.username === username)) {
        continue;
      }
      if (!name || !username || !names2) {
        logger13.warn({ src: "plugin:bootstrap:provider:roles", agentId: runtime.agentId, entityId }, "User has no name or username, skipping");
        continue;
      }
      switch (userRole) {
        case "OWNER":
          owners.push({ name, username, names: names2 });
          break;
        case "ADMIN":
          admins.push({ name, username, names: names2 });
          break;
        default:
          members.push({ name, username, names: names2 });
          break;
      }
    }
    let response = `# Server Role Hierarchy

`;
    if (owners.length > 0) {
      response += `## Owners
`;
      owners.forEach((owner) => {
        response += `${owner.name} (${owner.names.join(", ")})
`;
      });
      response += `
`;
    }
    if (admins.length > 0) {
      response += `## Administrators
`;
      admins.forEach((admin) => {
        response += `${admin.name} (${admin.names.join(", ")}) (${admin.username})
`;
      });
      response += `
`;
    }
    if (members.length > 0) {
      response += `## Members
`;
      members.forEach((member) => {
        response += `${member.name} (${member.names.join(", ")}) (${member.username})
`;
      });
    }
    if (owners.length === 0 && admins.length === 0 && members.length === 0) {
      return {
        data: {
          roles: []
        },
        values: {
          roles: "No role information available for this server."
        },
        text: "No role information available for this server."
      };
    }
    return {
      data: {
        roles: response
      },
      values: {
        roles: response
      },
      text: response
    };
  }
};
// src/providers/settings.ts
import {
  ChannelType as ChannelType7,
  findWorldsForOwner as findWorldsForOwner2,
  getSalt as getSalt2,
  logger as logger14,
  unsaltWorldSettings as unsaltWorldSettings2
} from "@elizaos/core";
var formatSettingValue = (setting, isOnboarding) => {
  if (setting.value === null) {
    return "Not set";
  }
  if (setting.secret && !isOnboarding) {
    return "****************";
  }
  return String(setting.value);
};
function generateStatusMessage(runtime, worldSettings, isOnboarding, state) {
  try {
    if (!worldSettings || typeof worldSettings !== "object") {
      return "";
    }
    const formattedSettings = Object.entries(worldSettings).map(([key, setting]) => {
      if (typeof setting !== "object" || !setting.name) {
        return null;
      }
      const description = setting.description || "";
      const usageDescription = setting.usageDescription || "";
      if (setting.visibleIf && !setting.visibleIf(worldSettings)) {
        return null;
      }
      return {
        key,
        name: setting.name,
        value: formatSettingValue(setting, isOnboarding),
        description,
        usageDescription,
        required: setting.required,
        configured: setting.value !== null
      };
    }).filter(Boolean);
    const requiredUnconfigured = formattedSettings.filter((s) => s?.required && !s.configured).length;
    if (isOnboarding) {
      const settingsList = formattedSettings.map((s) => {
        const label = s?.required ? "(Required)" : "(Optional)";
        return `${s?.key}: ${s?.value} ${label}
(${s?.name}) ${s?.usageDescription}`;
      }).join(`

`);
      const validKeys = `Valid setting keys: ${Object.keys(worldSettings).join(", ")}`;
      const commonInstructions = `Instructions for ${runtime.character.name}:
      - Only update settings if the user is clearly responding to a setting you are currently asking about.
      - If the user's reply clearly maps to a setting and a valid value, you **must** call the UPDATE_SETTINGS action with the correct key and value. Do not just respond with a message saying it's updated — it must be an action.
      - Never hallucinate settings or respond with values not listed above.
      - Do not call UPDATE_SETTINGS just because the user has started onboarding or you think a setting needs to be configured. Only update when the user clearly provides a specific value for a setting you are currently asking about.
      - Answer setting-related questions using only the name, description, and value from the list.`;
      if (requiredUnconfigured > 0) {
        return `# PRIORITY TASK: Onboarding with ${state?.senderName}

        ${runtime.character.name} needs to help the user configure ${requiredUnconfigured} required settings:
        
        ${settingsList}
        
        ${validKeys}
        
        ${commonInstructions}
        
        - Prioritize configuring required settings before optional ones.`;
      }
      return `All required settings have been configured. Here's the current configuration:
      
        ${settingsList}
        
        ${validKeys}
        
        ${commonInstructions}`;
    }
    return `## Current Configuration

${requiredUnconfigured > 0 ? `IMPORTANT!: ${requiredUnconfigured} required settings still need configuration. ${runtime.character.name} should get onboarded with the OWNER as soon as possible.

` : `All required settings are configured.

`}${formattedSettings.map((s) => `### ${s?.name}
**Value:** ${s?.value}
**Description:** ${s?.description}`).join(`

`)}`;
  } catch (error) {
    logger14.error({
      src: "plugin:bootstrap:provider:settings",
      agentId: runtime.agentId,
      error: error instanceof Error ? error.message : String(error)
    }, "Error generating status message");
    return "Error generating configuration status.";
  }
}
var settingsProvider = {
  name: "SETTINGS",
  description: "Current settings for the server",
  get: async (runtime, message, state) => {
    try {
      const [room, userWorlds] = await Promise.all([
        runtime.getRoom(message.roomId),
        findWorldsForOwner2(runtime, message.entityId)
      ]).catch((error) => {
        logger14.error({
          src: "plugin:bootstrap:provider:settings",
          agentId: runtime.agentId,
          error: error instanceof Error ? error.message : String(error)
        }, "Error fetching initial data");
        throw new Error("Failed to retrieve room or user world information");
      });
      if (!room) {
        logger14.error({ src: "plugin:bootstrap:provider:settings", agentId: runtime.agentId }, "No room found for settings provider");
        return {
          data: {
            settings: []
          },
          values: {
            settings: "Error: Room not found"
          },
          text: "Error: Room not found"
        };
      }
      if (!room.worldId) {
        logger14.debug({ src: "plugin:bootstrap:provider:settings", agentId: runtime.agentId }, "No world found for settings provider -- settings provider will be skipped");
        return {
          data: {
            settings: []
          },
          values: {
            settings: "Room does not have a worldId -- settings provider will be skipped"
          },
          text: "Room does not have a worldId -- settings provider will be skipped"
        };
      }
      const type = room.type;
      const isOnboarding = type === ChannelType7.DM;
      let world = null;
      let serverId = undefined;
      let worldSettings = null;
      if (isOnboarding) {
        world = userWorlds?.find((world2) => world2.metadata?.settings !== undefined);
        if (!world && userWorlds && userWorlds.length > 0) {
          world = userWorlds[0];
          if (!world.metadata) {
            world.metadata = {};
          }
          world.metadata.settings = {};
          await runtime.updateWorld(world);
          logger14.info({
            src: "plugin:bootstrap:provider:settings",
            agentId: runtime.agentId,
            worldId: world.id
          }, "Initialized settings for user world");
        }
        if (!world) {
          logger14.error({ src: "plugin:bootstrap:provider:settings", agentId: runtime.agentId }, "No world found for user during onboarding");
          throw new Error("No server ownership found for onboarding");
        }
        serverId = world.messageServerId;
        if (world.metadata?.settings) {
          const salt = getSalt2();
          worldSettings = unsaltWorldSettings2(world.metadata.settings, salt);
        }
      } else {
        try {
          world = await runtime.getWorld(room.worldId);
          if (!world) {
            logger14.error({
              src: "plugin:bootstrap:provider:settings",
              agentId: runtime.agentId,
              worldId: room.worldId
            }, "No world found for room");
            throw new Error(`No world found for room ${room.worldId}`);
          }
          serverId = world.messageServerId;
          if (world.metadata?.settings) {
            const salt = getSalt2();
            worldSettings = unsaltWorldSettings2(world.metadata.settings, salt);
          } else if (!serverId) {
            logger14.debug({
              src: "plugin:bootstrap:provider:settings",
              agentId: runtime.agentId,
              worldId: room.worldId
            }, "No server ID or settings found for world");
          }
        } catch (error) {
          logger14.error({
            src: "plugin:bootstrap:provider:settings",
            agentId: runtime.agentId,
            error: error instanceof Error ? error.message : String(error)
          }, "Error processing world data");
          throw new Error("Failed to process world information");
        }
      }
      if (!serverId) {
        logger14.info({
          src: "plugin:bootstrap:provider:settings",
          agentId: runtime.agentId,
          entityId: message.entityId
        }, "No server ownership found for user after recovery attempt");
        return isOnboarding ? {
          data: {
            settings: []
          },
          values: {
            settings: "The user doesn't appear to have ownership of any servers. They should make sure they're using the correct account."
          },
          text: "The user doesn't appear to have ownership of any servers. They should make sure they're using the correct account."
        } : {
          data: {
            settings: []
          },
          values: {
            settings: "Error: No configuration access"
          },
          text: "Error: No configuration access"
        };
      }
      if (!worldSettings) {
        logger14.info({
          src: "plugin:bootstrap:provider:settings",
          agentId: runtime.agentId,
          messageServerId: serverId
        }, "No settings state found for server");
        return isOnboarding ? {
          data: {
            settings: []
          },
          values: {
            settings: "The user doesn't appear to have any settings configured for this server. They should configure some settings for this server."
          },
          text: "The user doesn't appear to have any settings configured for this server. They should configure some settings for this server."
        } : {
          data: {
            settings: []
          },
          values: {
            settings: "Configuration has not been completed yet."
          },
          text: "Configuration has not been completed yet."
        };
      }
      const output = generateStatusMessage(runtime, worldSettings, isOnboarding, state);
      return {
        data: {
          settings: worldSettings
        },
        values: {
          settings: output
        },
        text: output
      };
    } catch (error) {
      logger14.error({
        src: "plugin:bootstrap:provider:settings",
        agentId: runtime.agentId,
        error: error instanceof Error ? error.message : String(error)
      }, "Critical error in settings provider");
      return {
        data: {
          settings: []
        },
        values: {
          settings: "Error retrieving configuration information. Please try again later."
        },
        text: "Error retrieving configuration information. Please try again later."
      };
    }
  }
};
// src/providers/time.ts
var timeProvider = {
  name: "TIME",
  get: async (_runtime, _message) => {
    const currentDate = new Date;
    const options = {
      timeZone: "UTC",
      dateStyle: "full",
      timeStyle: "long"
    };
    const humanReadable = new Intl.DateTimeFormat("en-US", options).format(currentDate);
    return {
      data: {
        time: currentDate
      },
      values: {
        time: humanReadable
      },
      text: `The current date and time is ${humanReadable}. Please use this as your reference for any time-based operations or responses.`
    };
  }
};
// src/providers/world.ts
import {
  logger as logger15,
  addHeader as addHeader10,
  ChannelType as ChannelType8
} from "@elizaos/core";
var worldProvider = {
  name: "WORLD",
  description: "World and environment information",
  dynamic: true,
  get: async (runtime, message) => {
    try {
      logger15.debug({
        src: "plugin:bootstrap:provider:world",
        agentId: runtime.agentId,
        roomId: message.roomId
      }, "World provider activated");
      const currentRoom = await runtime.getRoom(message.roomId);
      if (!currentRoom) {
        logger15.warn({
          src: "plugin:bootstrap:provider:world",
          agentId: runtime.agentId,
          roomId: message.roomId
        }, "Room not found");
        return {
          data: {
            world: {
              info: "Unable to retrieve world information - room not found"
            }
          },
          text: "Unable to retrieve world information - room not found"
        };
      }
      logger15.debug({
        src: "plugin:bootstrap:provider:world",
        agentId: runtime.agentId,
        roomName: currentRoom.name,
        roomType: currentRoom.type
      }, "Found room");
      const worldId = currentRoom.worldId;
      if (!worldId) {
        logger15.warn({
          src: "plugin:bootstrap:provider:world",
          agentId: runtime.agentId,
          roomId: message.roomId
        }, "World ID not found");
        return {
          data: {
            world: {
              info: "Unable to retrieve world information - world ID not found"
            }
          },
          text: "Unable to retrieve world information - world ID not found"
        };
      }
      const world = await runtime.getWorld(worldId);
      if (!world) {
        logger15.warn({ src: "plugin:bootstrap:provider:world", agentId: runtime.agentId, worldId }, "World not found");
        return {
          data: {
            world: {
              info: "Unable to retrieve world information - world not found"
            }
          },
          text: "Unable to retrieve world information - world not found"
        };
      }
      logger15.debug({
        src: "plugin:bootstrap:provider:world",
        agentId: runtime.agentId,
        worldName: world.name,
        worldId: world.id
      }, "Found world");
      const worldRooms = await runtime.getRooms(worldId);
      logger15.debug({
        src: "plugin:bootstrap:provider:world",
        agentId: runtime.agentId,
        roomCount: worldRooms.length,
        worldName: world.name
      }, "Found rooms in world");
      const participants = await runtime.getParticipantsForRoom(message.roomId);
      logger15.debug({
        src: "plugin:bootstrap:provider:world",
        agentId: runtime.agentId,
        participantCount: participants.length,
        roomName: currentRoom.name
      }, "Found participants in room");
      const channelsByType = {
        text: [],
        voice: [],
        dm: [],
        feed: [],
        thread: [],
        other: []
      };
      for (const room of worldRooms) {
        if (!room?.id || !room.name) {
          logger15.warn({ src: "plugin:bootstrap:provider:world", agentId: runtime.agentId, roomId: room?.id }, "Room ID or name is missing");
          continue;
        }
        const roomInfo = {
          id: room.id,
          name: room.name,
          isCurrentChannel: room.id === message.roomId
        };
        if (room.type === ChannelType8.GROUP || room.type === ChannelType8.WORLD || room.type === ChannelType8.FORUM) {
          channelsByType.text.push(roomInfo);
        } else if (room.type === ChannelType8.VOICE_GROUP || room.type === ChannelType8.VOICE_DM) {
          channelsByType.voice.push(roomInfo);
        } else if (room.type === ChannelType8.DM || room.type === ChannelType8.SELF) {
          channelsByType.dm.push(roomInfo);
        } else if (room.type === ChannelType8.FEED) {
          channelsByType.feed.push(roomInfo);
        } else if (room.type === ChannelType8.THREAD) {
          channelsByType.thread.push(roomInfo);
        } else {
          channelsByType.other.push({
            ...roomInfo,
            type: room.type
          });
        }
      }
      const worldInfoText = [
        `# World: ${world.name}`,
        `Current Channel: ${currentRoom.name} (${currentRoom.type})`,
        `Total Channels: ${worldRooms.length}`,
        `Participants in current channel: ${participants.length}`,
        "",
        `Text channels: ${channelsByType.text.length}`,
        `Voice channels: ${channelsByType.voice.length}`,
        `DM channels: ${channelsByType.dm.length}`,
        `Feed channels: ${channelsByType.feed.length}`,
        `Thread channels: ${channelsByType.thread.length}`,
        `Other channels: ${channelsByType.other.length}`
      ].join(`
`);
      const data = {
        world: {
          id: world.id,
          name: world.name,
          messageServerId: world.messageServerId,
          metadata: world.metadata || {},
          currentRoom: {
            id: currentRoom.id,
            name: currentRoom.name,
            type: currentRoom.type,
            channelId: currentRoom.channelId,
            participantCount: participants.length
          },
          channels: channelsByType,
          channelStats: {
            total: worldRooms.length,
            text: channelsByType.text.length,
            voice: channelsByType.voice.length,
            dm: channelsByType.dm.length,
            feed: channelsByType.feed.length,
            thread: channelsByType.thread.length,
            other: channelsByType.other.length
          }
        }
      };
      const values = {
        worldName: world.name,
        currentChannelName: currentRoom.name,
        worldInfo: worldInfoText
      };
      const formattedText = addHeader10("# World Information", worldInfoText);
      logger15.debug({ src: "plugin:bootstrap:provider:world", agentId: runtime.agentId }, "World provider completed successfully");
      return {
        data,
        values,
        text: formattedText
      };
    } catch (error) {
      logger15.error({
        src: "plugin:bootstrap:provider:world",
        agentId: runtime.agentId,
        error: error instanceof Error ? error.message : String(error)
      }, "Error in world provider");
      return {
        data: {
          world: {
            info: "Error retrieving world information",
            error: error instanceof Error ? error.message : "Unknown error"
          }
        },
        text: "Error retrieving world information"
      };
    }
  }
};
// src/services/task.ts
import {
  Service,
  ServiceType
} from "@elizaos/core";

class TaskService extends Service {
  timer = null;
  TICK_INTERVAL = 1000;
  static serviceType = ServiceType.TASK;
  capabilityDescription = "The agent is able to schedule and execute tasks";
  static async start(runtime) {
    const service = new TaskService(runtime);
    await service.startTimer();
    return service;
  }
  async createTestTasks() {
    this.runtime.registerTaskWorker({
      name: "REPEATING_TEST_TASK",
      validate: async (_runtime, _message, _state) => {
        this.runtime.logger.debug({ src: "plugin:bootstrap:service:task", agentId: this.runtime.agentId }, "Validating repeating test task");
        return true;
      },
      execute: async (_runtime, _options) => {
        this.runtime.logger.debug({ src: "plugin:bootstrap:service:task", agentId: this.runtime.agentId }, "Executing repeating test task");
      }
    });
    this.runtime.registerTaskWorker({
      name: "ONETIME_TEST_TASK",
      validate: async (_runtime, _message, _state) => {
        this.runtime.logger.debug({ src: "plugin:bootstrap:service:task", agentId: this.runtime.agentId }, "Validating one-time test task");
        return true;
      },
      execute: async (_runtime, _options) => {
        this.runtime.logger.debug({ src: "plugin:bootstrap:service:task", agentId: this.runtime.agentId }, "Executing one-time test task");
      }
    });
    const tasks = await this.runtime.getTasksByName("REPEATING_TEST_TASK");
    if (tasks.length === 0) {
      await this.runtime.createTask({
        name: "REPEATING_TEST_TASK",
        description: "A test task that repeats every minute",
        metadata: {
          updatedAt: Date.now(),
          updateInterval: 1000 * 60
        },
        tags: ["queue", "repeat", "test"]
      });
    }
    await this.runtime.createTask({
      name: "ONETIME_TEST_TASK",
      description: "A test task that runs once",
      metadata: {
        updatedAt: Date.now()
      },
      tags: ["queue", "test"]
    });
  }
  startTimer() {
    if (this.timer) {
      clearInterval(this.timer);
    }
    this.timer = setInterval(async () => {
      try {
        await this.checkTasks();
      } catch (error) {
        this.runtime.logger.error({
          src: "plugin:bootstrap:service:task",
          agentId: this.runtime.agentId,
          error: error instanceof Error ? error.message : String(error)
        }, "Error in task timer");
      }
    }, this.TICK_INTERVAL);
  }
  async validateTasks(tasks) {
    const validatedTasks = [];
    for (const task of tasks) {
      if (!task.id) {
        continue;
      }
      const worker = this.runtime.getTaskWorker(task.name);
      if (!worker) {
        continue;
      }
      if (worker.validate) {
        try {
          const isValid = await worker.validate(this.runtime, {}, {});
          if (!isValid) {
            continue;
          }
        } catch (error) {
          this.runtime.logger.error({
            src: "plugin:bootstrap:service:task",
            agentId: this.runtime.agentId,
            taskName: task.name,
            error: error instanceof Error ? error.message : String(error)
          }, "Error validating task");
          continue;
        }
      }
      validatedTasks.push(task);
    }
    return validatedTasks;
  }
  async checkTasks() {
    try {
      const allTasks = await this.runtime.getTasks({
        tags: ["queue"]
      });
      if (!allTasks) {
        return;
      }
      const tasks = await this.validateTasks(allTasks);
      const now = Date.now();
      for (const task of tasks) {
        let taskStartTime;
        if (!task.tags?.includes("repeat")) {
          await this.executeTask(task);
          continue;
        }
        if (typeof task.updatedAt === "number") {
          taskStartTime = task.updatedAt;
        } else if (task.metadata?.updatedAt && typeof task.metadata.updatedAt === "number") {
          taskStartTime = task.metadata.updatedAt;
        } else if (task.updatedAt) {
          taskStartTime = new Date(task.updatedAt).getTime();
        } else {
          taskStartTime = 0;
        }
        const updateIntervalMs = task.metadata?.updateInterval ?? 0;
        if (!task.tags?.includes("repeat")) {
          await this.executeTask(task);
          continue;
        }
        if (task.metadata?.updatedAt === task.metadata?.createdAt) {
          if (task.tags?.includes("immediate")) {
            this.runtime.logger.debug({
              src: "plugin:bootstrap:service:task",
              agentId: this.runtime.agentId,
              taskName: task.name
            }, "Immediately running task");
            await this.executeTask(task);
            continue;
          }
        }
        if (now - taskStartTime >= updateIntervalMs) {
          this.runtime.logger.debug({
            src: "plugin:bootstrap:service:task",
            agentId: this.runtime.agentId,
            taskName: task.name,
            intervalMs: updateIntervalMs
          }, "Executing task - interval elapsed");
          await this.executeTask(task);
        }
      }
    } catch (error) {
      this.runtime.logger.error({
        src: "plugin:bootstrap:service:task",
        agentId: this.runtime.agentId,
        error: error instanceof Error ? error.message : String(error)
      }, "Error checking tasks");
    }
  }
  async executeTask(task) {
    try {
      if (!task || !task.id) {
        this.runtime.logger.debug({ src: "plugin:bootstrap:service:task", agentId: this.runtime.agentId }, "Task not found");
        return;
      }
      const worker = this.runtime.getTaskWorker(task.name);
      if (!worker) {
        this.runtime.logger.debug({
          src: "plugin:bootstrap:service:task",
          agentId: this.runtime.agentId,
          taskName: task.name
        }, "No worker found for task type");
        return;
      }
      if (task.tags?.includes("repeat")) {
        await this.runtime.updateTask(task.id, {
          metadata: {
            ...task.metadata,
            updatedAt: Date.now()
          }
        });
        this.runtime.logger.debug({
          src: "plugin:bootstrap:service:task",
          agentId: this.runtime.agentId,
          taskName: task.name,
          taskId: task.id
        }, "Updated repeating task with new timestamp");
      }
      this.runtime.logger.debug({
        src: "plugin:bootstrap:service:task",
        agentId: this.runtime.agentId,
        taskName: task.name,
        taskId: task.id
      }, "Executing task");
      await worker.execute(this.runtime, task.metadata || {}, task);
      if (!task.tags?.includes("repeat")) {
        await this.runtime.deleteTask(task.id);
        this.runtime.logger.debug({
          src: "plugin:bootstrap:service:task",
          agentId: this.runtime.agentId,
          taskName: task.name,
          taskId: task.id
        }, "Deleted non-repeating task after execution");
      }
    } catch (error) {
      this.runtime.logger.error({
        src: "plugin:bootstrap:service:task",
        agentId: this.runtime.agentId,
        taskId: task.id,
        error: error instanceof Error ? error.message : String(error)
      }, "Error executing task");
    }
  }
  static async stop(runtime) {
    const service = runtime.getService(ServiceType.TASK);
    if (service) {
      await service.stop();
    }
  }
  async stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

// src/services/embedding.ts
import {
  Service as Service2,
  EventType,
  ModelType as ModelType14
} from "@elizaos/core";

class EmbeddingGenerationService extends Service2 {
  static serviceType = "embedding-generation";
  capabilityDescription = "Handles asynchronous embedding generation for memories";
  queue = [];
  isProcessing = false;
  processingInterval = null;
  maxQueueSize = 1000;
  batchSize = 10;
  processingIntervalMs = 100;
  isDisabled = false;
  static async start(runtime) {
    runtime.logger.info({ src: "plugin:bootstrap:service:embedding", agentId: runtime.agentId }, "Starting embedding generation service");
    const embeddingModel = runtime.getModel(ModelType14.TEXT_EMBEDDING);
    if (!embeddingModel) {
      runtime.logger.warn({ src: "plugin:bootstrap:service:embedding", agentId: runtime.agentId }, "No TEXT_EMBEDDING model registered - service will not be initialized");
      const noOpService = new EmbeddingGenerationService(runtime);
      noOpService.isDisabled = true;
      return noOpService;
    }
    const service = new EmbeddingGenerationService(runtime);
    await service.initialize();
    return service;
  }
  async initialize() {
    if (this.isDisabled) {
      this.runtime.logger.debug({ src: "plugin:bootstrap:service:embedding", agentId: this.runtime.agentId }, "Service is disabled, skipping initialization");
      return;
    }
    this.runtime.logger.info({ src: "plugin:bootstrap:service:embedding", agentId: this.runtime.agentId }, "Initializing embedding generation service");
    this.runtime.registerEvent(EventType.EMBEDDING_GENERATION_REQUESTED, this.handleEmbeddingRequest.bind(this));
    this.startProcessing();
  }
  async handleEmbeddingRequest(payload) {
    if (this.isDisabled) {
      this.runtime.logger.debug({ src: "plugin:bootstrap:service:embedding", agentId: this.runtime.agentId }, "Service is disabled, skipping embedding request");
      return;
    }
    const { memory, priority = "normal", retryCount = 0, maxRetries = 3, runId } = payload;
    if (memory.embedding) {
      this.runtime.logger.debug({
        src: "plugin:bootstrap:service:embedding",
        agentId: this.runtime.agentId,
        memoryId: memory.id
      }, "Memory already has embeddings, skipping");
      return;
    }
    if (this.queue.length >= this.maxQueueSize) {
      this.runtime.logger.warn({
        src: "plugin:bootstrap:service:embedding",
        agentId: this.runtime.agentId,
        queueSize: this.queue.length,
        maxSize: this.maxQueueSize
      }, "Queue is full, making room");
      this.makeRoomInQueue();
    }
    const queueItem = {
      memory,
      priority,
      retryCount,
      maxRetries,
      addedAt: Date.now(),
      runId
    };
    this.insertItemByPriority(queueItem);
    this.runtime.logger.debug({
      src: "plugin:bootstrap:service:embedding",
      agentId: this.runtime.agentId,
      queueSize: this.queue.length
    }, "Added memory to queue");
  }
  makeRoomInQueue() {
    const tenPercent = Math.floor(this.maxQueueSize * 0.1);
    const itemsToRemove = Math.min(10, Math.max(1, tenPercent));
    const itemsWithIndex = this.queue.map((item, index) => ({ item, originalIndex: index }));
    itemsWithIndex.sort((a, b) => {
      const priorityOrder = { low: 0, normal: 1, high: 2 };
      const priorityDiff = priorityOrder[a.item.priority] - priorityOrder[b.item.priority];
      if (priorityDiff !== 0) {
        return priorityDiff;
      }
      return a.item.addedAt - b.item.addedAt;
    });
    const indicesToRemove = new Set(itemsWithIndex.slice(0, Math.min(itemsToRemove, itemsWithIndex.length)).map(({ originalIndex }) => originalIndex));
    const newQueue = this.queue.filter((_, index) => !indicesToRemove.has(index));
    const removedCount = this.queue.length - newQueue.length;
    this.queue = newQueue;
    this.runtime.logger.info({
      src: "plugin:bootstrap:service:embedding",
      agentId: this.runtime.agentId,
      removedCount,
      newSize: this.queue.length
    }, "Removed items from queue");
  }
  insertItemByPriority(queueItem) {
    if (queueItem.priority === "high") {
      let insertIndex = 0;
      for (let i = 0;i < this.queue.length; i++) {
        if (this.queue[i].priority !== "high") {
          break;
        }
        insertIndex = i + 1;
      }
      this.queue.splice(insertIndex, 0, queueItem);
    } else if (queueItem.priority === "low") {
      this.queue.push(queueItem);
    } else {
      let insertIndex = 0;
      for (let i = 0;i < this.queue.length; i++) {
        if (this.queue[i].priority !== "high") {
          insertIndex = i;
          break;
        }
        insertIndex = i + 1;
      }
      for (let i = insertIndex;i < this.queue.length; i++) {
        if (this.queue[i].priority === "low") {
          insertIndex = i;
          break;
        }
        insertIndex = i + 1;
      }
      this.queue.splice(insertIndex, 0, queueItem);
    }
  }
  startProcessing() {
    if (this.isDisabled) {
      this.runtime.logger.debug({ src: "plugin:bootstrap:service:embedding", agentId: this.runtime.agentId }, "Service is disabled, not starting processing loop");
      return;
    }
    if (this.processingInterval) {
      return;
    }
    this.processingInterval = setInterval(async () => {
      if (!this.isProcessing && this.queue.length > 0) {
        await this.processQueue();
      }
    }, this.processingIntervalMs);
    this.runtime.logger.info({ src: "plugin:bootstrap:service:embedding", agentId: this.runtime.agentId }, "Started processing loop");
  }
  async processQueue() {
    if (this.isProcessing || this.queue.length === 0) {
      return;
    }
    this.isProcessing = true;
    try {
      const batch = this.queue.splice(0, Math.min(this.batchSize, this.queue.length));
      this.runtime.logger.debug({
        src: "plugin:bootstrap:service:embedding",
        agentId: this.runtime.agentId,
        batchSize: batch.length,
        remaining: this.queue.length
      }, "Processing batch");
      const promises = batch.map(async (item) => {
        try {
          await this.generateEmbedding(item);
        } catch (error) {
          this.runtime.logger.error({
            src: "plugin:bootstrap:service:embedding",
            agentId: this.runtime.agentId,
            memoryId: item.memory.id,
            error: error instanceof Error ? error.message : String(error)
          }, "Error processing item");
          if (item.retryCount < item.maxRetries) {
            item.retryCount++;
            this.insertItemByPriority(item);
            this.runtime.logger.debug({
              src: "plugin:bootstrap:service:embedding",
              agentId: this.runtime.agentId,
              retryCount: item.retryCount,
              maxRetries: item.maxRetries
            }, "Re-queued item for retry");
          } else {
            await this.runtime.log({
              entityId: this.runtime.agentId,
              roomId: item.memory.roomId || this.runtime.agentId,
              type: "embedding_event",
              body: {
                runId: item.runId,
                memoryId: item.memory.id,
                status: "failed",
                error: error instanceof Error ? error.message : String(error),
                source: "embeddingService"
              }
            });
            await this.runtime.emitEvent(EventType.EMBEDDING_GENERATION_FAILED, {
              runtime: this.runtime,
              memory: item.memory,
              error: error instanceof Error ? error.message : String(error),
              source: "embeddingService"
            });
          }
        }
      });
      await Promise.all(promises);
    } finally {
      this.isProcessing = false;
    }
  }
  async generateEmbedding(item) {
    const { memory } = item;
    if (!memory.content?.text) {
      this.runtime.logger.warn({
        src: "plugin:bootstrap:service:embedding",
        agentId: this.runtime.agentId,
        memoryId: memory.id
      }, "Memory has no text content");
      return;
    }
    try {
      const startTime = Date.now();
      const embedding = await this.runtime.useModel(ModelType14.TEXT_EMBEDDING, {
        text: memory.content.text
      });
      const duration = Date.now() - startTime;
      this.runtime.logger.debug({
        src: "plugin:bootstrap:service:embedding",
        agentId: this.runtime.agentId,
        memoryId: memory.id,
        durationMs: duration
      }, "Generated embedding");
      if (memory.id) {
        await this.runtime.updateMemory({
          id: memory.id,
          embedding
        });
        await this.runtime.log({
          entityId: this.runtime.agentId,
          roomId: memory.roomId || this.runtime.agentId,
          type: "embedding_event",
          body: {
            runId: item.runId,
            memoryId: memory.id,
            status: "completed",
            duration,
            source: "embeddingService"
          }
        });
        await this.runtime.emitEvent(EventType.EMBEDDING_GENERATION_COMPLETED, {
          runtime: this.runtime,
          memory: { ...memory, embedding },
          source: "embeddingService"
        });
      }
    } catch (error) {
      this.runtime.logger.error({
        src: "plugin:bootstrap:service:embedding",
        agentId: this.runtime.agentId,
        memoryId: memory.id,
        error: error instanceof Error ? error.message : String(error)
      }, "Failed to generate embedding");
      throw error;
    }
  }
  async stop() {
    this.runtime.logger.info({ src: "plugin:bootstrap:service:embedding", agentId: this.runtime.agentId }, "Stopping embedding generation service");
    if (this.isDisabled) {
      this.runtime.logger.debug({ src: "plugin:bootstrap:service:embedding", agentId: this.runtime.agentId }, "Service is disabled, nothing to stop");
      return;
    }
    if (this.processingInterval) {
      clearInterval(this.processingInterval);
      this.processingInterval = null;
    }
    const highPriorityItems = this.queue.filter((item) => item.priority === "high");
    if (highPriorityItems.length > 0) {
      this.runtime.logger.info({
        src: "plugin:bootstrap:service:embedding",
        agentId: this.runtime.agentId,
        count: highPriorityItems.length
      }, "Processing high priority items before shutdown");
      for (const item of highPriorityItems) {
        try {
          await this.generateEmbedding(item);
        } catch (error) {
          this.runtime.logger.error({
            src: "plugin:bootstrap:service:embedding",
            agentId: this.runtime.agentId,
            error: error instanceof Error ? error.message : String(error)
          }, "Error during shutdown processing");
        }
      }
    }
    this.runtime.logger.info({
      src: "plugin:bootstrap:service:embedding",
      agentId: this.runtime.agentId,
      remainingItems: this.queue.length
    }, "Stopped");
  }
  getQueueSize() {
    return this.queue.length;
  }
  getQueueStats() {
    const stats = {
      high: 0,
      normal: 0,
      low: 0,
      total: this.queue.length
    };
    for (const item of this.queue) {
      stats[item.priority]++;
    }
    return stats;
  }
  clearQueue() {
    const size = this.queue.length;
    this.queue = [];
    this.runtime.logger.info({
      src: "plugin:bootstrap:service:embedding",
      agentId: this.runtime.agentId,
      clearedCount: size
    }, "Cleared queue");
  }
}

// src/index.ts
async function fetchMediaData(attachments) {
  return Promise.all(attachments.map(async (attachment) => {
    if (/^(http|https):\/\//.test(attachment.url)) {
      const response = await fetch(attachment.url);
      if (!response.ok) {
        throw new Error(`Failed to fetch file: ${attachment.url}`);
      }
      const mediaBuffer = Buffer.from(await response.arrayBuffer());
      const mediaType = attachment.contentType || "image/png";
      return { data: mediaBuffer, mediaType };
    }
    throw new Error(`File not found: ${attachment.url}. Make sure the path is correct.`);
  }));
}
async function processAttachments(attachments, runtime) {
  if (!attachments || attachments.length === 0) {
    return [];
  }
  runtime.logger.debug({ src: "plugin:bootstrap", agentId: runtime.agentId, count: attachments.length }, "Processing attachments");
  const processedAttachments = [];
  for (const attachment of attachments) {
    try {
      const processedAttachment = { ...attachment };
      const isRemote = /^(http|https):\/\//.test(attachment.url);
      const url = isRemote ? attachment.url : getLocalServerUrl(attachment.url);
      if (attachment.contentType === ContentType2.IMAGE && !attachment.description) {
        runtime.logger.debug({ src: "plugin:bootstrap", agentId: runtime.agentId, url: attachment.url }, "Generating description for image");
        let imageUrl = url;
        if (!isRemote) {
          const res = await fetch(url);
          if (!res.ok) {
            throw new Error(`Failed to fetch image: ${res.statusText}`);
          }
          const arrayBuffer = await res.arrayBuffer();
          const buffer = Buffer.from(arrayBuffer);
          const contentType = res.headers.get("content-type") || "application/octet-stream";
          imageUrl = `data:${contentType};base64,${buffer.toString("base64")}`;
        }
        try {
          const response = await runtime.useModel(ModelType15.IMAGE_DESCRIPTION, {
            prompt: imageDescriptionTemplate,
            imageUrl
          });
          if (typeof response === "string") {
            const parsedXml = parseKeyValueXml9(response);
            if (parsedXml && (parsedXml.description || parsedXml.text)) {
              processedAttachment.description = parsedXml.description ?? "";
              processedAttachment.title = parsedXml.title ?? "Image";
              processedAttachment.text = parsedXml.text ?? parsedXml.description ?? "";
              runtime.logger.debug({
                src: "plugin:bootstrap",
                agentId: runtime.agentId,
                descriptionPreview: processedAttachment.description?.substring(0, 100)
              }, "Generated description");
            } else {
              const responseStr = response;
              const titleMatch = responseStr.match(/<title>([^<]+)<\/title>/);
              const descMatch = responseStr.match(/<description>([^<]+)<\/description>/);
              const textMatch = responseStr.match(/<text>([^<]+)<\/text>/);
              if (titleMatch || descMatch || textMatch) {
                processedAttachment.title = titleMatch?.[1] || "Image";
                processedAttachment.description = descMatch?.[1] || "";
                processedAttachment.text = textMatch?.[1] || descMatch?.[1] || "";
                runtime.logger.debug({
                  src: "plugin:bootstrap",
                  agentId: runtime.agentId,
                  descriptionPreview: processedAttachment.description?.substring(0, 100)
                }, "Used fallback XML parsing");
              } else {
                runtime.logger.warn({ src: "plugin:bootstrap", agentId: runtime.agentId }, "Failed to parse XML response for image description");
              }
            }
          } else if (response && typeof response === "object" && "description" in response) {
            processedAttachment.description = response.description;
            processedAttachment.title = response.title || "Image";
            processedAttachment.text = response.description;
            runtime.logger.debug({
              src: "plugin:bootstrap",
              agentId: runtime.agentId,
              descriptionPreview: processedAttachment.description?.substring(0, 100)
            }, "Generated description");
          } else {
            runtime.logger.warn({ src: "plugin:bootstrap", agentId: runtime.agentId }, "Unexpected response format for image description");
          }
        } catch (error) {
          runtime.logger.error({
            src: "plugin:bootstrap",
            agentId: runtime.agentId,
            error: error instanceof Error ? error.message : String(error)
          }, "Error generating image description");
        }
      } else if (attachment.contentType === ContentType2.DOCUMENT && !attachment.text) {
        const res = await fetch(url);
        if (!res.ok) {
          throw new Error(`Failed to fetch document: ${res.statusText}`);
        }
        const contentType = res.headers.get("content-type") || "";
        const isPlainText = contentType.startsWith("text/plain");
        if (isPlainText) {
          runtime.logger.debug({ src: "plugin:bootstrap", agentId: runtime.agentId, url: attachment.url }, "Processing plain text document");
          const textContent = await res.text();
          processedAttachment.text = textContent;
          processedAttachment.title = processedAttachment.title || "Text File";
          runtime.logger.debug({
            src: "plugin:bootstrap",
            agentId: runtime.agentId,
            textPreview: processedAttachment.text?.substring(0, 100)
          }, "Extracted text content");
        } else {
          runtime.logger.warn({ src: "plugin:bootstrap", agentId: runtime.agentId, contentType }, "Skipping non-plain-text document");
        }
      }
      processedAttachments.push(processedAttachment);
    } catch (error) {
      runtime.logger.error({
        src: "plugin:bootstrap",
        agentId: runtime.agentId,
        attachmentUrl: attachment.url,
        error: error instanceof Error ? error.message : String(error)
      }, "Failed to process attachment");
      processedAttachments.push(attachment);
    }
  }
  return processedAttachments;
}
function shouldRespond(runtime, message, room, mentionContext) {
  if (!room) {
    return { shouldRespond: false, skipEvaluation: true, reason: "no room context" };
  }
  function normalizeEnvList(value) {
    if (!value || typeof value !== "string") {
      return [];
    }
    const cleaned = value.trim().replace(/^[\[]|[\]]$/g, "");
    return cleaned.split(",").map((v) => v.trim()).filter(Boolean);
  }
  const alwaysRespondChannels = [
    ChannelType9.DM,
    ChannelType9.VOICE_DM,
    ChannelType9.SELF,
    ChannelType9.API
  ];
  const alwaysRespondSources = ["client_chat"];
  const customChannels = normalizeEnvList(runtime.getSetting("ALWAYS_RESPOND_CHANNELS") || runtime.getSetting("SHOULD_RESPOND_BYPASS_TYPES"));
  const customSources = normalizeEnvList(runtime.getSetting("ALWAYS_RESPOND_SOURCES") || runtime.getSetting("SHOULD_RESPOND_BYPASS_SOURCES"));
  const respondChannels = new Set([...alwaysRespondChannels.map((t) => t.toString()), ...customChannels].map((s) => s.trim().toLowerCase()));
  const respondSources = [...alwaysRespondSources, ...customSources].map((s) => s.trim().toLowerCase());
  const roomType = room.type?.toString().toLowerCase();
  const sourceStr = message.content.source?.toLowerCase() || "";
  if (respondChannels.has(roomType)) {
    return { shouldRespond: true, skipEvaluation: true, reason: `private channel: ${roomType}` };
  }
  if (respondSources.some((pattern) => sourceStr.includes(pattern))) {
    return {
      shouldRespond: true,
      skipEvaluation: true,
      reason: `whitelisted source: ${sourceStr}`
    };
  }
  const hasPlatformMention = !!(mentionContext?.isMention || mentionContext?.isReply);
  if (hasPlatformMention) {
    const mentionType = mentionContext?.isMention ? "mention" : "reply";
    return { shouldRespond: true, skipEvaluation: true, reason: `platform ${mentionType}` };
  }
  return { shouldRespond: false, skipEvaluation: false, reason: "needs LLM evaluation" };
}
var reactionReceivedHandler = async ({
  runtime,
  message
}) => {
  try {
    await runtime.createMemory(message, "messages");
  } catch (error) {
    const isDuplicateKeyError = error instanceof Error && "code" in error && error.code === "23505";
    if (isDuplicateKeyError) {
      runtime.logger.warn({ src: "plugin:bootstrap", agentId: runtime.agentId }, "Duplicate reaction memory, skipping");
      return;
    }
    runtime.logger.error({
      src: "plugin:bootstrap",
      agentId: runtime.agentId,
      error: error instanceof Error ? error.message : String(error)
    }, "Error in reaction handler");
  }
};
var postGeneratedHandler = async ({
  runtime,
  callback,
  worldId,
  userId,
  roomId,
  source
}) => {
  runtime.logger.info({ src: "plugin:bootstrap", agentId: runtime.agentId }, "Generating new post");
  await runtime.ensureWorldExists({
    id: worldId,
    name: `${runtime.character.name}'s Feed`,
    agentId: runtime.agentId,
    messageServerId: userId
  });
  await runtime.ensureRoomExists({
    id: roomId,
    name: `${runtime.character.name}'s Feed`,
    source,
    type: ChannelType9.FEED,
    channelId: `${userId}-home`,
    messageServerId: userId,
    worldId
  });
  const message = {
    id: createUniqueUuid(runtime, `tweet-${Date.now()}`),
    entityId: runtime.agentId,
    agentId: runtime.agentId,
    roomId,
    content: {},
    metadata: {
      entityName: runtime.character.name,
      type: "message"
    }
  };
  let state = await runtime.composeState(message, [
    "PROVIDERS",
    "CHARACTER",
    "RECENT_MESSAGES",
    "ENTITIES"
  ]);
  const entity = await runtime.getEntityById(runtime.agentId);
  const metadata = entity?.metadata;
  if (metadata?.twitter?.userName || metadata?.userName) {
    state.values.twitterUserName = metadata.twitter?.userName || metadata.userName;
  }
  const prompt = composePromptFromState10({
    state,
    template: runtime.character.templates?.messageHandlerTemplate || messageHandlerTemplate
  });
  let responseContent = null;
  let retries = 0;
  const maxRetries = 3;
  while (retries < maxRetries && (!responseContent?.thought || !responseContent?.actions)) {
    const response = await runtime.useModel(ModelType15.TEXT_SMALL, {
      prompt
    });
    const parsedXml = parseKeyValueXml9(response);
    if (parsedXml) {
      const actionsRaw = parsedXml.actions;
      const providersRaw = parsedXml.providers;
      responseContent = {
        thought: parsedXml.thought ?? "",
        actions: Array.isArray(actionsRaw) ? actionsRaw : actionsRaw ? [actionsRaw] : ["IGNORE"],
        providers: Array.isArray(providersRaw) ? providersRaw : providersRaw ? [providersRaw] : [],
        text: parsedXml.text ?? "",
        simple: parsedXml.simple ?? false
      };
    } else {
      responseContent = null;
    }
    retries++;
    if (!responseContent?.thought || !responseContent?.actions) {
      runtime.logger.warn({ src: "plugin:bootstrap", agentId: runtime.agentId, response, parsedXml, responseContent }, "Missing required fields, retrying");
    }
  }
  state = await runtime.composeState(message, responseContent?.providers);
  const postPrompt = composePromptFromState10({
    state,
    template: runtime.character.templates?.postCreationTemplate || postCreationTemplate
  });
  const xmlResponseText = await runtime.useModel(ModelType15.TEXT_LARGE, {
    prompt: postPrompt
  });
  const parsedXmlResponse = parseKeyValueXml9(xmlResponseText);
  if (!parsedXmlResponse) {
    runtime.logger.error({ src: "plugin:bootstrap", agentId: runtime.agentId, xmlResponseText }, "Failed to parse XML response for post creation");
    return;
  }
  function cleanupPostText(text) {
    let cleanedText2 = text.replace(/^['"](.*)['"]$/, "$1");
    cleanedText2 = cleanedText2.replaceAll(/\\n/g, `

`);
    cleanedText2 = cleanedText2.replace(/([^\n])\n([^\n])/g, `$1

$2`);
    return cleanedText2;
  }
  const cleanedText = cleanupPostText(parsedXmlResponse.post ?? "");
  const RM = state.data?.providers?.RECENT_MESSAGES;
  if (RM?.data?.recentMessages) {
    for (const m of RM.data.recentMessages) {
      if (cleanedText === m.content.text) {
        runtime.logger.info({ src: "plugin:bootstrap", agentId: runtime.agentId, cleanedText }, "Already recently posted that, retrying");
        postGeneratedHandler({
          runtime,
          callback,
          worldId,
          userId,
          roomId,
          source
        });
        return;
      }
    }
  }
  const oaiRefusalRegex = /((i\s+do\s+not|i'm\s+not)\s+(feel\s+)?comfortable\s+generating\s+that\s+type\s+of\s+content)|(inappropriate|explicit|respectful|offensive|guidelines|aim\s+to\s+(be\s+)?helpful|communicate\s+respectfully)/i;
  const anthropicRefusalRegex = /(i'?m\s+unable\s+to\s+help\s+with\s+that\s+request|due\s+to\s+safety\s+concerns|that\s+may\s+violate\s+(our\s+)?guidelines|provide\s+helpful\s+and\s+safe\s+responses|let'?s\s+try\s+a\s+different\s+direction|goes\s+against\s+(our\s+)?use\s+case\s+policies|ensure\s+safe\s+and\s+responsible\s+use)/i;
  const googleRefusalRegex = /(i\s+can'?t\s+help\s+with\s+that|that\s+goes\s+against\s+(our\s+)?(policy|policies)|i'?m\s+still\s+learning|response\s+must\s+follow\s+(usage|safety)\s+policies|i'?ve\s+been\s+designed\s+to\s+avoid\s+that)/i;
  const generalRefusalRegex = /(response\s+was\s+withheld|content\s+was\s+filtered|this\s+request\s+cannot\s+be\s+completed|violates\s+our\s+safety\s+policy|content\s+is\s+not\s+available)/i;
  if (oaiRefusalRegex.test(cleanedText) || anthropicRefusalRegex.test(cleanedText) || googleRefusalRegex.test(cleanedText) || generalRefusalRegex.test(cleanedText)) {
    runtime.logger.info({ src: "plugin:bootstrap", agentId: runtime.agentId, cleanedText }, "Got prompt moderation refusal, retrying");
    postGeneratedHandler({
      runtime,
      callback,
      worldId,
      userId,
      roomId,
      source
    });
    return;
  }
  const responseMessages = [
    {
      id: v4_default(),
      entityId: runtime.agentId,
      agentId: runtime.agentId,
      content: {
        text: cleanedText,
        source,
        channelType: ChannelType9.FEED,
        thought: parsedXmlResponse.thought ?? "",
        type: "post"
      },
      roomId: message.roomId,
      createdAt: Date.now()
    }
  ];
  for (const message2 of responseMessages) {
    await callback?.(message2.content);
  }
};
var syncSingleUser = async (entityId, runtime, messageServerId, channelId, type, source) => {
  try {
    const entity = await runtime.getEntityById(entityId);
    runtime.logger.info({
      src: "plugin:bootstrap",
      agentId: runtime.agentId,
      entityId,
      username: entity?.metadata?.username
    }, "Syncing user");
    if (!channelId) {
      runtime.logger.warn({ src: "plugin:bootstrap", agentId: runtime.agentId, entityId: entity?.id }, "Cannot sync user without a valid channelId");
      return;
    }
    const roomId = createUniqueUuid(runtime, channelId);
    const worldId = createUniqueUuid(runtime, messageServerId);
    const worldMetadata = type === ChannelType9.DM ? {
      ownership: {
        ownerId: entityId
      },
      roles: {
        [entityId]: Role2.OWNER
      },
      settings: {}
    } : undefined;
    runtime.logger.info({
      src: "plugin:bootstrap",
      agentId: runtime.agentId,
      type,
      isDM: type === ChannelType9.DM,
      worldMetadata
    }, "syncSingleUser");
    await runtime.ensureConnection({
      entityId,
      roomId,
      name: entity?.metadata?.name || entity?.metadata?.username || `User${entityId}`,
      source,
      channelId,
      messageServerId,
      type,
      worldId,
      metadata: worldMetadata
    });
    try {
      const createdWorld = await runtime.getWorld(worldId);
      runtime.logger.info({
        src: "plugin:bootstrap",
        agentId: runtime.agentId,
        worldId,
        metadata: createdWorld?.metadata
      }, "Created world check");
    } catch (error) {
      runtime.logger.error({
        src: "plugin:bootstrap",
        agentId: runtime.agentId,
        error: error instanceof Error ? error.message : String(error)
      }, "Failed to verify created world");
    }
    runtime.logger.success({
      src: "plugin:bootstrap",
      agentId: runtime.agentId,
      agentName: runtime.character.name,
      entityId: entity?.id
    }, "Successfully synced user");
  } catch (error) {
    runtime.logger.error({
      src: "plugin:bootstrap",
      agentId: runtime.agentId,
      error: error instanceof Error ? error.message : String(error)
    }, "Error syncing user");
  }
};
var handleServerSync = async ({
  runtime,
  world,
  rooms,
  entities,
  source,
  onComplete
}) => {
  runtime.logger.debug({ src: "plugin:bootstrap", agentId: runtime.agentId, serverName: world.name }, "Handling server sync event");
  try {
    await runtime.ensureConnections(entities, rooms, source, world);
    runtime.logger.debug({ src: "plugin:bootstrap", agentId: runtime.agentId, worldName: world.name }, "Successfully synced standardized world structure");
    onComplete?.();
  } catch (error) {
    runtime.logger.error({
      src: "plugin:bootstrap",
      agentId: runtime.agentId,
      error: error instanceof Error ? error.message : String(error)
    }, "Error processing standardized server data");
  }
};
var controlMessageHandler = async ({ runtime, message }) => {
  try {
    runtime.logger.debug({
      src: "plugin:bootstrap",
      agentId: runtime.agentId,
      action: message.payload.action,
      roomId: message.roomId
    }, "Processing control message");
    const serviceNames = Array.from(runtime.getAllServices().keys());
    const websocketServiceName = serviceNames.find((name) => name.toLowerCase().includes("websocket") || name.toLowerCase().includes("socket"));
    if (websocketServiceName) {
      const websocketService = runtime.getService(websocketServiceName);
      if (websocketService && "sendMessage" in websocketService) {
        await websocketService.sendMessage({
          type: "controlMessage",
          payload: {
            action: message.payload.action,
            target: message.payload.target,
            roomId: message.roomId
          }
        });
        runtime.logger.debug({ src: "plugin:bootstrap", agentId: runtime.agentId, action: message.payload.action }, "Control message sent successfully");
      } else {
        runtime.logger.error({ src: "plugin:bootstrap", agentId: runtime.agentId }, "WebSocket service does not have sendMessage method");
      }
    } else {
      runtime.logger.error({ src: "plugin:bootstrap", agentId: runtime.agentId }, "No WebSocket service found to send control message");
    }
  } catch (error) {
    runtime.logger.error({
      src: "plugin:bootstrap",
      agentId: runtime.agentId,
      error: error instanceof Error ? error.message : String(error)
    }, "Error processing control message");
  }
};
var events = {
  [EventType2.REACTION_RECEIVED]: [
    async (payload) => {
      await reactionReceivedHandler(payload);
    }
  ],
  [EventType2.POST_GENERATED]: [
    async (payload) => {
      await postGeneratedHandler(payload);
    }
  ],
  [EventType2.MESSAGE_SENT]: [
    async (payload) => {
      payload.runtime.logger.debug({
        src: "plugin:bootstrap",
        agentId: payload.runtime.agentId,
        text: payload.message.content.text
      }, "Message sent");
    }
  ],
  [EventType2.WORLD_JOINED]: [
    async (payload) => {
      await handleServerSync(payload);
    }
  ],
  [EventType2.WORLD_CONNECTED]: [
    async (payload) => {
      await handleServerSync(payload);
    }
  ],
  [EventType2.ENTITY_JOINED]: [
    async (payload) => {
      payload.runtime.logger.debug({ src: "plugin:bootstrap", agentId: payload.runtime.agentId, entityId: payload.entityId }, "ENTITY_JOINED event received");
      if (!payload.worldId) {
        payload.runtime.logger.error({ src: "plugin:bootstrap", agentId: payload.runtime.agentId }, "No worldId provided for entity joined");
        return;
      }
      if (!payload.roomId) {
        payload.runtime.logger.error({ src: "plugin:bootstrap", agentId: payload.runtime.agentId }, "No roomId provided for entity joined");
        return;
      }
      if (!payload.metadata?.type) {
        payload.runtime.logger.error({ src: "plugin:bootstrap", agentId: payload.runtime.agentId }, "No type provided for entity joined");
        return;
      }
      const channelType = payload.metadata?.type;
      if (typeof channelType !== "string") {
        payload.runtime.logger.warn("Missing channel type in entity payload");
        return;
      }
      await syncSingleUser(payload.entityId, payload.runtime, payload.worldId, payload.roomId, channelType, payload.source);
    }
  ],
  [EventType2.ENTITY_LEFT]: [
    async (payload) => {
      try {
        const entity = await payload.runtime.getEntityById(payload.entityId);
        if (entity) {
          entity.metadata = {
            ...entity.metadata,
            status: "INACTIVE",
            leftAt: Date.now()
          };
          await payload.runtime.updateEntity(entity);
        }
        payload.runtime.logger.info({
          src: "plugin:bootstrap",
          agentId: payload.runtime.agentId,
          entityId: payload.entityId,
          worldId: payload.worldId
        }, "User left world");
      } catch (error) {
        payload.runtime.logger.error({
          src: "plugin:bootstrap",
          agentId: payload.runtime.agentId,
          error: error instanceof Error ? error.message : String(error)
        }, "Error handling user left");
      }
    }
  ],
  [EventType2.ACTION_STARTED]: [
    async (payload) => {
      try {
        if (payload.content?.source === "client_chat") {
          const messageBusService = payload.runtime.getService("message-bus-service");
          if (messageBusService) {
            await messageBusService.notifyActionStart(payload.roomId, payload.world, payload.content, payload.messageId);
          }
        }
      } catch (error) {
        logger16.error({
          src: "plugin:bootstrap",
          agentId: payload.runtime.agentId,
          error: error instanceof Error ? error.message : String(error)
        }, "Error sending refetch request");
      }
    },
    async (payload) => {
      try {
        await payload.runtime.log({
          entityId: payload.runtime.agentId,
          roomId: payload.roomId,
          type: "action_event",
          body: {
            runId: payload.content?.runId,
            actionId: payload.content?.actionId,
            actionName: payload.content?.actions?.[0],
            roomId: payload.roomId,
            messageId: payload.messageId,
            timestamp: Date.now(),
            planStep: payload.content?.planStep,
            source: "actionHandler"
          }
        });
        logger16.debug({
          src: "plugin:bootstrap",
          agentId: payload.runtime.agentId,
          actionName: payload.content?.actions?.[0]
        }, "Logged ACTION_STARTED event");
      } catch (error) {
        logger16.error({
          src: "plugin:bootstrap",
          agentId: payload.runtime.agentId,
          error: error instanceof Error ? error.message : String(error)
        }, "Failed to log ACTION_STARTED event");
      }
    }
  ],
  [EventType2.ACTION_COMPLETED]: [
    async (payload) => {
      try {
        if (payload.content?.source === "client_chat") {
          const messageBusService = payload.runtime.getService("message-bus-service");
          if (messageBusService) {
            await messageBusService.notifyActionUpdate(payload.roomId, payload.world, payload.content, payload.messageId);
          }
        }
      } catch (error) {
        logger16.error({
          src: "plugin:bootstrap",
          agentId: payload.runtime.agentId,
          error: error instanceof Error ? error.message : String(error)
        }, "Error sending refetch request");
      }
    }
  ],
  [EventType2.EVALUATOR_STARTED]: [
    async (payload) => {
      logger16.debug({
        src: "plugin:bootstrap:evaluator",
        agentId: payload.runtime.agentId,
        evaluatorName: payload.evaluatorName,
        evaluatorId: payload.evaluatorId
      }, "Evaluator started");
    }
  ],
  [EventType2.EVALUATOR_COMPLETED]: [
    async (payload) => {
      const status = payload.error ? "failed" : "completed";
      logger16.debug({
        src: "plugin:bootstrap:evaluator",
        agentId: payload.runtime.agentId,
        status,
        evaluatorName: payload.evaluatorName,
        evaluatorId: payload.evaluatorId,
        error: payload.error?.message
      }, "Evaluator completed");
    }
  ],
  [EventType2.RUN_STARTED]: [
    async (payload) => {
      try {
        await payload.runtime.log({
          entityId: payload.entityId,
          roomId: payload.roomId,
          type: "run_event",
          body: {
            runId: payload.runId,
            status: payload.status,
            messageId: payload.messageId,
            roomId: payload.roomId,
            entityId: payload.entityId,
            startTime: payload.startTime,
            source: payload.source || "unknown"
          }
        });
        logger16.debug({ src: "plugin:bootstrap", agentId: payload.runtime.agentId, runId: payload.runId }, "Logged RUN_STARTED event");
      } catch (error) {
        logger16.error({
          src: "plugin:bootstrap",
          agentId: payload.runtime.agentId,
          error: error instanceof Error ? error.message : String(error)
        }, "Failed to log RUN_STARTED event");
      }
    }
  ],
  [EventType2.RUN_ENDED]: [
    async (payload) => {
      try {
        await payload.runtime.log({
          entityId: payload.entityId,
          roomId: payload.roomId,
          type: "run_event",
          body: {
            runId: payload.runId,
            status: payload.status,
            messageId: payload.messageId,
            roomId: payload.roomId,
            entityId: payload.entityId,
            startTime: payload.startTime,
            endTime: payload.endTime,
            duration: payload.duration,
            error: payload.error,
            source: payload.source || "unknown"
          }
        });
        logger16.debug({
          src: "plugin:bootstrap",
          agentId: payload.runtime.agentId,
          runId: payload.runId,
          status: payload.status
        }, "Logged RUN_ENDED event");
      } catch (error) {
        logger16.error({
          src: "plugin:bootstrap",
          agentId: payload.runtime.agentId,
          error: error instanceof Error ? error.message : String(error)
        }, "Failed to log RUN_ENDED event");
      }
    }
  ],
  [EventType2.RUN_TIMEOUT]: [
    async (payload) => {
      try {
        await payload.runtime.log({
          entityId: payload.entityId,
          roomId: payload.roomId,
          type: "run_event",
          body: {
            runId: payload.runId,
            status: payload.status,
            messageId: payload.messageId,
            roomId: payload.roomId,
            entityId: payload.entityId,
            startTime: payload.startTime,
            endTime: payload.endTime,
            duration: payload.duration,
            error: payload.error,
            source: payload.source || "unknown"
          }
        });
        logger16.debug({ src: "plugin:bootstrap", agentId: payload.runtime.agentId, runId: payload.runId }, "Logged RUN_TIMEOUT event");
      } catch (error) {
        logger16.error({
          src: "plugin:bootstrap",
          agentId: payload.runtime.agentId,
          error: error instanceof Error ? error.message : String(error)
        }, "Failed to log RUN_TIMEOUT event");
      }
    }
  ],
  [EventType2.CONTROL_MESSAGE]: [
    async (payload) => {
      if (!payload.message) {
        payload.runtime.logger.warn({ src: "plugin:bootstrap" }, "CONTROL_MESSAGE received without message property");
        return;
      }
      await controlMessageHandler(payload);
    }
  ]
};
var bootstrapPlugin = {
  name: "bootstrap",
  description: "Agent bootstrap with basic actions and evaluators",
  actions: [
    replyAction,
    followRoomAction,
    unfollowRoomAction,
    ignoreAction,
    noneAction,
    muteRoomAction,
    unmuteRoomAction,
    sendMessageAction,
    updateEntityAction,
    choiceAction,
    updateRoleAction,
    updateSettingsAction,
    generateImageAction
  ],
  events,
  evaluators: [reflectionEvaluator],
  providers: [
    evaluatorsProvider,
    anxietyProvider,
    timeProvider,
    entitiesProvider,
    relationshipsProvider,
    choiceProvider,
    factsProvider,
    roleProvider,
    settingsProvider,
    attachmentsProvider,
    providersProvider,
    actionsProvider,
    actionStateProvider,
    characterProvider,
    recentMessagesProvider,
    worldProvider
  ],
  services: [TaskService, EmbeddingGenerationService]
};
var src_default = bootstrapPlugin;
export {
  worldProvider,
  updateSettingsAction,
  updateRoleAction,
  updateEntityAction,
  unmuteRoomAction,
  unfollowRoomAction,
  timeProvider,
  shouldRespond,
  settingsProvider,
  sendMessageAction,
  roleProvider,
  replyAction,
  relationshipsProvider,
  reflectionEvaluator,
  recentMessagesProvider,
  providersProvider,
  processAttachments,
  noneAction,
  muteRoomAction,
  ignoreAction,
  generateImageAction,
  followRoomAction,
  fetchMediaData,
  factsProvider,
  evaluatorsProvider,
  entitiesProvider,
  src_default as default,
  choiceProvider,
  choiceAction,
  characterProvider,
  capabilitiesProvider,
  bootstrapPlugin,
  attachmentsProvider,
  anxietyProvider,
  actionsProvider,
  actionStateProvider
};

//# debugId=F729C17132DD6DB364756E2164756E21
//# sourceMappingURL=index.js.map
