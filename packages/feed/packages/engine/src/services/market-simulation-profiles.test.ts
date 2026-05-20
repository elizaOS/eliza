import { describe, expect, it } from "bun:test";
import {
  buildMarketSimulationProfile,
  createInitialMarketSimulationState,
  evolveGlobalMarketSimulationState,
  generateProfileDrivenMarketMove,
  getDefaultGlobalMarketSimulationState,
} from "./market-simulation-profiles";

describe("market-simulation-profiles", () => {
  it("builds deterministic profiles for the same market", () => {
    const input = {
      organizationId: "openagi",
      ticker: "OPENAGI",
      organization: {
        type: "company" as const,
        name: "OpenAGI",
        description: "AI research company",
      },
    };

    expect(buildMarketSimulationProfile(input)).toEqual(
      buildMarketSimulationProfile(input),
    );
  });

  it("gives different organization types different baseline behavior", () => {
    const company = buildMarketSimulationProfile({
      organizationId: "openagi",
      ticker: "OPENAGI",
      organization: {
        type: "company",
        name: "OpenAGI",
        description: "AI company",
      },
    });
    const media = buildMarketSimulationProfile({
      organizationId: "ainbc",
      ticker: "AINBC",
      organization: {
        type: "media",
        name: "AINBC",
        description: "Media outlet",
      },
    });

    expect(media.baseVolatility).toBeGreaterThan(company.baseVolatility);
    expect(media.jumpChance).toBeGreaterThan(company.jumpChance);
  });

  it("keeps simulated moves inside the profile max tick move", () => {
    const profile = buildMarketSimulationProfile({
      organizationId: "openagi",
      ticker: "OPENAGI",
      organization: {
        type: "company",
        name: "OpenAGI",
        description: "AI company",
      },
    });
    const state = createInitialMarketSimulationState(100, profile);
    const globalState = getDefaultGlobalMarketSimulationState();
    const sequence = [0.9, 0.8, 0.7, 0.6, 0.95, 0.85, 0.75, 0.65];
    let index = 0;

    const { move } = generateProfileDrivenMarketMove({
      state,
      profile,
      globalState,
      currentPrice: 100,
      openInterest: 5000,
      rng: () => sequence[index++ % sequence.length]!,
    });

    expect(Math.abs(move)).toBeLessThanOrEqual(profile.maxTickMove);
  });

  it("dampens noise when open interest is deeper", () => {
    const profile = buildMarketSimulationProfile({
      organizationId: "openagi",
      ticker: "OPENAGI",
      organization: {
        type: "company",
        name: "OpenAGI",
        description: "AI company",
      },
    });
    const globalState = evolveGlobalMarketSimulationState(
      getDefaultGlobalMarketSimulationState(),
      () => 0.5,
    );
    const sequence = [0.99, 0.98, 0.97, 0.96, 0.4, 0.99, 0.98, 0.97];

    const lowOiMove = generateProfileDrivenMarketMove({
      state: createInitialMarketSimulationState(100, profile),
      profile,
      globalState,
      currentPrice: 100,
      openInterest: 500,
      rng: (() => {
        let index = 0;
        return () => sequence[index++ % sequence.length]!;
      })(),
    }).move;

    const highOiMove = generateProfileDrivenMarketMove({
      state: createInitialMarketSimulationState(100, profile),
      profile,
      globalState,
      currentPrice: 100,
      openInterest: 250000,
      rng: (() => {
        let index = 0;
        return () => sequence[index++ % sequence.length]!;
      })(),
    }).move;

    expect(Math.abs(lowOiMove)).toBeGreaterThan(Math.abs(highOiMove));
  });

  it("uses latent price carried from prior ticks", () => {
    const profile = buildMarketSimulationProfile({
      organizationId: "openagi",
      ticker: "OPENAGI",
      organization: {
        type: "company",
        name: "OpenAGI",
        description: "AI company",
      },
    });
    const globalState = getDefaultGlobalMarketSimulationState();
    const lowLatentState = createInitialMarketSimulationState(100, profile);
    const highLatentState = createInitialMarketSimulationState(100, profile);
    lowLatentState.latentPrice = 80;
    highLatentState.latentPrice = 120;
    const sequence = [0.91, 0.82, 0.73, 0.64, 0.55, 0.46, 0.37, 0.28];

    const lowLatentMove = generateProfileDrivenMarketMove({
      state: lowLatentState,
      profile,
      globalState,
      currentPrice: 100,
      openInterest: 5000,
      rng: (() => {
        let index = 0;
        return () => sequence[index++ % sequence.length]!;
      })(),
    });

    const highLatentMove = generateProfileDrivenMarketMove({
      state: highLatentState,
      profile,
      globalState,
      currentPrice: 100,
      openInterest: 5000,
      rng: (() => {
        let index = 0;
        return () => sequence[index++ % sequence.length]!;
      })(),
    });

    expect(lowLatentMove.move).not.toBe(highLatentMove.move);
    expect(lowLatentMove.nextState.latentPrice).toBeLessThan(
      highLatentMove.nextState.latentPrice,
    );
  });
});
