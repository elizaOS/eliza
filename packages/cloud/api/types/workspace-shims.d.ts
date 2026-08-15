/**
 * Type-only workspace shims for cloud API typechecking.
 *
 * `tsgo` treats this ambient module as the local `@elizaos/shared` surface when
 * checking the Cloudflare Worker package. Keep these declarations aligned with
 * the real shared exports used through cloud-shared aliases.
 */

declare module "@elizaos/shared" {
  export const REALTIME_VOICE_CLIENT_TRANSPORT: "realtime_voice";
  export const REALTIME_VOICE_CLIENT_MESSAGE_ID_PREFIX: "voice:";
  export const REALTIME_VOICE_INGRESS_HEADER: "X-Eliza-Realtime-Voice-Ingress";
  export const REALTIME_VOICE_INGRESS_COMMITTED_V1: "committed-v1";
  export function hasCommittedRealtimeVoiceIngress(headers: Headers): boolean;

  export type VoiceOutputPolicy = "say" | "show" | "both" | "never_speak";

  export interface ChatTurnStatus {
    kind:
      | "thinking"
      | "streaming"
      | "running_action"
      | "running_tool"
      | "evaluating"
      | "waking"
      | "speaking";
    label?: string;
    actionName?: string;
    toolName?: string;
  }

  export interface VoiceProgressState {
    responseId: string;
    taskId: string;
    ownerEpoch: number;
    startedAtMs: number;
    lastEventAtMs: number;
    userSpeechActive: boolean;
    userSpeechSequence: number;
    lastUserSpeechEndedAtMs: number | null;
    lastSpokenAtMs: number | null;
    spokenUpdates: number;
    speechCounter: number;
    activeSpeechId: string | null;
    terminal: boolean;
  }

  export interface VoiceProgressEffectStart {
    type: "progress_speech/start";
    responseId: string;
    taskId: string;
    ownerEpoch: number;
    speechId: string;
    speechText: string;
  }

  export interface VoiceProgressTransition {
    state: VoiceProgressState;
    effects: readonly (
      | VoiceProgressEffectStart
      | {
          type: "progress_speech/cancel";
          responseId: string;
          taskId: string;
          ownerEpoch: number;
          speechId: string;
          reason: "user_speech" | "final" | "cancel";
        }
    )[];
  }

  export function createVoiceProgressState(input: {
    responseId: string;
    taskId: string;
    ownerEpoch: number;
    atMs: number;
  }): VoiceProgressState;

  export function reduceVoiceProgress(
    state: VoiceProgressState,
    event: Record<string, unknown>,
    config?: {
      spokenThresholdMs?: number;
      maxSpokenUpdates?: number;
    },
  ): VoiceProgressTransition;

  export function isVoiceProgressSpeechAuthorized(
    state: VoiceProgressState,
    speechId: string,
  ): boolean;

  export type VoiceArtifactKind =
    | "audio"
    | "code"
    | "data"
    | "file"
    | "image"
    | "link";

  export interface VoiceArtifactReference {
    id: string;
    kind: VoiceArtifactKind;
    label: string;
    mimeType?: string;
    href?: string;
  }

  export type VoiceSpeechBlockReason =
    | "never_speak"
    | "show_only"
    | "sensitive_content"
    | "structured_speech"
    | "structured_requires_spoken"
    | "invalid_envelope"
    | "empty";

  export interface VoiceOutputEnvelope {
    policy: VoiceOutputPolicy;
    display: { markdown: string };
    spoken?: string;
    artifacts?: readonly VoiceArtifactReference[];
  }

  export interface VoiceOutputProjection {
    displayMarkdown: string;
    showDisplay: boolean;
    speechText: string | null;
    captions: string | null;
    artifacts: readonly VoiceArtifactReference[];
    speechBlockReason?: VoiceSpeechBlockReason;
    usedStructuredSummary: boolean;
    truncated: boolean;
  }

  export function projectVoiceOutput(
    envelope: VoiceOutputEnvelope,
    options?: { maxSpeechChars?: number },
  ): VoiceOutputProjection;

  export interface CoinGeckoMarketRecord {
    id: string;
    symbol: string;
    name: string;
    currentPriceUsd: number;
    change24hPct: number;
    marketCapRank: number | null;
    imageUrl: string | null;
  }

  export interface WalletMarketPriceSnapshot {
    id: string;
    symbol: string;
    name: string;
    priceUsd: number;
    change24hPct: number;
    imageUrl: string | null;
  }

  export interface WalletMarketMover {
    id: string;
    symbol: string;
    name: string;
    priceUsd: number;
    change24hPct: number;
    marketCapRank: number | null;
    imageUrl: string | null;
  }

  export interface WalletMarketPrediction {
    id: string;
    slug: string | null;
    question: string;
    highlightedOutcomeLabel: string;
    highlightedOutcomeProbability: number | null;
    volume24hUsd: number;
    totalVolumeUsd: number | null;
    endsAt: string | null;
    imageUrl: string | null;
  }

  export type WalletMarketOverviewProviderId = "coingecko" | "polymarket";

  export interface WalletMarketOverviewSource {
    providerId: WalletMarketOverviewProviderId;
    providerName: string;
    providerUrl: string;
    available: boolean;
    stale: boolean;
    error: string | null;
  }

  export interface WalletMarketOverviewResponse {
    generatedAt: string;
    cacheTtlSeconds: number;
    stale: boolean;
    sources: {
      prices: WalletMarketOverviewSource;
      movers: WalletMarketOverviewSource;
      predictions: WalletMarketOverviewSource;
    };
    prices: WalletMarketPriceSnapshot[];
    movers: WalletMarketMover[];
    predictions: WalletMarketPrediction[];
  }

  export const COINGECKO_MARKET_PROVIDER: {
    providerId: "coingecko";
    providerName: "CoinGecko";
    providerUrl: "https://www.coingecko.com/";
  };

  export const POLYMARKET_MARKET_PROVIDER: {
    providerId: "polymarket";
    providerName: "Polymarket";
    providerUrl: "https://polymarket.com/";
  };

  export function buildCoinGeckoMarketsUrl(): URL;

  export function buildMarketMovers(
    markets: CoinGeckoMarketRecord[],
  ): WalletMarketMover[];

  export function buildMarketPriceSnapshots(
    markets: CoinGeckoMarketRecord[],
  ): WalletMarketPriceSnapshot[];

  export function parseCoinGeckoMarkets(
    payload: unknown,
  ): CoinGeckoMarketRecord[];
}
