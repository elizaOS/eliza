/**
 * Normalized ticker item shapes for the ticker API and embed.
 * Used by GET /api/ticker and the ticker embed page.
 */

export interface TickerNewsItem {
  id: string;
  title: string;
  summary: string;
  url?: string;
  timestamp: string;
  type: "news";
}

export interface TickerPredictionItem {
  id: string;
  question: string;
  yesPercent: number;
  status: string;
  type: "prediction";
}

export interface TickerPerpItem {
  ticker: string;
  price: number;
  /** 24h % change, or null when no 24h reference price (show as "—") */
  changePercent24h: number | null;
  type: "perp";
}

export interface TickerResponse {
  news?: TickerNewsItem[];
  predictions?: TickerPredictionItem[];
  perps?: TickerPerpItem[];
}
