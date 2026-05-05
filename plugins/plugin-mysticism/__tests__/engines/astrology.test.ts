import { describe, expect, it } from "vitest";
import { toJulianDay } from "../../src/engines/astrology/chart";
import housesData from "../../src/engines/astrology/data/houses.json";
import planetsData from "../../src/engines/astrology/data/planets.json";
import signsData from "../../src/engines/astrology/data/signs.json";
import type {
  BirthData,
  FeedbackEntry,
  NatalChart,
  PlanetPosition,
  SignPosition,
} from "../../src/engines/astrology/index";
import {
  AstrologyEngine,
  buildAstrologySynthesisPrompt,
  buildChartOverviewPrompt,
  buildPlanetInterpretationPrompt,
  calculateAspects,
  calculateNatalChart,
  calculateSunSign,
  degreesToSign,
  getAspectDefinitions,
  getElement,
  getModality,
  getRulingPlanet,
  isAspect,
  SIGN_ORDER,
  signDisplayName,
} from "../../src/engines/astrology/index";

// ─── Test fixtures ───────────────────────────────────────

/** Birth data for someone born March 25 1990 at noon in New York — well within Aries. */
const ariesBirthData: BirthData = {
  year: 1990,
  month: 3,
  day: 25,
  hour: 12,
  minute: 0,
  latitude: 40.7128,
  longitude: -74.006,
  timezone: -5,
};

/** Birth data for someone born July 4 1985 at 8am in London — Cancer season. */
const cancerBirthData: BirthData = {
  year: 1985,
  month: 7,
  day: 4,
  hour: 8,
  minute: 0,
  latitude: 51.5074,
  longitude: -0.1278,
  timezone: 0,
};

// ─── Sun Sign Calculation ────────────────────────────────

describe("Sun Sign Calculation", () => {
  it("calculateSunSign returns the correct sign for representative dates of all 12 signs", () => {
    const signTests: Array<{ month: number; day: number; expected: string }> = [
      { month: 1, day: 5, expected: "capricorn" },
      { month: 1, day: 25, expected: "aquarius" },
      { month: 2, day: 25, expected: "pisces" },
      { month: 3, day: 25, expected: "aries" },
      { month: 4, day: 25, expected: "taurus" },
      { month: 5, day: 25, expected: "gemini" },
      { month: 6, day: 25, expected: "cancer" },
      { month: 7, day: 25, expected: "leo" },
      { month: 8, day: 25, expected: "virgo" },
      { month: 9, day: 25, expected: "libra" },
      { month: 10, day: 25, expected: "scorpio" },
      { month: 11, day: 25, expected: "sagittarius" },
      { month: 12, day: 25, expected: "capricorn" },
    ];

    for (const { month, day, expected } of signTests) {
      expect(calculateSunSign(month, day)).toBe(expected);
    }
  });

  it("calculateSunSign handles boundary dates correctly", () => {
    const boundaryTests: Array<{
      month: number;
      day: number;
      expected: string;
    }> = [
      // Capricorn → Aquarius
      { month: 1, day: 19, expected: "capricorn" },
      { month: 1, day: 20, expected: "aquarius" },
      // Pisces → Aries
      { month: 3, day: 20, expected: "pisces" },
      { month: 3, day: 21, expected: "aries" },
      // Gemini → Cancer
      { month: 6, day: 20, expected: "gemini" },
      { month: 6, day: 21, expected: "cancer" },
      // Leo → Virgo
      { month: 8, day: 22, expected: "leo" },
      { month: 8, day: 23, expected: "virgo" },
      // Sagittarius → Capricorn
      { month: 12, day: 21, expected: "sagittarius" },
      { month: 12, day: 22, expected: "capricorn" },
    ];

    for (const { month, day, expected } of boundaryTests) {
      expect(calculateSunSign(month, day)).toBe(expected);
    }
  });

  it("known birth dates produce expected sun signs via full chart calculation", () => {
    // March 25 — well within Aries
    const ariesChart = calculateNatalChart(ariesBirthData);
    expect(ariesChart.sun.sign).toBe("aries");

    // July 4 — well within Cancer
    const cancerChart = calculateNatalChart(cancerBirthData);
    expect(cancerChart.sun.sign).toBe("cancer");
  });
});

// ─── Zodiac Data and Utility Functions ───────────────────

describe("Zodiac Data and Functions", () => {
  it("SIGN_ORDER contains all 12 zodiac signs", () => {
    expect(SIGN_ORDER).toHaveLength(12);
    expect(SIGN_ORDER[0]).toBe("aries");
    expect(SIGN_ORDER[11]).toBe("pisces");
    // All expected signs present
    const expected = [
      "aries",
      "taurus",
      "gemini",
      "cancer",
      "leo",
      "virgo",
      "libra",
      "scorpio",
      "sagittarius",
      "capricorn",
      "aquarius",
      "pisces",
    ];
    for (const sign of expected) {
      expect(SIGN_ORDER).toContain(sign);
    }
  });

  it("degreesToSign maps 0 degrees to Aries at 0 degrees", () => {
    const result: SignPosition = degreesToSign(0);
    expect(result.sign).toBe("aries");
    expect(result.degrees).toBeCloseTo(0, 5);
    expect(result.totalDegrees).toBeCloseTo(0, 5);
  });

  it("degreesToSign maps 359 degrees to Pisces at 29 degrees", () => {
    const result: SignPosition = degreesToSign(359);
    expect(result.sign).toBe("pisces");
    expect(result.degrees).toBeCloseTo(29, 0);
    expect(result.totalDegrees).toBeCloseTo(359, 5);
  });

  it("degreesToSign correctly maps all 12 signs at the midpoint of each", () => {
    const expected = [
      "aries",
      "taurus",
      "gemini",
      "cancer",
      "leo",
      "virgo",
      "libra",
      "scorpio",
      "sagittarius",
      "capricorn",
      "aquarius",
      "pisces",
    ];
    for (let i = 0; i < 12; i++) {
      const midDeg = i * 30 + 15; // middle of each 30° sign
      const result: SignPosition = degreesToSign(midDeg);
      expect(result.sign).toBe(expected[i]);
      expect(result.degrees).toBeCloseTo(15, 5);
    }
  });

  it("degreesToSign normalizes degrees outside 0-360 range", () => {
    const pos360: SignPosition = degreesToSign(360);
    expect(pos360.sign).toBe("aries");
    expect(pos360.degrees).toBeCloseTo(0, 5);

    const neg30: SignPosition = degreesToSign(-30);
    expect(neg30.sign).toBe("pisces");
    expect(neg30.degrees).toBeCloseTo(0, 0);
  });

  it("getElement returns correct elements for known signs", () => {
    expect(getElement("aries")).toBe("fire");
    expect(getElement("taurus")).toBe("earth");
    expect(getElement("gemini")).toBe("air");
    expect(getElement("cancer")).toBe("water");
    expect(getElement("leo")).toBe("fire");
    expect(getElement("virgo")).toBe("earth");
    expect(getElement("libra")).toBe("air");
    expect(getElement("scorpio")).toBe("water");
  });

  it("getModality returns correct modalities for known signs", () => {
    expect(getModality("aries")).toBe("cardinal");
    expect(getModality("taurus")).toBe("fixed");
    expect(getModality("gemini")).toBe("mutable");
    expect(getModality("cancer")).toBe("cardinal");
    expect(getModality("leo")).toBe("fixed");
    expect(getModality("virgo")).toBe("mutable");
  });

  it("getRulingPlanet returns Mars for Aries", () => {
    expect(getRulingPlanet("aries")).toBe("Mars");
  });

  it("signDisplayName capitalizes the first letter", () => {
    expect(signDisplayName("aries")).toBe("Aries");
    expect(signDisplayName("sagittarius")).toBe("Sagittarius");
    expect(signDisplayName("pisces")).toBe("Pisces");
  });
});

// ─── Aspect Functions ────────────────────────────────────

describe("Aspect Functions", () => {
  it("isAspect correctly detects a conjunction (0 degree separation)", () => {
    expect(isAspect(10, 10, 0, 8)).toBe(true);
    expect(isAspect(100, 105, 0, 8)).toBe(true); // within 8° orb
    expect(isAspect(100, 115, 0, 8)).toBe(false); // 15° apart, outside orb
  });

  it("isAspect correctly detects a square (90 degree separation)", () => {
    expect(isAspect(0, 90, 90, 8)).toBe(true);
    expect(isAspect(10, 97, 90, 8)).toBe(true); // 87° ≈ square within orb
    expect(isAspect(0, 80, 90, 8)).toBe(false); // 80° — outside 8° orb
  });

  it("isAspect correctly detects an opposition (180 degree separation)", () => {
    expect(isAspect(0, 180, 180, 8)).toBe(true);
    expect(isAspect(10, 185, 180, 8)).toBe(true); // 175° within orb
    expect(isAspect(0, 165, 180, 8)).toBe(false); // 165° outside orb
  });

  it("isAspect correctly rejects non-aspects", () => {
    // 45° separation is not a conjunction (0°), sextile (60°), square (90°), etc.
    expect(isAspect(0, 45, 0, 8)).toBe(false);
    expect(isAspect(0, 45, 90, 8)).toBe(false);
    expect(isAspect(0, 45, 180, 8)).toBe(false);
  });

  it("isAspect handles wrapping around 360 degrees", () => {
    // 350° and 10° are 20° apart → should detect as conjunction within generous orb
    expect(isAspect(350, 10, 0, 25)).toBe(true);
    // 355° and 5° are 10° apart
    expect(isAspect(355, 5, 0, 12)).toBe(true);
    // Opposition across the wrap point
    expect(isAspect(5, 185, 180, 8)).toBe(true);
  });

  it("getAspectDefinitions returns all 7 standard aspect types", () => {
    const definitions = getAspectDefinitions();
    expect(definitions).toHaveLength(7);

    const ids = definitions.map((d) => d.id);
    expect(ids).toContain("conjunction");
    expect(ids).toContain("sextile");
    expect(ids).toContain("square");
    expect(ids).toContain("trine");
    expect(ids).toContain("opposition");

    // Each definition has required fields
    for (const def of definitions) {
      expect(def.name).toBeTypeOf("string");
      expect(def.symbol).toBeTypeOf("string");
      expect(def.degrees).toBeTypeOf("number");
      expect(def.orb).toBeTypeOf("number");
      expect(def.nature).toBeTypeOf("string");
      expect(def.keywords.length).toBeGreaterThan(0);
      expect(def.description).toBeTypeOf("string");
    }
  });
});

// ─── Natal Chart Calculation ─────────────────────────────

describe("Natal Chart Calculation", () => {
  it("calculateNatalChart returns all required planet positions and angles", () => {
    const chart: NatalChart = calculateNatalChart(ariesBirthData);

    // All 10 planets must be present
    const planetFields = [
      "sun",
      "moon",
      "mercury",
      "venus",
      "mars",
      "jupiter",
      "saturn",
      "uranus",
      "neptune",
      "pluto",
    ] as const;
    for (const planet of planetFields) {
      const pos: PlanetPosition = chart[planet];
      expect(pos.planet).toBe(planet);
      expect(pos.sign).toBeTypeOf("string");
      expect(SIGN_ORDER).toContain(pos.sign);
      expect(pos.degrees).toBeGreaterThanOrEqual(0);
      expect(pos.degrees).toBeLessThan(30);
      expect(pos.totalDegrees).toBeGreaterThanOrEqual(0);
      expect(pos.totalDegrees).toBeLessThan(360);
      expect(pos.house).toBeGreaterThanOrEqual(1);
      expect(pos.house).toBeLessThanOrEqual(12);
      expect(typeof pos.retrograde).toBe("boolean");
    }

    // Ascendant and Midheaven must be present
    const asc: SignPosition = chart.ascendant;
    expect(asc.sign).toBeTypeOf("string");
    expect(SIGN_ORDER).toContain(asc.sign);
    expect(asc.degrees).toBeGreaterThanOrEqual(0);
    expect(asc.degrees).toBeLessThan(30);

    const mc: SignPosition = chart.midheaven;
    expect(mc.sign).toBeTypeOf("string");
    expect(SIGN_ORDER).toContain(mc.sign);

    // Aspects array must exist
    expect(chart.aspects).toBeInstanceOf(Array);
  });

  it("chart has 12 house cusps", () => {
    const chart: NatalChart = calculateNatalChart(ariesBirthData);
    expect(chart.houseCusps).toHaveLength(12);
    for (const cusp of chart.houseCusps) {
      expect(cusp).toBeGreaterThanOrEqual(0);
      expect(cusp).toBeLessThan(360);
    }
  });

  it("calculateAspects detects a conjunction when planets are at the same degree", () => {
    const positions: PlanetPosition[] = [
      {
        planet: "sun",
        sign: "aries",
        degrees: 10,
        totalDegrees: 10,
        house: 1,
        retrograde: false,
      },
      {
        planet: "moon",
        sign: "aries",
        degrees: 10,
        totalDegrees: 10,
        house: 1,
        retrograde: false,
      },
    ];

    const aspects = calculateAspects(positions);
    expect(aspects.length).toBeGreaterThanOrEqual(1);
    const conjunction = aspects.find((a) => a.aspectName === "Conjunction");
    expect(conjunction).toBeDefined();
    expect(conjunction?.planet1).toBe("sun");
    expect(conjunction?.planet2).toBe("moon");
    expect(conjunction?.orb).toBeCloseTo(0, 1);
  });

  it("calculateAspects detects an opposition at 180 degrees", () => {
    const positions: PlanetPosition[] = [
      {
        planet: "sun",
        sign: "aries",
        degrees: 15,
        totalDegrees: 15,
        house: 1,
        retrograde: false,
      },
      {
        planet: "saturn",
        sign: "libra",
        degrees: 15,
        totalDegrees: 195,
        house: 7,
        retrograde: false,
      },
    ];

    const aspects = calculateAspects(positions);
    const opposition = aspects.find((a) => a.aspectName === "Opposition");
    expect(opposition).toBeDefined();
    expect(opposition?.orb).toBeCloseTo(0, 1);
  });
});

// ─── AstrologyEngine Tests ──────────────────────────────

describe("AstrologyEngine", () => {
  const engine = new AstrologyEngine();

  it("startReading creates a valid state with natal chart and reveal order", () => {
    const state = engine.startReading(ariesBirthData);
    expect(state.birthData).toBe(ariesBirthData);
    expect(state.chart).toBeDefined();
    expect(state.chart.sun.sign).toBe("aries");
    expect(state.revealOrder).toHaveLength(11); // sun, moon, ascendant + 8 planets
    expect(state.revealOrder[0]).toBe("sun");
    expect(state.revealedPlanets).toHaveLength(0);
    expect(state.revealIndex).toBe(0);
    expect(state.overviewPresented).toBe(false);
    expect(state.feedback).toHaveLength(0);
    expect(state.startedAt).toBeTypeOf("number");
  });

  it("getNextReveal returns overview first, then Sun", () => {
    const state = engine.startReading(ariesBirthData);

    // First reveal: overview
    const first = engine.getNextReveal(state);
    expect(first).not.toBeNull();
    expect(first?.planet).toBe("overview");
    expect(first?.prompt).toBeTypeOf("string");
    expect(first?.prompt.length).toBeGreaterThan(100);

    // Second reveal: Sun (first in reveal order)
    const second = engine.getNextReveal(state);
    expect(second).not.toBeNull();
    expect(second?.planet).toBe("sun");
    expect(second?.prompt).toBeTypeOf("string");
    expect(second?.prompt.length).toBeGreaterThan(100);

    // Third reveal: Moon
    const third = engine.getNextReveal(state);
    expect(third).not.toBeNull();
    expect(third?.planet).toBe("moon");
  });

  it("recordFeedback stores feedback in a new state object", () => {
    const state = engine.startReading(ariesBirthData);
    const feedback: FeedbackEntry = {
      topic: "sun",
      response: "This resonates deeply with my experience",
      timestamp: Date.now(),
    };

    const updated = engine.recordFeedback(state, feedback);
    expect(updated.feedback).toHaveLength(1);
    expect(updated.feedback[0].topic).toBe("sun");
    expect(updated.feedback[0].response).toBe("This resonates deeply with my experience");

    // New state object returned (not same reference)
    expect(updated).not.toBe(state);
  });

  it("getSynthesis returns a substantive prompt string", () => {
    const state = engine.startReading(cancerBirthData);
    // Reveal a few planets to populate revealedPlanets
    engine.getNextReveal(state); // overview
    engine.getNextReveal(state); // sun
    engine.getNextReveal(state); // moon

    const synthesis = engine.getSynthesis(state);
    expect(synthesis).toBeTypeOf("string");
    expect(synthesis.length).toBeGreaterThan(100);
  });

  it("getNextReveal returns null after all placements are revealed", () => {
    const state = engine.startReading(ariesBirthData);

    // Exhaust all reveals: 1 overview + 11 placements = 12 reveals
    let reveal = engine.getNextReveal(state);
    let count = 0;
    while (reveal !== null) {
      count++;
      reveal = engine.getNextReveal(state);
    }
    // 1 (overview) + 11 (planets/ascendant) = 12
    expect(count).toBe(12);

    // Further calls return null
    expect(engine.getNextReveal(state)).toBeNull();
  });

  it("getSunSign utility returns correct sign without computing full chart", () => {
    expect(engine.getSunSign(3, 25)).toBe("aries");
    expect(engine.getSunSign(7, 4)).toBe("cancer");
    expect(engine.getSunSign(12, 25)).toBe("capricorn");
    expect(engine.getSunSign(1, 15)).toBe("capricorn");
    expect(engine.getSunSign(9, 30)).toBe("libra");
  });
});

// ─── Astrology Data Integrity Tests ──────────

describe("Astrology Data Integrity", () => {
  interface SignDataEntry {
    id: string;
    name: string;
    element: string;
    modality: string;
    rulingPlanet: string;
    traits: string[];
    shadow: string[];
  }

  interface PlanetDataEntry {
    id: string;
    name: string;
    meaningsInSigns: Record<string, string>;
  }

  interface HouseDataEntry {
    number: number;
    naturalSign: string;
    naturalRuler: string;
  }

  const signs = signsData as SignDataEntry[];
  const planets = planetsData as PlanetDataEntry[];
  const houses = housesData as HouseDataEntry[];

  it("all 12 zodiac signs are present in signs.json with complete data", () => {
    expect(signs).toHaveLength(12);
    const signIds = signs.map((s) => s.id);
    for (const expectedSign of SIGN_ORDER) {
      expect(signIds).toContain(expectedSign);
    }
  });

  it("each sign has all required fields: element, modality, rulingPlanet, traits (>3), shadow (>3)", () => {
    for (const sign of signs) {
      expect(sign.element).toBeTypeOf("string");
      expect(sign.element.length).toBeGreaterThan(0);
      expect(sign.modality).toBeTypeOf("string");
      expect(sign.modality.length).toBeGreaterThan(0);
      expect(sign.rulingPlanet).toBeTypeOf("string");
      expect(sign.rulingPlanet.length).toBeGreaterThan(0);
      expect(sign.traits.length).toBeGreaterThan(3);
      expect(sign.shadow.length).toBeGreaterThan(3);
    }
  });

  it("all 10 planets have data in planets.json", () => {
    expect(planets).toHaveLength(10);
    const expectedPlanets = [
      "sun",
      "moon",
      "mercury",
      "venus",
      "mars",
      "jupiter",
      "saturn",
      "uranus",
      "neptune",
      "pluto",
    ];
    const planetIds = planets.map((p) => p.id);
    for (const expected of expectedPlanets) {
      expect(planetIds).toContain(expected);
    }
  });

  it("each planet has meaningsInSigns with all 12 signs", () => {
    for (const planet of planets) {
      expect(planet.meaningsInSigns).toBeDefined();
      const signsWithMeanings = Object.keys(planet.meaningsInSigns);
      for (const sign of SIGN_ORDER) {
        expect(signsWithMeanings).toContain(sign);
        expect(planet.meaningsInSigns[sign].length).toBeGreaterThan(0);
      }
    }
  });

  it("all 12 houses have data with naturalSign and naturalRuler", () => {
    expect(houses).toHaveLength(12);
    for (const house of houses) {
      expect(house.number).toBeGreaterThanOrEqual(1);
      expect(house.number).toBeLessThanOrEqual(12);
      expect(house.naturalSign).toBeTypeOf("string");
      expect(house.naturalSign.length).toBeGreaterThan(0);
      expect(house.naturalRuler).toBeTypeOf("string");
      expect(house.naturalRuler.length).toBeGreaterThan(0);
    }
  });

  it("aspect definitions have proper degrees (conjunction=0, sextile=60, square=90, trine=120, opposition=180)", () => {
    const definitions = getAspectDefinitions();
    const byId = new Map(definitions.map((d) => [d.id, d]));

    expect(byId.get("conjunction")?.degrees).toBe(0);
    expect(byId.get("sextile")?.degrees).toBe(60);
    expect(byId.get("square")?.degrees).toBe(90);
    expect(byId.get("trine")?.degrees).toBe(120);
    expect(byId.get("opposition")?.degrees).toBe(180);
  });
});

// ─── Chart Calculation Edge Cases ────────────

describe("Chart Calculation Edge Cases", () => {
  it("toJulianDay produces known value for J2000.0 epoch (2000-01-01 12:00 = JD 2451545.0)", () => {
    const jd = toJulianDay(2000, 1, 1, 12, 0);
    expect(jd).toBeCloseTo(2451545.0, 1);
  });

  it("calculateSunSign handles December 31 correctly (Capricorn)", () => {
    expect(calculateSunSign(12, 31)).toBe("capricorn");
  });

  it("calculateSunSign handles January 1 correctly (Capricorn)", () => {
    expect(calculateSunSign(1, 1)).toBe("capricorn");
  });

  it("calculateNatalChart for a known date produces reasonable Mercury position (within 30° of Sun)", () => {
    const chart: NatalChart = calculateNatalChart(ariesBirthData);
    const sunDeg = chart.sun.totalDegrees;
    const mercDeg = chart.mercury.totalDegrees;
    // Mercury is always within ~28° of the Sun
    let separation = Math.abs(sunDeg - mercDeg);
    if (separation > 180) separation = 360 - separation;
    expect(separation).toBeLessThanOrEqual(30);
  });

  it("calculateNatalChart for a known date produces reasonable Venus position (within 47° of Sun)", () => {
    const chart: NatalChart = calculateNatalChart(ariesBirthData);
    const sunDeg = chart.sun.totalDegrees;
    const venusDeg = chart.venus.totalDegrees;
    // Venus is always within ~47° of the Sun
    let separation = Math.abs(sunDeg - venusDeg);
    if (separation > 180) separation = 360 - separation;
    expect(separation).toBeLessThanOrEqual(47);
  });

  it("ascendant changes with latitude (polar vs tropical birth location)", () => {
    const tropicalBirth: BirthData = {
      year: 1990,
      month: 6,
      day: 15,
      hour: 12,
      minute: 0,
      latitude: 0,
      longitude: 0,
      timezone: 0,
    };
    const polarBirth: BirthData = {
      year: 1990,
      month: 6,
      day: 15,
      hour: 12,
      minute: 0,
      latitude: 65,
      longitude: 0,
      timezone: 0,
    };
    const tropicalChart = calculateNatalChart(tropicalBirth);
    const polarChart = calculateNatalChart(polarBirth);

    // The ascendant should differ between equator and high latitude
    // for the same time, because the rising sign depends on latitude
    expect(tropicalChart.ascendant.totalDegrees).not.toBeCloseTo(
      polarChart.ascendant.totalDegrees,
      0
    );
  });

  it("house cusps are monotonically increasing (accounting for 360° wrap)", () => {
    const chart: NatalChart = calculateNatalChart(ariesBirthData);
    const cusps = chart.houseCusps;
    expect(cusps).toHaveLength(12);

    // With equal house system, each cusp should be 30° from the previous
    for (let i = 0; i < 12; i++) {
      const current = cusps[i];
      const next = cusps[(i + 1) % 12];
      let diff = next - current;
      if (diff < 0) diff += 360;
      // Each house should span approximately 30° (equal house system)
      expect(diff).toBeCloseTo(30, 0);
    }
  });
});

// ─── Interpreter Prompt Tests ────────────────

describe("Astrology Interpreter Prompts", () => {
  const chart: NatalChart = calculateNatalChart(ariesBirthData);
  const emptyFeedback: FeedbackEntry[] = [];

  it("buildChartOverviewPrompt includes the sun sign", () => {
    const prompt = buildChartOverviewPrompt(chart, emptyFeedback);
    expect(prompt).toContain("Aries");
  });

  it("buildPlanetInterpretationPrompt includes the planet name and sign", () => {
    const prompt = buildPlanetInterpretationPrompt(chart.sun, chart, emptyFeedback);
    expect(prompt).toContain("Sun");
    expect(prompt).toContain("Aries");
  });

  it("buildAstrologySynthesisPrompt includes revealed planet names", () => {
    const revealed = ["sun", "moon", "mercury"];
    const prompt = buildAstrologySynthesisPrompt(chart, revealed, emptyFeedback);
    expect(prompt).toContain("Sun");
    expect(prompt).toContain("Moon");
    expect(prompt).toContain("Mercury");
  });

  it("prompts with feedback include the feedback text", () => {
    const feedback: FeedbackEntry[] = [
      {
        topic: "sun",
        response: "This resonates deeply with my experience",
        timestamp: Date.now(),
      },
    ];

    const overviewPrompt = buildChartOverviewPrompt(chart, feedback);
    expect(overviewPrompt).toContain("This resonates deeply with my experience");

    const planetPrompt = buildPlanetInterpretationPrompt(chart.sun, chart, feedback);
    expect(planetPrompt).toContain("This resonates deeply with my experience");

    const synthPrompt = buildAstrologySynthesisPrompt(chart, ["sun"], feedback);
    expect(synthPrompt).toContain("This resonates deeply with my experience");
  });
});

// ─── AstrologyEngine Additional Tests ────────

describe("AstrologyEngine Additional", () => {
  const engine = new AstrologyEngine();

  it("reveal order is: overview, sun, moon, ascendant, mercury, venus, mars, jupiter, saturn, uranus, neptune, pluto", () => {
    const state = engine.startReading(ariesBirthData);
    const revealedOrder: string[] = [];

    let reveal = engine.getNextReveal(state);
    while (reveal !== null) {
      revealedOrder.push(reveal.planet);
      reveal = engine.getNextReveal(state);
    }

    expect(revealedOrder).toEqual([
      "overview",
      "sun",
      "moon",
      "ascendant",
      "mercury",
      "venus",
      "mars",
      "jupiter",
      "saturn",
      "uranus",
      "neptune",
      "pluto",
    ]);
  });

  it("recording feedback between reveals doesn't change reveal order", () => {
    const state = engine.startReading(ariesBirthData);
    const revealedOrder: string[] = [];

    // Reveal overview
    const overview = engine.getNextReveal(state);
    expect(overview).not.toBeNull();
    revealedOrder.push(overview?.planet);

    // Record feedback after overview
    let currentState = engine.recordFeedback(state, {
      topic: "overview",
      response: "Very interesting chart overview",
      timestamp: Date.now(),
    });

    // The engine mutates state internally for reveal tracking, so we
    // continue using the original state object for getNextReveal
    const sun = engine.getNextReveal(state);
    expect(sun).not.toBeNull();
    revealedOrder.push(sun?.planet);

    // Record feedback after sun
    currentState = engine.recordFeedback(currentState, {
      topic: "sun",
      response: "Sun sign description is accurate",
      timestamp: Date.now(),
    });

    // Continue revealing
    let reveal = engine.getNextReveal(state);
    while (reveal !== null) {
      revealedOrder.push(reveal.planet);
      reveal = engine.getNextReveal(state);
    }

    expect(revealedOrder).toEqual([
      "overview",
      "sun",
      "moon",
      "ascendant",
      "mercury",
      "venus",
      "mars",
      "jupiter",
      "saturn",
      "uranus",
      "neptune",
      "pluto",
    ]);
  });

  it("multiple charts for different birth data produce different sun signs (Aries vs Cancer test data)", () => {
    const ariesState = engine.startReading(ariesBirthData);
    const cancerState = engine.startReading(cancerBirthData);

    expect(ariesState.chart.sun.sign).toBe("aries");
    expect(cancerState.chart.sun.sign).toBe("cancer");
    expect(ariesState.chart.sun.sign).not.toBe(cancerState.chart.sun.sign);
  });
});
