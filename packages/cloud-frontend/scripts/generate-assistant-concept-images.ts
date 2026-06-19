import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  type AssistantConcept,
  assistantConcepts,
} from "../src/dashboard/assistant-concepts/concept-data";
import { getConceptVisual } from "../src/dashboard/assistant-concepts/visual-model";

const OUT_DIR = resolve("public/assistant-concepts/generated");

function esc(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function surfaceLayout(concept: AssistantConcept) {
  const visual = getConceptVisual(concept);
  const accent = visual.imageAccent;
  const secondary = visual.imageSecondary;
  const dim = `${secondary}33`;
  const panel = `${secondary}18`;
  const text = secondary;

  const chip = (x: number, y: number, label: string) => `
    <rect x="${x}" y="${y}" width="${label.length * 13 + 36}" height="34" rx="17" fill="${panel}" stroke="${secondary}44"/>
    <text x="${x + 18}" y="${y + 22}" font-size="13" fill="${text}" font-weight="700">${esc(label)}</text>
  `;

  const bars = (x: number, y: number, widths: number[]) =>
    widths
      .map(
        (width, index) =>
          `<rect x="${x}" y="${y + index * 24}" width="${width}" height="9" rx="4.5" fill="${dim}"/>`,
      )
      .join("");

  if (visual.primarySurface === "console") {
    return `
      <rect x="70" y="116" width="250" height="510" rx="3" fill="${panel}" stroke="${secondary}44"/>
      <rect x="350" y="116" width="450" height="510" rx="3" fill="${panel}" stroke="${secondary}44"/>
      <rect x="830" y="116" width="300" height="510" rx="3" fill="${panel}" stroke="${secondary}44"/>
      ${bars(100, 170, [160, 126, 190, 104, 150])}
      ${bars(390, 172, [340, 280, 360, 220, 310, 260])}
      ${bars(865, 172, [190, 230, 150, 205])}
      <circle cx="575" cy="390" r="92" fill="${accent}" opacity="0.92"/>
      <path d="M500 392h150M575 316v150" stroke="#000" stroke-width="10" stroke-linecap="round" opacity="0.45"/>
    `;
  }

  if (visual.primarySurface === "canvas") {
    return `
      <rect x="70" y="110" width="650" height="530" rx="3" fill="${panel}" stroke="${secondary}44"/>
      <rect x="752" y="110" width="378" height="250" rx="3" fill="${panel}" stroke="${secondary}44"/>
      <rect x="752" y="390" width="378" height="250" rx="3" fill="${panel}" stroke="${secondary}44"/>
      <rect x="126" y="170" width="250" height="350" rx="3" fill="${secondary}14" stroke="${secondary}33"/>
      <circle cx="520" cy="318" r="104" fill="${accent}" opacity="0.9"/>
      ${bars(790, 168, [250, 190, 285, 220])}
      ${bars(790, 448, [285, 240, 170, 260])}
      ${chip(138, 555, "file")}
      ${chip(250, 555, "screen")}
      ${chip(382, 555, "app")}
    `;
  }

  if (
    visual.primarySurface === "timeline" ||
    visual.primarySurface === "pipeline"
  ) {
    const labels =
      visual.primarySurface === "pipeline"
        ? ["Intent", "Run", "Review", "Done"]
        : ["Now", "Next", "Later", "Recap"];
    return `
      ${labels
        .map(
          (label, index) => `
            <rect x="${75 + index * 270}" y="120" width="235" height="150" rx="3" fill="${panel}" stroke="${secondary}44"/>
            <text x="${105 + index * 270}" y="164" font-size="24" fill="${index === 1 ? accent : text}" font-weight="800">${label}</text>
            ${bars(105 + index * 270, 192, [155, 112, 180])}
          `,
        )
        .join("")}
      <rect x="75" y="320" width="1050" height="260" rx="3" fill="${panel}" stroke="${secondary}44"/>
      <circle cx="600" cy="450" r="76" fill="${accent}"/>
      <path d="M180 450h300M720 450h300" stroke="${secondary}55" stroke-width="8" stroke-linecap="round"/>
      ${bars(130, 360, [230, 180, 260])}
      ${bars(810, 360, [240, 170, 220])}
    `;
  }

  if (visual.primarySurface === "inbox") {
    return `
      <rect x="72" y="118" width="360" height="500" rx="3" fill="${panel}" stroke="${secondary}44"/>
      <rect x="462" y="118" width="668" height="500" rx="3" fill="${panel}" stroke="${secondary}44"/>
      ${[0, 1, 2, 3]
        .map(
          (index) => `
            <rect x="110" y="${165 + index * 94}" width="280" height="62" rx="3" fill="${index === 0 ? accent : `${secondary}1f`}"/>
            <text x="132" y="${203 + index * 94}" font-size="18" fill="${index === 0 ? "#000" : text}" font-weight="800">${["Approve", "Reply", "Alert", "App"][index]}</text>
          `,
        )
        .join("")}
      <circle cx="650" cy="315" r="90" fill="${accent}"/>
      ${bars(780, 235, [230, 300, 260, 180])}
      ${chip(780, 390, "compare")}
      ${chip(930, 390, "book")}
    `;
  }

  if (visual.primarySurface === "stage") {
    return `
      <circle cx="600" cy="350" r="210" fill="${secondary}12" stroke="${secondary}33"/>
      <circle cx="600" cy="350" r="142" fill="${secondary}16" stroke="${secondary}44"/>
      <circle cx="600" cy="350" r="82" fill="${accent}"/>
      <rect x="90" y="126" width="250" height="68" rx="3" fill="${panel}" stroke="${secondary}44"/>
      <rect x="860" y="126" width="250" height="68" rx="3" fill="${panel}" stroke="${secondary}44"/>
      <rect x="250" y="576" width="700" height="58" rx="29" fill="${panel}" stroke="${secondary}44"/>
      ${chip(292, 590, visual.suggestionLabels[0] ?? "suggest")}
      ${chip(502, 590, visual.suggestionLabels[1] ?? "voice")}
      ${chip(710, 590, visual.suggestionLabels[2] ?? "app")}
    `;
  }

  return `
    <rect x="70" y="112" width="575" height="520" rx="3" fill="${panel}" stroke="${secondary}44"/>
    <rect x="675" y="112" width="455" height="250" rx="3" fill="${panel}" stroke="${secondary}44"/>
    <rect x="675" y="392" width="455" height="240" rx="3" fill="${panel}" stroke="${secondary}44"/>
    <circle cx="228" cy="255" r="74" fill="${accent}"/>
    ${bars(340, 210, [210, 170, 250, 198])}
    ${bars(720, 168, [260, 320, 240])}
    ${chip(150, 468, "voice")}
    ${chip(300, 468, "file")}
    ${chip(430, 468, "app")}
  `;
}

function svgForConcept(concept: AssistantConcept) {
  const visual = getConceptVisual(concept);
  const text = visual.imageSecondary;
  const bg = visual.imageBackdrop;
  const accent = visual.imageAccent;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 750" width="1200" height="750" role="img" aria-label="${esc(concept.title)} generated assistant preview">
    <rect width="1200" height="750" fill="${bg}"/>
    <circle cx="200" cy="120" r="180" fill="${accent}" opacity="0.18"/>
    <circle cx="1020" cy="620" r="220" fill="${visual.imageSecondary}" opacity="0.10"/>
    <rect x="40" y="40" width="1120" height="670" rx="3" fill="transparent" stroke="${text}26"/>
    <text x="70" y="86" font-family="Inter, Arial, sans-serif" font-size="30" fill="${text}" font-weight="900">${esc(concept.direction)}</text>
    <text x="70" y="680" font-family="Inter, Arial, sans-serif" font-size="20" fill="${text}" opacity="0.72">${esc(concept.look)} / ${esc(visual.transcriptPlacement)} transcript / ${esc(visual.appPlacement)} apps</text>
    ${surfaceLayout(concept)}
  </svg>`;
}

mkdirSync(OUT_DIR, { recursive: true });
for (const concept of assistantConcepts) {
  const filePath = resolve(OUT_DIR, `${concept.id}.svg`);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, svgForConcept(concept));
}

console.log(
  `Generated ${assistantConcepts.length} assistant concept images in ${OUT_DIR}`,
);
