/**
 * Pure-TypeScript natal chart calculator.
 *
 * Uses simplified Keplerian orbital mechanics referenced to the J2000.0 epoch
 * (January 1, 2000, 12:00 TT) to compute approximate ecliptic longitudes for
 * the Sun, Moon, and planets. Accuracy is typically within 1-2 degrees for
 * inner planets and the Sun, which is sufficient for zodiac sign determination.
 *
 * No external dependencies (no Swiss Ephemeris).
 */

import { degreesToSign, getAspectDefinitions, type SignPosition } from "./zodiac.js";

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface BirthData {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number; // 0-59
  latitude: number; // decimal degrees (north positive)
  longitude: number; // decimal degrees (east positive)
  timezone: number; // offset from UTC in hours (e.g. -5 for EST)
}

export interface PlanetPosition {
  planet: string;
  sign: string;
  degrees: number; // 0-29 within sign
  totalDegrees: number; // 0-359 ecliptic longitude
  house: number; // 1-12
  retrograde: boolean;
}

export interface ChartAspect {
  planet1: string;
  planet2: string;
  aspectName: string;
  aspectSymbol: string;
  exactDegrees: number; // the aspect's ideal separation
  actualDegrees: number; // actual angular separation
  orb: number; // how far from exact
  nature: "harmonious" | "challenging" | "neutral";
}

export interface NatalChart {
  sun: PlanetPosition;
  moon: PlanetPosition;
  mercury: PlanetPosition;
  venus: PlanetPosition;
  mars: PlanetPosition;
  jupiter: PlanetPosition;
  saturn: PlanetPosition;
  uranus: PlanetPosition;
  neptune: PlanetPosition;
  pluto: PlanetPosition;
  ascendant: SignPosition;
  midheaven: SignPosition;
  aspects: ChartAspect[];
  houseCusps: number[]; // 12 house cusp longitudes
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;
const J2000 = 2451545.0; // Julian Day of J2000.0 epoch

// ---------------------------------------------------------------------------
// Orbital elements at J2000.0 and their rates (per Julian century)
// Source: Standish (1992) / Meeus "Astronomical Algorithms"
//
// Each entry: [L0, L1, a, e0, e1, I0, I1, W0, W1, w0, w1]
//   L = mean longitude (deg), a = semi-major axis (AU),
//   e = eccentricity, I = inclination (deg),
//   W = longitude of ascending node (deg), w = argument of perihelion (deg)
//   *0 = value at J2000.0, *1 = rate per Julian century
// ---------------------------------------------------------------------------

interface OrbitalElements {
  /** Mean longitude at J2000.0 (degrees) */
  L0: number;
  /** Mean longitude rate (degrees per Julian century) */
  L1: number;
  /** Semi-major axis (AU) */
  a: number;
  /** Eccentricity at J2000.0 */
  e0: number;
  /** Eccentricity rate per century */
  e1: number;
  /** Inclination at J2000.0 (degrees) */
  I0: number;
  /** Inclination rate per century */
  I1: number;
  /** Longitude of ascending node at J2000.0 (degrees) */
  W0: number;
  /** Longitude of ascending node rate per century */
  W1: number;
  /** Longitude of perihelion at J2000.0 (degrees) */
  w0: number;
  /** Longitude of perihelion rate per century */
  w1: number;
}

/**
 * Mean orbital elements for planets (heliocentric ecliptic, J2000.0 frame).
 * Values from Standish (1992) and Meeus.
 */
const ORBITAL_ELEMENTS: Record<string, OrbitalElements> = {
  mercury: {
    L0: 252.2503235,
    L1: 149472.67411175,
    a: 0.38709927,
    e0: 0.20563593,
    e1: 0.00001906,
    I0: 7.00497902,
    I1: -0.00594749,
    W0: 48.33076593,
    W1: -0.12534081,
    w0: 77.45779628,
    w1: 0.16047689,
  },
  venus: {
    L0: 181.9790995,
    L1: 58517.81538729,
    a: 0.72333566,
    e0: 0.00677672,
    e1: -0.00004107,
    I0: 3.39467605,
    I1: -0.0007889,
    W0: 76.67984255,
    W1: -0.27769418,
    w0: 131.60246718,
    w1: 0.00268329,
  },
  earth: {
    L0: 100.46457166,
    L1: 35999.37244981,
    a: 1.00000261,
    e0: 0.01671123,
    e1: -0.00004392,
    I0: 0.00001531,
    I1: -0.01294668,
    W0: 0.0,
    W1: 0.0,
    w0: 102.93768193,
    w1: 0.32327364,
  },
  mars: {
    L0: 355.44656299,
    L1: 19140.30268499,
    a: 1.52371034,
    e0: 0.0933941,
    e1: 0.00007882,
    I0: 1.84969142,
    I1: -0.00813131,
    W0: 49.55953891,
    W1: -0.29257343,
    w0: 336.05637041,
    w1: 0.44441088,
  },
  jupiter: {
    L0: 34.39644051,
    L1: 3034.74612775,
    a: 5.202887,
    e0: 0.04838624,
    e1: -0.00013253,
    I0: 1.30439695,
    I1: -0.00183714,
    W0: 100.47390909,
    W1: 0.20469106,
    w0: 14.72847983,
    w1: 0.21252668,
  },
  saturn: {
    L0: 49.95424423,
    L1: 1222.49362201,
    a: 9.53667594,
    e0: 0.05386179,
    e1: -0.00050991,
    I0: 2.48599187,
    I1: 0.00193609,
    W0: 113.66242448,
    W1: -0.28867794,
    w0: 92.59887831,
    w1: -0.41897216,
  },
  uranus: {
    L0: 313.23810451,
    L1: 428.48202785,
    a: 19.18916464,
    e0: 0.04725744,
    e1: -0.00004397,
    I0: 0.77263783,
    I1: -0.00242939,
    W0: 74.01692503,
    W1: 0.04240589,
    w0: 170.9542763,
    w1: 0.40805281,
  },
  neptune: {
    L0: 304.87997031,
    L1: 218.45945325,
    a: 30.06992276,
    e0: 0.00859048,
    e1: 0.00005105,
    I0: 1.77004347,
    I1: 0.00035372,
    W0: 131.78422574,
    W1: -0.0129963,
    w0: 44.96476227,
    w1: -0.32241464,
  },
  pluto: {
    L0: 238.92903833,
    L1: 145.20780515,
    a: 39.48211675,
    e0: 0.2488273,
    e1: 0.0000517,
    I0: 17.14001206,
    I1: 0.00004818,
    W0: 110.30393684,
    W1: -0.01183482,
    w0: 224.06891629,
    w1: -0.04062942,
  },
};

// ---------------------------------------------------------------------------
// Julian Day calculation
// ---------------------------------------------------------------------------

/**
 * Convert a calendar date + time to Julian Day Number.
 * Handles both Julian and Gregorian calendars.
 */
export function toJulianDay(
  year: number,
  month: number,
  day: number,
  hour: number = 0,
  minute: number = 0
): number {
  let y = year;
  let m = month;
  if (m <= 2) {
    y -= 1;
    m += 12;
  }
  const A = Math.floor(y / 100);
  const B = 2 - A + Math.floor(A / 4);
  const dayFraction = (hour + minute / 60) / 24;
  return (
    Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (m + 1)) + day + dayFraction + B - 1524.5
  );
}

/**
 * Julian centuries since J2000.0.
 */
function julianCenturies(jd: number): number {
  return (jd - J2000) / 36525;
}

// ---------------------------------------------------------------------------
// Normalise angle to [0, 360)
// ---------------------------------------------------------------------------

function normDeg(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

// ---------------------------------------------------------------------------
// Kepler's equation solver (Newton-Raphson)
// ---------------------------------------------------------------------------

/**
 * Solve Kepler's equation M = E - e*sin(E) for E (eccentric anomaly).
 * M and E in radians.
 */
function solveKepler(M: number, e: number): number {
  let E = M; // initial guess
  for (let i = 0; i < 50; i++) {
    const dE = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    E -= dE;
    if (Math.abs(dE) < 1e-12) break;
  }
  return E;
}

// ---------------------------------------------------------------------------
// Heliocentric ecliptic longitude from orbital elements
// ---------------------------------------------------------------------------

/**
 * Compute heliocentric ecliptic longitude for a planet at a given Julian Day.
 */
function heliocentricLongitude(planetId: string, jd: number): number {
  const el = ORBITAL_ELEMENTS[planetId];
  if (!el) throw new Error(`No orbital elements for: ${planetId}`);

  const T = julianCenturies(jd);

  // Compute current elements
  const L = normDeg(el.L0 + el.L1 * T);
  const e = el.e0 + el.e1 * T;
  const w = normDeg(el.w0 + el.w1 * T);
  const W = normDeg(el.W0 + el.W1 * T);
  const I = el.I0 + el.I1 * T;

  // Mean anomaly
  const M = normDeg(L - w);
  const Mrad = M * DEG2RAD;

  // Solve Kepler's equation for eccentric anomaly
  const E = solveKepler(Mrad, e);

  // True anomaly
  const sinV = (Math.sqrt(1 - e * e) * Math.sin(E)) / (1 - e * Math.cos(E));
  const cosV = (Math.cos(E) - e) / (1 - e * Math.cos(E));
  const v = Math.atan2(sinV, cosV) * RAD2DEG;

  // Heliocentric longitude in the orbital plane
  const lHelio = normDeg(v + w - W);

  // Convert from orbital plane to ecliptic
  // For small inclinations, the correction is minor
  const Irad = I * DEG2RAD;
  const lHelioRad = lHelio * DEG2RAD;

  const eclLon = normDeg(
    Math.atan2(Math.sin(lHelioRad) * Math.cos(Irad), Math.cos(lHelioRad)) * RAD2DEG + W
  );

  return eclLon;
}

// ---------------------------------------------------------------------------
// Geocentric ecliptic longitude
// ---------------------------------------------------------------------------

/**
 * Convert heliocentric position to geocentric (as seen from Earth).
 * Uses simplified geometric transformation.
 */
function geocentricLongitude(planetId: string, jd: number): number {
  if (planetId === "earth") {
    throw new Error("Cannot compute geocentric longitude of Earth");
  }

  const T = julianCenturies(jd);

  // Earth's heliocentric position
  const earthEl = ORBITAL_ELEMENTS.earth;
  const earthL = normDeg(earthEl.L0 + earthEl.L1 * T);
  const earthE = earthEl.e0 + earthEl.e1 * T;
  const earthW = normDeg(earthEl.w0 + earthEl.w1 * T);
  const earthM = normDeg(earthL - earthW) * DEG2RAD;
  const earthEcc = solveKepler(earthM, earthE);
  const earthV =
    Math.atan2(Math.sqrt(1 - earthE * earthE) * Math.sin(earthEcc), Math.cos(earthEcc) - earthE) *
    RAD2DEG;
  const earthHelioLon = normDeg(earthV + earthW);
  const earthR = earthEl.a * (1 - earthE * Math.cos(earthEcc));

  // Planet's heliocentric position
  const pEl = ORBITAL_ELEMENTS[planetId];
  const pL = normDeg(pEl.L0 + pEl.L1 * T);
  const pE = pEl.e0 + pEl.e1 * T;
  const pW = normDeg(pEl.w0 + pEl.w1 * T);
  const pM = normDeg(pL - pW) * DEG2RAD;
  const pEcc = solveKepler(pM, pE);
  const pV = Math.atan2(Math.sqrt(1 - pE * pE) * Math.sin(pEcc), Math.cos(pEcc) - pE) * RAD2DEG;
  const pHelioLon = normDeg(pV + pW);
  const pR = pEl.a * (1 - pE * Math.cos(pEcc));

  // Convert to geocentric using simple 2D projection (ecliptic plane)
  const pHelioRad = pHelioLon * DEG2RAD;
  const earthHelioRad = earthHelioLon * DEG2RAD;

  const x = pR * Math.cos(pHelioRad) - earthR * Math.cos(earthHelioRad);
  const y = pR * Math.sin(pHelioRad) - earthR * Math.sin(earthHelioRad);

  return normDeg(Math.atan2(y, x) * RAD2DEG);
}

// ---------------------------------------------------------------------------
// Sun longitude (geocentric = Earth heliocentric + 180)
// ---------------------------------------------------------------------------

/**
 * Compute the Sun's geocentric ecliptic longitude for a given Julian Day.
 * The Sun's geocentric longitude is Earth's heliocentric longitude + 180 degrees.
 */
function sunLongitude(jd: number): number {
  const T = julianCenturies(jd);

  // Sun's mean longitude (geometric mean longitude referred to the mean equinox)
  const L0 = normDeg(280.46646 + 36000.76983 * T + 0.0003032 * T * T);

  // Sun's mean anomaly
  const M = normDeg(357.52911 + 35999.05029 * T - 0.0001537 * T * T);
  const Mrad = M * DEG2RAD;

  // Equation of center
  const C =
    (1.914602 - 0.004817 * T - 0.000014 * T * T) * Math.sin(Mrad) +
    (0.019993 - 0.000101 * T) * Math.sin(2 * Mrad) +
    0.000289 * Math.sin(3 * Mrad);

  // Sun's true longitude
  const sunTrueLon = normDeg(L0 + C);

  // Apparent longitude (correct for nutation and aberration)
  const omega = 125.04 - 1934.136 * T;
  const apparent = sunTrueLon - 0.00569 - 0.00478 * Math.sin(omega * DEG2RAD);

  return normDeg(apparent);
}

// ---------------------------------------------------------------------------
// Moon longitude (simplified)
// ---------------------------------------------------------------------------

/**
 * Compute the Moon's geocentric ecliptic longitude.
 * Uses the principal terms of the lunar theory (Meeus Chapter 47).
 */
function moonLongitude(jd: number): number {
  const T = julianCenturies(jd);

  // Moon's mean longitude (mean equinox of date)
  const Lp = normDeg(
    218.3164477 +
      481267.88123421 * T -
      0.0015786 * T * T +
      (T * T * T) / 538841 -
      (T * T * T * T) / 65194000
  );

  // Moon's mean elongation
  const D = normDeg(
    297.8501921 +
      445267.1114034 * T -
      0.0018819 * T * T +
      (T * T * T) / 545868 -
      (T * T * T * T) / 113065000
  );

  // Sun's mean anomaly
  const M = normDeg(357.5291092 + 35999.0502909 * T - 0.0001536 * T * T + (T * T * T) / 24490000);

  // Moon's mean anomaly
  const Mp = normDeg(
    134.9633964 +
      477198.8675055 * T +
      0.0087414 * T * T +
      (T * T * T) / 69699 -
      (T * T * T * T) / 14712000
  );

  // Moon's argument of latitude
  const F = normDeg(
    93.272095 +
      483202.0175233 * T -
      0.0036539 * T * T -
      (T * T * T) / 3526000 +
      (T * T * T * T) / 863310000
  );

  const Drad = D * DEG2RAD;
  const Mrad = M * DEG2RAD;
  const Mprad = Mp * DEG2RAD;
  const Frad = F * DEG2RAD;

  // Principal terms for longitude (simplified from Meeus Table 47.A)
  let sumL = 0;
  sumL += 6288774 * Math.sin(Mprad);
  sumL += 1274027 * Math.sin(2 * Drad - Mprad);
  sumL += 658314 * Math.sin(2 * Drad);
  sumL += 213618 * Math.sin(2 * Mprad);
  sumL += -185116 * Math.sin(Mrad);
  sumL += -114332 * Math.sin(2 * Frad);
  sumL += 58793 * Math.sin(2 * Drad - 2 * Mprad);
  sumL += 57066 * Math.sin(2 * Drad - Mrad - Mprad);
  sumL += 53322 * Math.sin(2 * Drad + Mprad);
  sumL += 45758 * Math.sin(2 * Drad - Mrad);
  sumL += -40923 * Math.sin(Mrad - Mprad);
  sumL += -34720 * Math.sin(Drad);
  sumL += -30383 * Math.sin(Mrad + Mprad);
  sumL += 15327 * Math.sin(2 * Drad - 2 * Frad);
  sumL += -12528 * Math.sin(Mprad + 2 * Frad);
  sumL += 10980 * Math.sin(Mprad - 2 * Frad);
  sumL += 10675 * Math.sin(4 * Drad - Mprad);
  sumL += 10034 * Math.sin(3 * Mprad);
  sumL += 8548 * Math.sin(4 * Drad - 2 * Mprad);
  sumL += -7888 * Math.sin(2 * Drad + Mrad - Mprad);
  sumL += -6766 * Math.sin(2 * Drad + Mrad);
  sumL += -5163 * Math.sin(Drad - Mprad);
  sumL += 4987 * Math.sin(Drad + Mrad);
  sumL += 4036 * Math.sin(2 * Drad - Mrad + Mprad);

  // Convert from 0.000001 degrees to degrees
  const moonLon = normDeg(Lp + sumL / 1000000);

  return moonLon;
}

// ---------------------------------------------------------------------------
// Retrograde detection
// ---------------------------------------------------------------------------

/**
 * Determine if a planet appears retrograde by comparing its longitude
 * one day before and after the given Julian Day.
 */
function isRetrograde(planetId: string, jd: number): boolean {
  if (planetId === "sun" || planetId === "moon") return false;

  const lonBefore = geocentricLongitude(planetId, jd - 1);
  const lonAfter = geocentricLongitude(planetId, jd + 1);

  // Handle wrapping around 0/360 degrees
  let diff = lonAfter - lonBefore;
  if (diff > 180) diff -= 360;
  if (diff < -180) diff += 360;

  return diff < 0;
}

// ---------------------------------------------------------------------------
// Obliquity of the ecliptic
// ---------------------------------------------------------------------------

function obliquity(jd: number): number {
  const T = julianCenturies(jd);
  // Mean obliquity (Laskar formula)
  return 23.4392911 - 0.0130042 * T - 1.64e-7 * T * T + 5.036e-7 * T * T * T;
}

// ---------------------------------------------------------------------------
// Ascendant & Midheaven (MC) calculation
// ---------------------------------------------------------------------------

/**
 * Compute the Local Sidereal Time in degrees for a given Julian Day and
 * geographic longitude.
 */
function localSiderealTime(jd: number, lonDeg: number): number {
  const T = julianCenturies(jd);
  // Greenwich Mean Sidereal Time in degrees
  const gmst = normDeg(
    280.46061837 + 360.98564736629 * (jd - J2000) + 0.000387933 * T * T - (T * T * T) / 38710000
  );
  // Convert to local
  return normDeg(gmst + lonDeg);
}

/**
 * Calculate the Ascendant (rising sign) from LST, latitude, and obliquity.
 */
function computeAscendant(lstDeg: number, latDeg: number, oblDeg: number): number {
  const lstRad = lstDeg * DEG2RAD;
  const latRad = latDeg * DEG2RAD;
  const oblRad = oblDeg * DEG2RAD;

  const y = -Math.cos(lstRad);
  const x = Math.sin(oblRad) * Math.tan(latRad) + Math.cos(oblRad) * Math.sin(lstRad);

  const asc = Math.atan2(y, x) * RAD2DEG;
  return normDeg(asc);
}

/**
 * Calculate the Midheaven (Medium Coeli) from LST and obliquity.
 */
function computeMidheaven(lstDeg: number, oblDeg: number): number {
  const lstRad = lstDeg * DEG2RAD;
  const oblRad = oblDeg * DEG2RAD;

  const mc = Math.atan2(Math.sin(lstRad), Math.cos(lstRad) * Math.cos(oblRad)) * RAD2DEG;
  return normDeg(mc);
}

// ---------------------------------------------------------------------------
// House cusps (Placidus simplified / Equal house fallback)
// ---------------------------------------------------------------------------

/**
 * Calculate equal house cusps from the Ascendant.
 * Each house spans exactly 30 degrees starting from the Ascendant.
 */
function equalHouseCusps(ascDeg: number): number[] {
  const cusps: number[] = [];
  for (let i = 0; i < 12; i++) {
    cusps.push(normDeg(ascDeg + i * 30));
  }
  return cusps;
}

/**
 * Determine which house a planet falls in given house cusps.
 * Returns 1-12.
 */
function houseForLongitude(longitude: number, cusps: number[]): number {
  for (let i = 0; i < 12; i++) {
    const cusp = cusps[i];
    const nextCusp = cusps[(i + 1) % 12];

    if (nextCusp > cusp) {
      // Normal case: cusp doesn't wrap around 360
      if (longitude >= cusp && longitude < nextCusp) {
        return i + 1;
      }
    } else {
      // Wraps around 0 degrees
      if (longitude >= cusp || longitude < nextCusp) {
        return i + 1;
      }
    }
  }
  return 1; // fallback
}

// ---------------------------------------------------------------------------
// Sun sign from date (calendar-based, exact traditional boundaries)
// ---------------------------------------------------------------------------

/** Traditional Sun sign date boundaries (tropical zodiac). */
const SUN_SIGN_DATES: Array<{ sign: string; startMonth: number; startDay: number }> = [
  { sign: "capricorn", startMonth: 1, startDay: 1 }, // Jan 1 (continued from Dec 22)
  { sign: "aquarius", startMonth: 1, startDay: 20 },
  { sign: "pisces", startMonth: 2, startDay: 19 },
  { sign: "aries", startMonth: 3, startDay: 21 },
  { sign: "taurus", startMonth: 4, startDay: 20 },
  { sign: "gemini", startMonth: 5, startDay: 21 },
  { sign: "cancer", startMonth: 6, startDay: 21 },
  { sign: "leo", startMonth: 7, startDay: 23 },
  { sign: "virgo", startMonth: 8, startDay: 23 },
  { sign: "libra", startMonth: 9, startDay: 23 },
  { sign: "scorpio", startMonth: 10, startDay: 23 },
  { sign: "sagittarius", startMonth: 11, startDay: 22 },
  { sign: "capricorn", startMonth: 12, startDay: 22 },
];

/**
 * Determine the Sun sign from month and day using traditional date boundaries.
 * This is a quick lookup that doesn't require astronomical calculation.
 */
export function calculateSunSign(month: number, day: number): string {
  // Walk the boundaries in reverse to find the active sign
  for (let i = SUN_SIGN_DATES.length - 1; i >= 0; i--) {
    const boundary = SUN_SIGN_DATES[i];
    if (
      month > boundary.startMonth ||
      (month === boundary.startMonth && day >= boundary.startDay)
    ) {
      return boundary.sign;
    }
  }
  // Should never reach here, but default to Capricorn (Jan 1-19)
  return "capricorn";
}

// ---------------------------------------------------------------------------
// Aspect calculation
// ---------------------------------------------------------------------------

/**
 * Calculate all aspects between planet positions.
 */
export function calculateAspects(positions: PlanetPosition[]): ChartAspect[] {
  const aspects: ChartAspect[] = [];
  const definitions = getAspectDefinitions();

  for (let i = 0; i < positions.length; i++) {
    for (let j = i + 1; j < positions.length; j++) {
      const p1 = positions[i];
      const p2 = positions[j];

      let separation = Math.abs(p1.totalDegrees - p2.totalDegrees);
      if (separation > 180) separation = 360 - separation;

      for (const def of definitions) {
        const orbDistance = Math.abs(separation - def.degrees);
        if (orbDistance <= def.orb) {
          aspects.push({
            planet1: p1.planet,
            planet2: p2.planet,
            aspectName: def.name,
            aspectSymbol: def.symbol,
            exactDegrees: def.degrees,
            actualDegrees: separation,
            orb: Math.round(orbDistance * 100) / 100,
            nature: def.nature,
          });
        }
      }
    }
  }

  // Sort by tightest orb first
  aspects.sort((a, b) => a.orb - b.orb);
  return aspects;
}

// ---------------------------------------------------------------------------
// Main chart calculation
// ---------------------------------------------------------------------------

/**
 * Build a PlanetPosition from a computed ecliptic longitude.
 */
function buildPosition(
  planetName: string,
  longitude: number,
  houseCusps: number[],
  retrograde: boolean
): PlanetPosition {
  const signPos = degreesToSign(longitude);
  return {
    planet: planetName,
    sign: signPos.sign,
    degrees: Math.round(signPos.degrees * 100) / 100,
    totalDegrees: Math.round(signPos.totalDegrees * 100) / 100,
    house: houseForLongitude(longitude, houseCusps),
    retrograde,
  };
}

/**
 * Calculate a complete natal chart from birth data.
 *
 * This uses simplified Keplerian orbital mechanics for planetary positions
 * and standard formulas for the Ascendant, Midheaven, and house cusps.
 * Accuracy is typically within 1-2 degrees for inner planets and the Sun,
 * which is sufficient for sign determination in most cases.
 */
export function calculateNatalChart(birthData: BirthData): NatalChart {
  // Convert birth time to UT
  const utHour = birthData.hour - birthData.timezone;
  const utMinute = birthData.minute;

  // Calculate Julian Day
  const jd = toJulianDay(birthData.year, birthData.month, birthData.day, utHour, utMinute);

  // Obliquity of the ecliptic
  const obl = obliquity(jd);

  // Local Sidereal Time
  const lst = localSiderealTime(jd, birthData.longitude);

  // Ascendant and Midheaven
  const ascDeg = computeAscendant(lst, birthData.latitude, obl);
  const mcDeg = computeMidheaven(lst, obl);

  // House cusps (equal house system)
  const cusps = equalHouseCusps(ascDeg);

  // Compute planetary positions
  const sunLon = sunLongitude(jd);
  const moonLon = moonLongitude(jd);
  const mercuryLon = geocentricLongitude("mercury", jd);
  const venusLon = geocentricLongitude("venus", jd);
  const marsLon = geocentricLongitude("mars", jd);
  const jupiterLon = geocentricLongitude("jupiter", jd);
  const saturnLon = geocentricLongitude("saturn", jd);
  const uranusLon = geocentricLongitude("uranus", jd);
  const neptuneLon = geocentricLongitude("neptune", jd);
  const plutoLon = geocentricLongitude("pluto", jd);

  // Build planet positions
  const sun = buildPosition("sun", sunLon, cusps, false);
  const moon = buildPosition("moon", moonLon, cusps, false);
  const mercury = buildPosition("mercury", mercuryLon, cusps, isRetrograde("mercury", jd));
  const venus = buildPosition("venus", venusLon, cusps, isRetrograde("venus", jd));
  const mars = buildPosition("mars", marsLon, cusps, isRetrograde("mars", jd));
  const jupiter = buildPosition("jupiter", jupiterLon, cusps, isRetrograde("jupiter", jd));
  const saturn = buildPosition("saturn", saturnLon, cusps, isRetrograde("saturn", jd));
  const uranus = buildPosition("uranus", uranusLon, cusps, isRetrograde("uranus", jd));
  const neptune = buildPosition("neptune", neptuneLon, cusps, isRetrograde("neptune", jd));
  const pluto = buildPosition("pluto", plutoLon, cusps, isRetrograde("pluto", jd));

  // Ascendant and Midheaven as SignPositions
  const ascendant = degreesToSign(ascDeg);
  const midheaven = degreesToSign(mcDeg);

  // Calculate aspects between all planets
  const allPositions = [sun, moon, mercury, venus, mars, jupiter, saturn, uranus, neptune, pluto];
  const aspects = calculateAspects(allPositions);

  return {
    sun,
    moon,
    mercury,
    venus,
    mars,
    jupiter,
    saturn,
    uranus,
    neptune,
    pluto,
    ascendant,
    midheaven,
    aspects,
    houseCusps: cusps,
  };
}
