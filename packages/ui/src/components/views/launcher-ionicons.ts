/**
 * Ionicons assets for the launcher surface.
 *
 * The launcher deliberately resolves its own mobile-native icon family instead
 * of changing ViewIcon globally: navigation rows and catalog surfaces keep
 * their established glyph contract while every app plate on the launcher uses
 * one consistent filled family.
 *
 * These are official Ionicons v8.1.0 SVGs vendored beside the component. The
 * package's string exports rely on ion-icon's shadow CSS for stroke glyphs;
 * direct SVG assets retain their complete fill/stroke presentation in <img>.
 */

export interface LauncherIconAsset {
  kind: "ionicon" | "image";
  name: string;
  src: string;
}

type LauncherIconEntry = {
  id: string;
  label: string;
  icon?: string | null;
};

function ionicon(name: string, src: string): LauncherIconAsset {
  return { kind: "ionicon", name, src };
}

const IONICONS = {
  analytics: ionicon(
    "analytics",
    new URL("./view-icons/ionicons/analytics.svg", import.meta.url).href,
  ),
  apps: ionicon(
    "apps",
    new URL("./view-icons/ionicons/apps.svg", import.meta.url).href,
  ),
  bagHandle: ionicon(
    "bag-handle",
    new URL("./view-icons/ionicons/bag-handle.svg", import.meta.url).href,
  ),
  barChart: ionicon(
    "bar-chart",
    new URL("./view-icons/ionicons/bar-chart.svg", import.meta.url).href,
  ),
  browsers: ionicon(
    "browsers",
    new URL("./view-icons/ionicons/browsers.svg", import.meta.url).href,
  ),
  call: ionicon(
    "call",
    new URL("./view-icons/ionicons/call.svg", import.meta.url).href,
  ),
  camera: ionicon(
    "camera",
    new URL("./view-icons/ionicons/camera.svg", import.meta.url).href,
  ),
  calendar: ionicon(
    "calendar",
    new URL("./view-icons/ionicons/calendar.svg", import.meta.url).href,
  ),
  card: ionicon(
    "card",
    new URL("./view-icons/ionicons/card.svg", import.meta.url).href,
  ),
  cash: ionicon(
    "cash",
    new URL("./view-icons/ionicons/cash.svg", import.meta.url).href,
  ),
  chat: ionicon(
    "chatbubble-ellipses",
    new URL("./view-icons/ionicons/chatbubble-ellipses.svg", import.meta.url)
      .href,
  ),
  checkbox: ionicon(
    "checkbox",
    new URL("./view-icons/ionicons/checkbox.svg", import.meta.url).href,
  ),
  clipboard: ionicon(
    "clipboard",
    new URL("./view-icons/ionicons/clipboard.svg", import.meta.url).href,
  ),
  cloud: ionicon(
    "cloud",
    new URL("./view-icons/ionicons/cloud.svg", import.meta.url).href,
  ),
  compass: ionicon(
    "compass",
    new URL("./view-icons/ionicons/compass.svg", import.meta.url).href,
  ),
  cube: ionicon(
    "cube",
    new URL("./view-icons/ionicons/cube.svg", import.meta.url).href,
  ),
  desktop: ionicon(
    "desktop",
    new URL("./view-icons/ionicons/desktop.svg", import.meta.url).href,
  ),
  documentText: ionicon(
    "document-text",
    new URL("./view-icons/ionicons/document-text.svg", import.meta.url).href,
  ),
  documents: ionicon(
    "documents",
    new URL("./view-icons/ionicons/documents.svg", import.meta.url).href,
  ),
  extensionPuzzle: ionicon(
    "extension-puzzle",
    new URL("./view-icons/ionicons/extension-puzzle.svg", import.meta.url).href,
  ),
  fileTrayFull: ionicon(
    "file-tray-full",
    new URL("./view-icons/ionicons/file-tray-full.svg", import.meta.url).href,
  ),
  flag: ionicon(
    "flag",
    new URL("./view-icons/ionicons/flag.svg", import.meta.url).href,
  ),
  flash: ionicon(
    "flash",
    new URL("./view-icons/ionicons/flash.svg", import.meta.url).href,
  ),
  flask: ionicon(
    "flask",
    new URL("./view-icons/ionicons/flask.svg", import.meta.url).href,
  ),
  folder: ionicon(
    "folder",
    new URL("./view-icons/ionicons/folder.svg", import.meta.url).href,
  ),
  folderOpen: ionicon(
    "folder-open",
    new URL("./view-icons/ionicons/folder-open.svg", import.meta.url).href,
  ),
  gameController: ionicon(
    "game-controller",
    new URL("./view-icons/ionicons/game-controller.svg", import.meta.url).href,
  ),
  gitBranch: ionicon(
    "git-branch",
    new URL("./view-icons/ionicons/git-branch.svg", import.meta.url).href,
  ),
  gitNetwork: ionicon(
    "git-network",
    new URL("./view-icons/ionicons/git-network.svg", import.meta.url).href,
  ),
  glasses: ionicon(
    "glasses",
    new URL("./view-icons/ionicons/glasses.svg", import.meta.url).href,
  ),
  globe: ionicon(
    "globe",
    new URL("./view-icons/ionicons/globe.svg", import.meta.url).href,
  ),
  grid: ionicon(
    "grid",
    new URL("./view-icons/ionicons/grid.svg", import.meta.url).href,
  ),
  hardwareChip: ionicon(
    "hardware-chip",
    new URL("./view-icons/ionicons/hardware-chip.svg", import.meta.url).href,
  ),
  heart: ionicon(
    "heart",
    new URL("./view-icons/ionicons/heart.svg", import.meta.url).href,
  ),
  image: ionicon(
    "image",
    new URL("./view-icons/ionicons/image.svg", import.meta.url).href,
  ),
  key: ionicon(
    "key",
    new URL("./view-icons/ionicons/key.svg", import.meta.url).href,
  ),
  layers: ionicon(
    "layers",
    new URL("./view-icons/ionicons/layers.svg", import.meta.url).href,
  ),
  library: ionicon(
    "library",
    new URL("./view-icons/ionicons/library.svg", import.meta.url).href,
  ),
  locate: ionicon(
    "locate",
    new URL("./view-icons/ionicons/locate.svg", import.meta.url).href,
  ),
  mail: ionicon(
    "mail",
    new URL("./view-icons/ionicons/mail.svg", import.meta.url).href,
  ),
  map: ionicon(
    "map",
    new URL("./view-icons/ionicons/map.svg", import.meta.url).href,
  ),
  mic: ionicon(
    "mic",
    new URL("./view-icons/ionicons/mic.svg", import.meta.url).href,
  ),
  micCircle: ionicon(
    "mic-circle",
    new URL("./view-icons/ionicons/mic-circle.svg", import.meta.url).href,
  ),
  newspaper: ionicon(
    "newspaper",
    new URL("./view-icons/ionicons/newspaper.svg", import.meta.url).href,
  ),
  options: ionicon(
    "options",
    new URL("./view-icons/ionicons/options.svg", import.meta.url).href,
  ),
  people: ionicon(
    "people",
    new URL("./view-icons/ionicons/people.svg", import.meta.url).href,
  ),
  personCircle: ionicon(
    "person-circle",
    new URL("./view-icons/ionicons/person-circle.svg", import.meta.url).href,
  ),
  phonePortrait: ionicon(
    "phone-portrait",
    new URL("./view-icons/ionicons/phone-portrait.svg", import.meta.url).href,
  ),
  pulse: ionicon(
    "pulse",
    new URL("./view-icons/ionicons/pulse.svg", import.meta.url).href,
  ),
  radio: ionicon(
    "radio",
    new URL("./view-icons/ionicons/radio.svg", import.meta.url).href,
  ),
  reader: ionicon(
    "reader",
    new URL("./view-icons/ionicons/reader.svg", import.meta.url).href,
  ),
  school: ionicon(
    "school",
    new URL("./view-icons/ionicons/school.svg", import.meta.url).href,
  ),
  server: ionicon(
    "server",
    new URL("./view-icons/ionicons/server.svg", import.meta.url).href,
  ),
  settings: ionicon(
    "settings",
    new URL("./view-icons/ionicons/settings.svg", import.meta.url).href,
  ),
  shield: ionicon(
    "shield",
    new URL("./view-icons/ionicons/shield.svg", import.meta.url).href,
  ),
  sparkles: ionicon(
    "sparkles",
    new URL("./view-icons/ionicons/sparkles.svg", import.meta.url).href,
  ),
  terminal: ionicon(
    "terminal",
    new URL("./view-icons/ionicons/terminal.svg", import.meta.url).href,
  ),
  time: ionicon(
    "time",
    new URL("./view-icons/ionicons/time.svg", import.meta.url).href,
  ),
  trendingUp: ionicon(
    "trending-up",
    new URL("./view-icons/ionicons/trending-up.svg", import.meta.url).href,
  ),
  wallet: ionicon(
    "wallet",
    new URL("./view-icons/ionicons/wallet.svg", import.meta.url).href,
  ),
  wifi: ionicon(
    "wifi",
    new URL("./view-icons/ionicons/wifi.svg", import.meta.url).href,
  ),
} as const;

/** Canonical first-party launcher destinations, including AOSP-only apps. */
const FIRST_PARTY_ICONS: Readonly<Record<string, LauncherIconAsset>> = {
  settings: IONICONS.settings,
  wallet: IONICONS.wallet,
  tasks: IONICONS.folderOpen,
  calendar: IONICONS.calendar,
  "simple-calendar": IONICONS.calendar,
  notes: IONICONS.documentText,
  automations: IONICONS.time,
  browser: IONICONS.compass,
  cloud: IONICONS.cloud,
  character: IONICONS.personCircle,
  documents: IONICONS.library,
  memories: IONICONS.hardwareChip,
  stream: IONICONS.radio,
  "pendant-transcript": IONICONS.micCircle,
  trajectories: IONICONS.gitBranch,
  database: IONICONS.server,
  runtime: IONICONS.terminal,
  logs: IONICONS.reader,
  skills: IONICONS.sparkles,
  plugins: IONICONS.extensionPuzzle,
  phone: IONICONS.call,
  messages: IONICONS.chat,
  contacts: IONICONS.people,
  camera: IONICONS.camera,
  files: IONICONS.folder,
  chat: IONICONS.chat,
};

function normalizedIconName(value: string): string {
  return value.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

const NAMED_ICONS: Readonly<Record<string, LauncherIconAsset>> = {
  activity: IONICONS.pulse,
  appwindow: IONICONS.browsers,
  apps: IONICONS.apps,
  barchart2: IONICONS.barChart,
  bird: IONICONS.extensionPuzzle,
  bot: IONICONS.hardwareChip,
  boxes: IONICONS.apps,
  brain: IONICONS.hardwareChip,
  braincircuit: IONICONS.hardwareChip,
  calendar: IONICONS.calendar,
  calendardays: IONICONS.calendar,
  circledollarsign: IONICONS.cash,
  clipboardlist: IONICONS.clipboard,
  clock: IONICONS.time,
  clock3: IONICONS.time,
  cloud: IONICONS.cloud,
  creditcard: IONICONS.card,
  database: IONICONS.server,
  files: IONICONS.documents,
  filetext: IONICONS.documentText,
  flaskconical: IONICONS.flask,
  focus: IONICONS.locate,
  folderclosed: IONICONS.folder,
  gamepad2: IONICONS.gameController,
  glasses: IONICONS.glasses,
  globe: IONICONS.globe,
  graduationcap: IONICONS.school,
  grid3x3: IONICONS.apps,
  heart: IONICONS.heart,
  image: IONICONS.image,
  imageicon: IONICONS.image,
  inbox: IONICONS.fileTrayFull,
  keyround: IONICONS.key,
  layers: IONICONS.layers,
  layoutdashboard: IONICONS.grid,
  layoutgrid: IONICONS.apps,
  listchecks: IONICONS.checkbox,
  listtodo: IONICONS.checkbox,
  mail: IONICONS.mail,
  map: IONICONS.map,
  messagesquare: IONICONS.chat,
  mic: IONICONS.mic,
  monitor: IONICONS.desktop,
  monitorup: IONICONS.desktop,
  network: IONICONS.gitNetwork,
  notebookpen: IONICONS.documentText,
  package: IONICONS.cube,
  phone: IONICONS.call,
  plug: IONICONS.extensionPuzzle,
  radio: IONICONS.radio,
  rss: IONICONS.newspaper,
  scatterchart: IONICONS.analytics,
  scrolltext: IONICONS.reader,
  settings: IONICONS.settings,
  shield: IONICONS.shield,
  shieldoff: IONICONS.shield,
  shoppingbag: IONICONS.bagHandle,
  slidershorizontal: IONICONS.options,
  smartphone: IONICONS.phonePortrait,
  sparkles: IONICONS.sparkles,
  squareterminal: IONICONS.terminal,
  stickynote: IONICONS.documentText,
  target: IONICONS.flag,
  terminal: IONICONS.terminal,
  terminalsquare: IONICONS.terminal,
  testtube2: IONICONS.flask,
  trendingup: IONICONS.trendingUp,
  userround: IONICONS.personCircle,
  users: IONICONS.people,
  usersround: IONICONS.people,
  wallet: IONICONS.wallet,
  wifi: IONICONS.wifi,
  zap: IONICONS.flash,
};

// Catalog placeholders describe no app-specific concept. Defer these to the
// entry's ID and label so a marketplace app called Hyperliquid, for example,
// gets a trading glyph instead of the generic app-library grid.
const GENERIC_NAMED_ICONS = new Set([
  "appwindow",
  "apps",
  "boxes",
  "grid3x3",
  "layoutdashboard",
  "layoutgrid",
]);

const KEYWORD_ICONS: ReadonlyArray<[RegExp, LauncherIconAsset]> = [
  [/\bsettings?\b|preference|config/, IONICONS.settings],
  [/\bwallet\b|inventory/, IONICONS.wallet],
  [/\bautomations?\b|trigger/, IONICONS.time],
  [/\btasks?\b|todo|checklist/, IONICONS.checkbox],
  [/\bcalendar\b|schedule|agenda/, IONICONS.calendar],
  [/\bnotes?\b|sticky ?note/, IONICONS.documentText],
  [/\bbrowser\b|\bweb\b|internet/, IONICONS.compass],
  [/\bcloud\b/, IONICONS.cloud],
  [/\bcharacter\b|companion|avatar|persona/, IONICONS.personCircle],
  [/\bdocuments?\b|knowledge|library/, IONICONS.library],
  [/\bmemories\b|recollection/, IONICONS.hardwareChip],
  [/\bfeed\b|social/, IONICONS.newspaper],
  [/stream|broadcast|\blive\b/, IONICONS.radio],
  [/transcript|voice|microphone|\bmic\b|speech|audio/, IONICONS.mic],
  [/trajector|activity/, IONICONS.pulse],
  [/database|vector|embedding/, IONICONS.server],
  [/runtime|task coordinator|console|terminal/, IONICONS.terminal],
  [/\blogs?\b|output/, IONICONS.reader],
  [/skill|capabilit/, IONICONS.sparkles],
  [/financ|budget|spend|money/, IONICONS.cash],
  [/hyperliquid|trade|trading|market|portfolio|perp|swap/, IONICONS.trendingUp],
  [/health|fitness|wellness|sleep/, IONICONS.heart],
  [/\binbox\b/, IONICONS.fileTrayFull],
  [/mail|email/, IONICONS.mail],
  [/message|sms|imessage|whatsapp|telegram|\bchat\b/, IONICONS.chat],
  [/contact|address book/, IONICONS.people],
  [/relationship|network|graph|orchestrat|workflow/, IONICONS.gitNetwork],
  [/phone|call|dial/, IONICONS.call],
  [/\bcamera\b/, IONICONS.camera],
  [/\bfiles?\b|folder/, IONICONS.folder],
  [/\bmaps?\b|location/, IONICONS.map],
  [/focus|blocker|deep work|distraction/, IONICONS.locate],
  [/goal|objective|target/, IONICONS.flag],
  [/shop|store|commerce|product|cart/, IONICONS.bagHandle],
  [/steward|security|shield/, IONICONS.shield],
  [/delegat|signer|\bkey\b|credential/, IONICONS.key],
  [/screen ?share|display|monitor|computer/, IONICONS.desktop],
  [/model|test|experiment/, IONICONS.flask],
  [/\bforms?\b|questionnaire|survey/, IONICONS.clipboard],
  [/wi-?fi|wireless/, IONICONS.wifi],
  [/glass|\bxr\b|spatial|\bvr\b/, IONICONS.glasses],
  [/arcade|\bgame/, IONICONS.gameController],
  [/plugin|extension|integration|birdclaw/, IONICONS.extensionPuzzle],
  [/my apps|app library|installed apps|projects/, IONICONS.apps],
];

function isImageIcon(value: string): boolean {
  return (
    value.startsWith("data:image/") ||
    value.startsWith("/") ||
    value.startsWith("http://") ||
    value.startsWith("https://")
  );
}

/** Resolve a launcher entry to the approved Ionicons family or its own image. */
export function resolveLauncherIconAsset(
  entry: LauncherIconEntry,
): LauncherIconAsset {
  const firstParty = FIRST_PARTY_ICONS[entry.id.toLowerCase()];
  if (firstParty) return firstParty;

  let namedIcon: LauncherIconAsset | undefined;
  if (entry.icon) {
    if (isImageIcon(entry.icon)) {
      return { kind: "image", name: "custom-image", src: entry.icon };
    }

    const normalizedName = normalizedIconName(entry.icon);
    namedIcon = NAMED_ICONS[normalizedName];
    if (namedIcon && !GENERIC_NAMED_ICONS.has(normalizedName)) return namedIcon;
  }

  const haystack = `${entry.id} ${entry.label}`.toLowerCase();
  for (const [pattern, asset] of KEYWORD_ICONS) {
    if (pattern.test(haystack)) return asset;
  }

  return namedIcon ?? IONICONS.apps;
}
