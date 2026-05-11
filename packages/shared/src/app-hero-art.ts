export interface AppHeroArtworkSource {
  name: string;
  displayName?: string | null;
  category?: string | null;
  description?: string | null;
}

export type AppHeroThemeKey =
  | "play"
  | "chat"
  | "money"
  | "tools"
  | "world"
  | "ops"
  | "app";

interface HeroPalette {
  readonly start: string;
  readonly end: string;
  readonly accent: string;
  readonly accentSoft: string;
  readonly highlight: string;
  readonly shadow: string;
}

const HERO_PALETTES: readonly HeroPalette[] = [
  {
    start: "#091226",
    end: "#27407a",
    accent: "#65d9ff",
    accentSoft: "#9d9cff",
    highlight: "#f9d6ff",
    shadow: "#050913",
  },
  {
    start: "#071d1d",
    end: "#155f5f",
    accent: "#67f7cf",
    accentSoft: "#58b7ff",
    highlight: "#ffe09a",
    shadow: "#041010",
  },
  {
    start: "#1a1025",
    end: "#58307d",
    accent: "#ff77d6",
    accentSoft: "#8dc4ff",
    highlight: "#ffe29f",
    shadow: "#09050f",
  },
  {
    start: "#16120a",
    end: "#6e4d1f",
    accent: "#ffd36b",
    accentSoft: "#ff9c53",
    highlight: "#fff2c5",
    shadow: "#0b0703",
  },
  {
    start: "#0c141a",
    end: "#355d72",
    accent: "#7af2ff",
    accentSoft: "#b6a3ff",
    highlight: "#fff4cb",
    shadow: "#06090f",
  },
] as const;

function hashString(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
}

function trimPackagePrefix(value: string): string {
  return value
    .replace(/^@[^/]+\//, "")
    .replace(/^(app|plugin)-/i, "")
    .trim();
}

export function getAppHeroDisplayLabel(app: AppHeroArtworkSource): string {
  return trimPackagePrefix(app.displayName ?? app.name);
}

export function getAppHeroMonogram(app: AppHeroArtworkSource): string {
  const label = trimPackagePrefix(app.displayName ?? app.name);
  const words = label.split(/[\s._/-]+/).filter(Boolean);
  const initials = words
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("");
  return (initials || label.slice(0, 2).toUpperCase() || "?").slice(0, 2);
}

export function getAppHeroThemeKey(app: AppHeroArtworkSource): AppHeroThemeKey {
  const blob = [
    app.name,
    app.displayName ?? "",
    app.category ?? "",
    app.description ?? "",
  ]
    .join(" ")
    .toLowerCase();

  if (/game|play|arcade|quest|adventure|battle|rpg/.test(blob)) {
    return "play";
  }
  if (/companion|chat|social|friend|community|message|dm/.test(blob)) {
    return "chat";
  }
  if (/finance|wallet|shop|commerce|trade|market|billing|invoice/.test(blob)) {
    return "money";
  }
  if (
    /utility|debug|runtime|viewer|plugin|memory|log|database|settings/.test(
      blob,
    )
  ) {
    return "tools";
  }
  if (/world|browser|web|network|global|platform/.test(blob)) {
    return "world";
  }
  if (/ops|business|team|work|project|task|calendar|life/.test(blob)) {
    return "ops";
  }
  return "app";
}

function getHeroPalette(name: string): HeroPalette {
  return HERO_PALETTES[hashString(name) % HERO_PALETTES.length];
}

function getSeededOffset(
  seed: number,
  divisor: number,
  spread: number,
): number {
  return ((seed % divisor) / divisor - 0.5) * spread;
}

function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderPlayMotif(seed: number, palette: HeroPalette): string {
  const shiftX = getSeededOffset(seed, 19, 26);
  const shiftY = getSeededOffset(seed >> 3, 13, 20);
  return `
    <g transform="translate(${620 + shiftX} ${388 + shiftY})">
      <ellipse cx="0" cy="250" rx="280" ry="54" fill="${palette.highlight}" fill-opacity="0.12"/>
      <ellipse cx="0" cy="250" rx="212" ry="30" fill="${palette.shadow}" fill-opacity="0.48"/>
      <circle cx="0" cy="38" r="176" fill="${palette.shadow}" fill-opacity="0.34" stroke="${palette.accent}" stroke-width="4" stroke-opacity="0.65"/>
      <circle cx="0" cy="38" r="120" fill="${palette.accentSoft}" fill-opacity="0.14" stroke="${palette.highlight}" stroke-width="3" stroke-opacity="0.45"/>
      <circle cx="-132" cy="-18" r="42" fill="${palette.accent}" fill-opacity="0.2" stroke="${palette.accent}" stroke-width="3" stroke-opacity="0.7"/>
      <circle cx="132" cy="-18" r="42" fill="${palette.highlight}" fill-opacity="0.18" stroke="${palette.highlight}" stroke-width="3" stroke-opacity="0.65"/>
      <path d="M-56 -88 18 -22 -56 44Z" fill="${palette.highlight}" fill-opacity="0.78"/>
      <rect x="-14" y="-118" width="28" height="240" rx="14" fill="${palette.accent}" fill-opacity="0.22"/>
      <rect x="-118" y="-14" width="236" height="28" rx="14" fill="${palette.accentSoft}" fill-opacity="0.18"/>
      <path d="M-210 146c84-84 164-104 242-104 84 0 160 24 244 110" stroke="${palette.accent}" stroke-width="6" stroke-linecap="round" stroke-opacity="0.44" fill="none"/>
    </g>
  `.trim();
}

function renderChatMotif(seed: number, palette: HeroPalette): string {
  const shiftX = getSeededOffset(seed, 17, 24);
  return `
    <g transform="translate(${265 + shiftX} 200)">
      <rect x="0" y="72" width="520" height="220" rx="42" fill="${palette.shadow}" fill-opacity="0.42" stroke="${palette.accent}" stroke-width="4" stroke-opacity="0.55"/>
      <rect x="144" y="0" width="420" height="192" rx="40" fill="${palette.shadow}" fill-opacity="0.36" stroke="${palette.highlight}" stroke-width="4" stroke-opacity="0.5"/>
      <rect x="276" y="228" width="330" height="150" rx="34" fill="${palette.shadow}" fill-opacity="0.32" stroke="${palette.accentSoft}" stroke-width="4" stroke-opacity="0.52"/>
      <path d="M86 292 132 246 178 292" stroke="${palette.accent}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" opacity="0.72"/>
      <path d="M514 192 542 226 578 190" stroke="${palette.highlight}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" opacity="0.72"/>
      <path d="M414 378 450 414 494 378" stroke="${palette.accentSoft}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" opacity="0.72"/>
      <circle cx="76" cy="132" r="24" fill="${palette.accent}" fill-opacity="0.82"/>
      <circle cx="214" cy="54" r="20" fill="${palette.highlight}" fill-opacity="0.78"/>
      <circle cx="340" cy="268" r="20" fill="${palette.accentSoft}" fill-opacity="0.8"/>
      <rect x="126" y="116" width="238" height="16" rx="8" fill="white" fill-opacity="0.92"/>
      <rect x="126" y="152" width="176" height="14" rx="7" fill="white" fill-opacity="0.56"/>
      <rect x="246" y="44" width="188" height="16" rx="8" fill="white" fill-opacity="0.92"/>
      <rect x="246" y="80" width="120" height="14" rx="7" fill="white" fill-opacity="0.56"/>
      <rect x="378" y="258" width="154" height="16" rx="8" fill="white" fill-opacity="0.9"/>
      <rect x="378" y="294" width="116" height="14" rx="7" fill="white" fill-opacity="0.54"/>
      <path d="M76 132 214 54 340 268" stroke="${palette.highlight}" stroke-width="3" stroke-opacity="0.28" fill="none"/>
    </g>
  `.trim();
}

function renderMoneyMotif(seed: number, palette: HeroPalette): string {
  const barBase = 620 + getSeededOffset(seed, 11, 18);
  return `
    <g transform="translate(${barBase} 154)">
      <path d="M-372 414c104-38 206-54 306-42 80 8 170 26 254 14 86-12 158-44 238-116" stroke="${palette.highlight}" stroke-width="8" stroke-linecap="round" stroke-opacity="0.36" fill="none"/>
      <path d="M-390 474c120-28 228-26 324-4 104 24 214 38 324 18 88-16 164-56 246-118" stroke="${palette.accent}" stroke-width="5" stroke-linecap="round" stroke-opacity="0.4" fill="none"/>
      <g fill="none" stroke="${palette.highlight}" stroke-opacity="0.46" stroke-width="4">
        <path d="M-340 190v146"/>
        <path d="M-274 152v184"/>
        <path d="M-208 112v224"/>
        <path d="M-142 82v254"/>
        <path d="M-76 132v204"/>
        <path d="M-10 96v240"/>
      </g>
      <g fill="${palette.accentSoft}" fill-opacity="0.22" stroke="${palette.accent}" stroke-width="3" stroke-opacity="0.66">
        <rect x="-360" y="224" width="34" height="90" rx="10"/>
        <rect x="-294" y="188" width="34" height="126" rx="10"/>
        <rect x="-228" y="146" width="34" height="168" rx="10"/>
        <rect x="-162" y="114" width="34" height="200" rx="10"/>
        <rect x="-96" y="172" width="34" height="142" rx="10"/>
        <rect x="-30" y="134" width="34" height="180" rx="10"/>
      </g>
      <g transform="translate(176 198)">
        <circle cx="0" cy="0" r="164" fill="${palette.shadow}" fill-opacity="0.4" stroke="${palette.highlight}" stroke-width="4" stroke-opacity="0.55"/>
        <circle cx="0" cy="0" r="112" fill="${palette.accent}" fill-opacity="0.1" stroke="${palette.accent}" stroke-width="3" stroke-opacity="0.65"/>
        <circle cx="0" cy="0" r="48" fill="${palette.highlight}" fill-opacity="0.22" stroke="${palette.highlight}" stroke-width="3" stroke-opacity="0.72"/>
        <path d="M-32 -18 0 -50 32 -18 32 18 0 50 -32 18Z" fill="${palette.shadow}" fill-opacity="0.45" stroke="${palette.highlight}" stroke-width="3" stroke-opacity="0.68"/>
        <path d="M-10 -8 0 -22 10 -8 10 8 0 22 -10 8Z" fill="${palette.highlight}" fill-opacity="0.68"/>
      </g>
    </g>
  `.trim();
}

function renderToolsMotif(seed: number, palette: HeroPalette): string {
  const shiftY = getSeededOffset(seed >> 4, 17, 18);
  return `
    <g transform="translate(254 ${178 + shiftY})">
      <rect x="160" y="74" width="448" height="314" rx="36" fill="${palette.shadow}" fill-opacity="0.42" stroke="${palette.highlight}" stroke-width="4" stroke-opacity="0.5"/>
      <rect x="0" y="158" width="192" height="148" rx="28" fill="${palette.shadow}" fill-opacity="0.32" stroke="${palette.accent}" stroke-width="4" stroke-opacity="0.58"/>
      <rect x="646" y="112" width="206" height="176" rx="28" fill="${palette.shadow}" fill-opacity="0.32" stroke="${palette.accentSoft}" stroke-width="4" stroke-opacity="0.56"/>
      <rect x="224" y="118" width="320" height="24" rx="12" fill="white" fill-opacity="0.14"/>
      <rect x="224" y="180" width="142" height="14" rx="7" fill="white" fill-opacity="0.86"/>
      <rect x="224" y="216" width="248" height="12" rx="6" fill="white" fill-opacity="0.42"/>
      <rect x="224" y="258" width="118" height="14" rx="7" fill="white" fill-opacity="0.86"/>
      <rect x="224" y="294" width="212" height="12" rx="6" fill="white" fill-opacity="0.42"/>
      <rect x="224" y="338" width="284" height="12" rx="6" fill="white" fill-opacity="0.34"/>
      <rect x="34" y="204" width="112" height="18" rx="9" fill="white" fill-opacity="0.82"/>
      <rect x="34" y="242" width="86" height="12" rx="6" fill="white" fill-opacity="0.4"/>
      <rect x="682" y="148" width="128" height="18" rx="9" fill="white" fill-opacity="0.82"/>
      <rect x="682" y="186" width="92" height="12" rx="6" fill="white" fill-opacity="0.42"/>
      <path d="M96 158V72h528v74" stroke="${palette.accent}" stroke-width="3" stroke-opacity="0.34" fill="none"/>
      <path d="M96 306v78h656v-96" stroke="${palette.accentSoft}" stroke-width="3" stroke-opacity="0.3" fill="none"/>
      <circle cx="386" cy="44" r="26" fill="${palette.highlight}" fill-opacity="0.8"/>
      <circle cx="386" cy="44" r="10" fill="${palette.shadow}" fill-opacity="0.56"/>
    </g>
  `.trim();
}

function renderWorldMotif(seed: number, palette: HeroPalette): string {
  const shiftX = getSeededOffset(seed >> 2, 23, 18);
  return `
    <g transform="translate(${606 + shiftX} 372)">
      <circle cx="0" cy="0" r="208" fill="${palette.shadow}" fill-opacity="0.34" stroke="${palette.highlight}" stroke-width="4" stroke-opacity="0.44"/>
      <ellipse cx="0" cy="0" rx="208" ry="72" stroke="${palette.accent}" stroke-width="4" stroke-opacity="0.58" fill="none"/>
      <ellipse cx="0" cy="0" rx="208" ry="152" stroke="${palette.accentSoft}" stroke-width="3" stroke-opacity="0.4" fill="none"/>
      <ellipse cx="0" cy="0" rx="104" ry="208" stroke="${palette.highlight}" stroke-width="3" stroke-opacity="0.42" fill="none"/>
      <ellipse cx="0" cy="0" rx="164" ry="208" stroke="${palette.accent}" stroke-width="2.5" stroke-opacity="0.28" fill="none"/>
      <path d="M-246 -182h492" stroke="${palette.highlight}" stroke-width="3" stroke-opacity="0.34"/>
      <path d="M-206 -140h412" stroke="${palette.highlight}" stroke-width="3" stroke-opacity="0.22"/>
      <g fill="${palette.accent}" fill-opacity="0.82">
        <circle cx="-182" cy="-72" r="12"/>
        <circle cx="154" cy="-106" r="12"/>
        <circle cx="116" cy="144" r="12"/>
        <circle cx="-96" cy="126" r="12"/>
      </g>
      <path d="M-182 -72-36 -18 154 -106" stroke="${palette.accent}" stroke-width="3" stroke-opacity="0.5" fill="none"/>
      <path d="M-36 -18 116 144-96 126" stroke="${palette.accentSoft}" stroke-width="3" stroke-opacity="0.44" fill="none"/>
      <rect x="-298" y="-252" width="596" height="84" rx="24" fill="${palette.shadow}" fill-opacity="0.22" stroke="${palette.highlight}" stroke-width="3" stroke-opacity="0.34"/>
    </g>
  `.trim();
}

function renderOpsMotif(seed: number, palette: HeroPalette): string {
  const shiftX = getSeededOffset(seed, 13, 18);
  return `
    <g transform="translate(${252 + shiftX} 148)">
      <rect x="188" y="36" width="360" height="430" rx="42" fill="${palette.shadow}" fill-opacity="0.38" stroke="${palette.highlight}" stroke-width="4" stroke-opacity="0.48"/>
      <rect x="32" y="216" width="164" height="78" rx="26" fill="${palette.shadow}" fill-opacity="0.3" stroke="${palette.accentSoft}" stroke-width="4" stroke-opacity="0.54"/>
      <rect x="566" y="118" width="262" height="92" rx="28" fill="${palette.shadow}" fill-opacity="0.3" stroke="${palette.highlight}" stroke-width="4" stroke-opacity="0.48"/>
      <rect x="566" y="246" width="262" height="92" rx="28" fill="${palette.shadow}" fill-opacity="0.3" stroke="${palette.accent}" stroke-width="4" stroke-opacity="0.54"/>
      <rect x="566" y="374" width="262" height="92" rx="28" fill="${palette.shadow}" fill-opacity="0.3" stroke="${palette.accentSoft}" stroke-width="4" stroke-opacity="0.54"/>
      <rect x="232" y="76" width="272" height="22" rx="11" fill="white" fill-opacity="0.18"/>
      <g fill="white" fill-opacity="0.76">
        <rect x="244" y="138" width="44" height="44" rx="14"/>
        <rect x="244" y="212" width="44" height="44" rx="14"/>
        <rect x="244" y="286" width="44" height="44" rx="14"/>
        <rect x="244" y="360" width="44" height="44" rx="14"/>
      </g>
      <g fill="white">
        <rect x="320" y="148" width="146" height="14" rx="7" fill-opacity="0.9"/>
        <rect x="320" y="186" width="104" height="12" rx="6" fill-opacity="0.42"/>
        <rect x="320" y="222" width="124" height="14" rx="7" fill-opacity="0.9"/>
        <rect x="320" y="260" width="148" height="12" rx="6" fill-opacity="0.42"/>
        <rect x="320" y="296" width="158" height="14" rx="7" fill-opacity="0.9"/>
        <rect x="320" y="334" width="126" height="12" rx="6" fill-opacity="0.42"/>
        <rect x="320" y="370" width="132" height="14" rx="7" fill-opacity="0.9"/>
      </g>
      <path d="M74 256h80" stroke="${palette.highlight}" stroke-width="4" stroke-linecap="round"/>
      <path d="M112 236v40" stroke="${palette.highlight}" stroke-width="4" stroke-linecap="round"/>
      <rect x="608" y="148" width="148" height="16" rx="8" fill="white" fill-opacity="0.86"/>
      <rect x="608" y="280" width="174" height="16" rx="8" fill="white" fill-opacity="0.86"/>
      <rect x="608" y="408" width="132" height="16" rx="8" fill="white" fill-opacity="0.86"/>
    </g>
  `.trim();
}

function renderDefaultMotif(seed: number, palette: HeroPalette): string {
  const shift = getSeededOffset(seed >> 1, 29, 20);
  return `
    <g transform="translate(${610 + shift} 368)">
      <circle cx="0" cy="0" r="28" fill="${palette.highlight}" fill-opacity="0.86"/>
      <circle cx="-198" cy="-102" r="22" fill="${palette.accent}" fill-opacity="0.78"/>
      <circle cx="224" cy="-146" r="22" fill="${palette.accentSoft}" fill-opacity="0.78"/>
      <circle cx="178" cy="156" r="22" fill="${palette.highlight}" fill-opacity="0.72"/>
      <circle cx="-142" cy="142" r="22" fill="${palette.accent}" fill-opacity="0.74"/>
      <path d="M0 0-198-102M0 0 224-146M0 0 178 156M0 0-142 142M-198-102-142 142M224-146 178 156" stroke="${palette.highlight}" stroke-width="4" stroke-opacity="0.34" fill="none"/>
      <rect x="-250" y="-232" width="500" height="464" rx="48" fill="${palette.shadow}" fill-opacity="0.14" stroke="${palette.accent}" stroke-width="3" stroke-opacity="0.22"/>
      <rect x="-186" y="-156" width="188" height="108" rx="26" fill="${palette.shadow}" fill-opacity="0.26" stroke="${palette.accent}" stroke-width="3" stroke-opacity="0.38"/>
      <rect x="26" y="-72" width="196" height="124" rx="26" fill="${palette.shadow}" fill-opacity="0.26" stroke="${palette.accentSoft}" stroke-width="3" stroke-opacity="0.4"/>
      <rect x="-84" y="94" width="220" height="112" rx="26" fill="${palette.shadow}" fill-opacity="0.26" stroke="${palette.highlight}" stroke-width="3" stroke-opacity="0.38"/>
    </g>
  `.trim();
}

function renderThemeMotif(
  theme: AppHeroThemeKey,
  seed: number,
  palette: HeroPalette,
): string {
  switch (theme) {
    case "play":
      return renderPlayMotif(seed, palette);
    case "chat":
      return renderChatMotif(seed, palette);
    case "money":
      return renderMoneyMotif(seed, palette);
    case "tools":
      return renderToolsMotif(seed, palette);
    case "world":
      return renderWorldMotif(seed, palette);
    case "ops":
      return renderOpsMotif(seed, palette);
    default:
      return renderDefaultMotif(seed, palette);
  }
}

export function createGeneratedAppHeroSvg(app: AppHeroArtworkSource): string {
  const palette = getHeroPalette(app.name);
  const theme = getAppHeroThemeKey(app);
  const seed = hashString(app.name);
  const gridOffsetX = 16 + (seed % 14);
  const gridOffsetY = 10 + ((seed >> 4) % 10);
  const radialX = 18 + (seed % 44);
  const radialY = 10 + ((seed >> 6) % 30);
  const arcTilt = (seed % 24) - 12;
  const motif = renderThemeMotif(theme, seed, palette);
  const title = escapeXmlText(getAppHeroDisplayLabel(app));

  // The app card already renders the display name as a small label below
  // the hero. Baking the name into the generated SVG produced a duplicate
  // (visible as a large translucent overlay on top of the small label),
  // so the hero artwork is now name-free; only the <title> element is
  // preserved for accessibility.
  return `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 900" fill="none">
      <title>${title}</title>
      <defs>
        <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="${palette.start}"/>
          <stop offset="100%" stop-color="${palette.end}"/>
        </linearGradient>
        <radialGradient id="glowA" cx="${radialX}%" cy="${radialY}%" r="72%">
          <stop offset="0%" stop-color="${palette.highlight}" stop-opacity="0.18"/>
          <stop offset="100%" stop-color="${palette.highlight}" stop-opacity="0"/>
        </radialGradient>
        <radialGradient id="glowB" cx="86%" cy="84%" r="58%">
          <stop offset="0%" stop-color="${palette.accent}" stop-opacity="0.22"/>
          <stop offset="100%" stop-color="${palette.accent}" stop-opacity="0"/>
        </radialGradient>
        <pattern id="grid" width="36" height="36" patternUnits="userSpaceOnUse" patternTransform="translate(${gridOffsetX} ${gridOffsetY})">
          <path d="M0 0H36M0 0V36" stroke="white" stroke-opacity="0.08" stroke-width="1"/>
          <circle cx="1.5" cy="1.5" r="1.5" fill="white" fill-opacity="0.14"/>
        </pattern>
      </defs>
      <rect width="1200" height="900" rx="54" fill="url(#bg)"/>
      <rect width="1200" height="900" rx="54" fill="url(#glowA)"/>
      <rect width="1200" height="900" rx="54" fill="url(#glowB)"/>
      <rect width="1200" height="900" rx="54" fill="url(#grid)"/>
      <path d="M-120 166C118 84 354 104 564 220s408 118 714-10v190C952 486 704 506 500 404S92 290-120 372Z" fill="${palette.highlight}" fill-opacity="0.08"/>
      <g opacity="0.24" transform="translate(930 156) rotate(${arcTilt})">
        <path d="M-206 0C-112 -116 80 -150 222 -70" stroke="${palette.accent}" stroke-width="18" stroke-linecap="round"/>
        <path d="M-172 34C-82 -54 74 -70 176 -22" stroke="${palette.accentSoft}" stroke-width="10" stroke-linecap="round"/>
      </g>
      ${motif}
    </svg>
  `.trim();
}

export function createGeneratedAppHeroDataUrl(
  app: AppHeroArtworkSource,
): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
    createGeneratedAppHeroSvg(app),
  )}`;
}
