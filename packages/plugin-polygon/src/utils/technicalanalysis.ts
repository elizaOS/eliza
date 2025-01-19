import { getPriceHistoryByTicker } from './polygon.ts';
import dotenv from 'dotenv';
dotenv.config();

// Utility functions for calculating technical indicators
const TechnicalIndicators = {
    // Calculate Simple Moving Average
    calculateSMA(prices: number[], period: number): number {
        if (prices.length < period) return 0;
        const sum = prices.slice(-period).reduce((a, b) => a + b, 0);
        return sum / period;
    },

    // Calculate Exponential Moving Average
    calculateEMA(prices: number[], period: number): number {
        if (prices.length < period) return 0;
        const multiplier = 2 / (period + 1);
        let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;

        for (let i = period; i < prices.length; i++) {
            ema = (prices[i] - ema) * multiplier + ema;
        }
        return ema;
    },

    // Calculate RSI
    calculateRSI(prices: number[], period: number = 14): number {
        if (prices.length < period + 1) return 50;

        let gains = 0;
        let losses = 0;

        for (let i = 1; i <= period; i++) {
            const difference = prices[i] - prices[i - 1];
            if (difference >= 0) {
                gains += difference;
            } else {
                losses -= difference;
            }
        }

        let avgGain = gains / period;
        let avgLoss = losses / period;

        for (let i = period + 1; i < prices.length; i++) {
            const difference = prices[i] - prices[i - 1];
            if (difference >= 0) {
                avgGain = (avgGain * (period - 1) + difference) / period;
                avgLoss = (avgLoss * (period - 1)) / period;
            } else {
                avgGain = (avgGain * (period - 1)) / period;
                avgLoss = (avgLoss * (period - 1) - difference) / period;
            }
        }

        const rs = avgGain / avgLoss;
        return 100 - (100 / (1 + rs));
    },

    // Calculate MACD
    calculateMACD(prices: number[]): { macd: number, signal: number, histogram: number } {
        if (prices.length < 26) {
            return { macd: 0, signal: 0, histogram: 0 };
        }

        // Calculate EMAs using closing prices only
        const ema12 = this.calculateEMA(prices.slice(-26), 12);  // Use last 26 periods
        const ema26 = this.calculateEMA(prices.slice(-26), 26);
        const macd = ema12 - ema26;

        // Calculate signal line using MACD values
        const macdValues = prices.slice(-26).map((_, i) => {
            const slice = prices.slice(0, prices.length - 26 + i + 1);
            const ema12 = this.calculateEMA(slice, 12);
            const ema26 = this.calculateEMA(slice, 26);
            return ema12 - ema26;
        });

        const signal = this.calculateEMA(macdValues, 9);
        const histogram = macd - signal;

        return { macd, signal, histogram };
    },

    // Calculate Bollinger Bands
    calculateBollingerBands(prices: number[], period: number = 20): {
        upper: number,
        middle: number,
        lower: number
    } {
        if (!Array.isArray(prices) || prices.length < period) {
            console.warn('Insufficient data for Bollinger Bands calculation');
            return { upper: 0, middle: 0, lower: 0 };
        }

        // Get the most recent 'period' prices
        const recentPrices = prices.slice(-period);

        // Calculate SMA (middle band)
        const middle = recentPrices.reduce((sum, price) => sum + price, 0) / period;

        // Calculate Standard Deviation
        const squaredDiffs = recentPrices.map(price => Math.pow(price - middle, 2));
        const standardDeviation = Math.sqrt(
            squaredDiffs.reduce((sum, diff) => sum + diff, 0) / period
        );

        // Calculate bands (2 standard deviations from mean)
        const upper = middle + (standardDeviation * 2);
        const lower = middle - (standardDeviation * 2);

        console.log('Bollinger Bands Debug:', {
            period,
            pricesUsed: recentPrices.length,
            middle,
            standardDeviation,
            upper,
            lower
        });

        return {
            upper,
            middle,
            lower
        };
    },

    // Identify Support and Resistance
    identifySupportResistance(prices: number[]): { support: number, resistance: number } {
        // Use recent price action (last 3 months) for more relevant levels
        const recentPrices = prices.slice(-90);

        // Sort prices and remove outliers
        const sortedPrices = [...recentPrices].sort((a, b) => a - b);
        const q1Index = Math.floor(sortedPrices.length * 0.25);
        const q3Index = Math.floor(sortedPrices.length * 0.75);

        // Calculate support and resistance using price clusters
        const supportArea = sortedPrices.slice(Math.max(0, q1Index - 10), q1Index + 10);
        const resistanceArea = sortedPrices.slice(Math.max(0, q3Index - 10), q3Index + 10);

        const support = supportArea.reduce((a, b) => a + b, 0) / supportArea.length;
        const resistance = resistanceArea.reduce((a, b) => a + b, 0) / resistanceArea.length;

        return { support, resistance };
    }
};

/**
 * Main class for analyzing technical indicators
 * Processes price history to calculate technical signals
 */
class TechnicalAnalyzer {
    /**
     * Analyzes technical indicators for a given stock
     * @param {string} ticker - Stock symbol to analyze
     * @returns {Promise<Object>} Technical analysis results
     */
    async analyzeTechnical(ticker: string) {
        try {
            const priceData = await this.fetchPriceData(ticker);
            const closePrices = priceData.map(d => d.c);
            const currentPrice = closePrices[closePrices.length - 1];

            // Calculate all technical indicators
            const indicators = this.calculateIndicators(closePrices);
            const scores = this.calculateScores(indicators, currentPrice);

            return {
                stock: {
                    ticker,
                    currentPrice,
                    analysisDate: new Date().toISOString()
                },
                technicalAnalysis: {
                    movingAverages: {
                        score: scores.trend_score,
                        ...indicators.movingAverages,
                        values: {
                            sma20: indicators.movingAverages.sma20.value,
                            sma50: indicators.movingAverages.sma50.value,
                            sma200: indicators.movingAverages.sma200.value
                        }
                    },
                    rsi: {
                        score: scores.momentum_score,
                        ...indicators.rsi,
                        value: indicators.rsi.value
                    },
                    macd: {
                        score: scores.momentum_score,
                        ...indicators.macd,
                        values: indicators.macd.values
                    },
                    bollingerBands: {
                        score: scores.volatility_score,
                        ...indicators.bollingerBands,
                        values: indicators.bollingerBands.values
                    },
                    supportResistance: {
                        score: scores.support_resistance_score,
                        ...indicators.supportResistance,
                        values: indicators.supportResistance.values
                    }
                }
            };
        } catch (error) {
            console.error(`Error analyzing ${ticker}:`, error);
            throw error;
        }
    }

    private calculateIndicators(prices: number[]) {
        return {
            movingAverages: {
                name: "Moving Averages",
                sma20: {
                    value: TechnicalIndicators.calculateSMA(prices, 20),
                    description: "20-day Simple Moving Average",
                    interpretation: this.interpretMA(prices[prices.length - 1], TechnicalIndicators.calculateSMA(prices, 20))
                },
                sma50: {
                    value: TechnicalIndicators.calculateSMA(prices, 50),
                    description: "50-day Simple Moving Average",
                    interpretation: this.interpretMA(prices[prices.length - 1], TechnicalIndicators.calculateSMA(prices, 50))
                },
                sma200: {
                    value: TechnicalIndicators.calculateSMA(prices, 200),
                    description: "200-day Simple Moving Average",
                    interpretation: this.interpretMA(prices[prices.length - 1], TechnicalIndicators.calculateSMA(prices, 200))
                }
            },
            rsi: {
                name: "Relative Strength Index",
                value: TechnicalIndicators.calculateRSI(prices),
                description: "14-day RSI",
                interpretation: this.interpretRSI(TechnicalIndicators.calculateRSI(prices))
            },
            macd: {
                name: "Moving Average Convergence Divergence",
                values: TechnicalIndicators.calculateMACD(prices),
                description: "MACD (12,26,9)",
                interpretation: this.interpretMACD(TechnicalIndicators.calculateMACD(prices))
            },
            bollingerBands: {
                name: "Bollinger Bands",
                values: TechnicalIndicators.calculateBollingerBands(prices),
                description: "20-day Bollinger Bands with 2 standard deviations",
                interpretation: this.interpretBollingerBands(
                    TechnicalIndicators.calculateBollingerBands(prices),
                    prices[prices.length - 1]
                )
            },
            supportResistance: {
                name: "Support and Resistance",
                values: TechnicalIndicators.identifySupportResistance(prices),
                description: "Key support and resistance levels",
                interpretation: this.interpretSupportResistance(
                    TechnicalIndicators.identifySupportResistance(prices),
                    prices[prices.length - 1]
                )
            }
        };
    }

    private interpretMA(currentPrice: number, ma: number): string {
        const diff = ((currentPrice - ma) / ma) * 100;
        if (diff > 5) return "Strongly above MA - potential uptrend";
        if (diff > 0) return "Above MA - possible uptrend";
        if (diff < -5) return "Strongly below MA - potential downtrend";
        return "Below MA - possible downtrend";
    }

    private interpretRSI(rsi: number): string {
        if (rsi > 70) return "Overbought - potential reversal down";
        if (rsi < 30) return "Oversold - potential reversal up";
        if (rsi > 60) return "Strong momentum - bullish";
        if (rsi < 40) return "Weak momentum - bearish";
        return "Neutral momentum";
    }

    private interpretMACD({ macd, signal, histogram }: { macd: number, signal: number, histogram: number }): string {
        if (histogram > 0 && macd > 0) return "Strong bullish momentum";
        if (histogram > 0 && macd < 0) return "Bullish momentum building";
        if (histogram < 0 && macd < 0) return "Strong bearish momentum";
        if (histogram < 0 && macd > 0) return "Bearish momentum building";
        return "Neutral momentum";
    }

    private interpretBollingerBands(
        { upper, middle, lower }: { upper: number, middle: number, lower: number },
        currentPrice: number
    ): string {
        if (currentPrice > upper) return "Price above upper band - potentially overbought";
        if (currentPrice < lower) return "Price below lower band - potentially oversold";
        if (currentPrice > middle) return "Price above middle band - bullish";
        return "Price below middle band - bearish";
    }

    private interpretSupportResistance(
        { support, resistance }: { support: number, resistance: number },
        currentPrice: number
    ): string {
        const nearSupport = Math.abs(currentPrice - support) / support < 0.02;
        const nearResistance = Math.abs(currentPrice - resistance) / resistance < 0.02;

        if (nearResistance) return "Near resistance - watch for potential reversal";
        if (nearSupport) return "Near support - watch for potential bounce";
        if (currentPrice > resistance) return "Above resistance - new high possible";
        if (currentPrice < support) return "Below support - new low possible";
        return "Between support and resistance - range bound";
    }

    private calculateScores(indicators: any, currentPrice: number): {
        [key: string]: number
    } {
        const scores = {
            trend_score: this.calculateTrendScore(indicators.movingAverages, currentPrice),
            momentum_score: this.calculateMomentumScore({
                rsi: indicators.rsi.value,
                macd: indicators.macd.values
            }),
            volatility_score: this.calculateVolatilityScore(indicators.bollingerBands.values, currentPrice),
            support_resistance_score: this.calculateSupportResistanceScore(
                indicators.supportResistance.values,
                currentPrice
            )
        };

        return scores;
    }

    private calculateTrendScore(movingAverages: any, currentPrice: number): number {
        let score = 0;

        // Weight recent MAs more heavily and make more sensitive to bearish signals
        if (currentPrice > movingAverages.sma200.value) score += 0.2;  // Reduced from 0.3
        if (currentPrice > movingAverages.sma50.value) score += 0.3;   // Increased from 0.2
        if (currentPrice > movingAverages.sma20.value) score += 0.3;   // Increased from 0.1

        // Add penalties for being below MAs
        if (currentPrice < movingAverages.sma20.value) score -= 0.3;
        if (currentPrice < movingAverages.sma50.value) score -= 0.2;

        // Check MA crossovers
        if (movingAverages.sma20.value > movingAverages.sma50.value) score += 0.1;  // Reduced from 0.2
        if (movingAverages.sma50.value > movingAverages.sma200.value) score += 0.1; // Reduced from 0.2

        return Math.max(-1, Math.min(1, score));
    }

    private calculateMomentumScore({ rsi, macd }: { rsi: number, macd: any }): number {
        console.log('Momentum Score Debug:', {
            rsi,
            macd: {
                macd: macd.macd,
                signal: macd.signal,
                histogram: macd.histogram
            },
            conditions: {
                isOverbought: rsi > 70,
                isOversold: rsi < 30,
                isPositiveHistogram: macd.histogram > 0
            }
        });

        let score = 0;

        // RSI scoring
        if (rsi > 70) score -= 0.5;
        else if (rsi < 30) score += 0.5;
        else score += (rsi - 50) / 40;

        // MACD scoring
        if (macd.histogram > 0) score += 0.3;
        else score -= 0.3;

        return Math.max(-1, Math.min(1, score));
    }

    private calculateVolatilityScore(bollingerBands: { upper: number, middle: number, lower: number }, currentPrice: number): number {
        console.log('Volatility Score Debug:', {
            currentPrice,
            bands: bollingerBands,
            conditions: {
                aboveUpper: currentPrice > bollingerBands.upper,
                belowLower: currentPrice < bollingerBands.lower,
                bandWidth: (bollingerBands.upper - bollingerBands.lower) / bollingerBands.middle
            }
        });

        const { upper, lower, middle } = bollingerBands;
        const bandWidth = (upper - lower) / middle;
        let score = 0;

        // Score based on position within Bollinger Bands
        if (currentPrice > upper) score -= 0.5;
        else if (currentPrice < lower) score += 0.5;
        else score += (currentPrice - middle) / (upper - middle);

        // Adjust score based on band width
        score *= (1 - bandWidth);

        return Math.max(-1, Math.min(1, score));
    }

    private calculateSupportResistanceScore(
        { support, resistance }: { support: number, resistance: number },
        currentPrice: number
    ): number {
        const range = resistance - support;
        if (range === 0) return 0;

        // Calculate relative position
        const normalizedPosition = (currentPrice - support) / range;

        let score = 0;

        // Score based on position relative to support/resistance
        if (currentPrice < support) {
            score = -0.5; // Below support is bearish
        } else if (currentPrice > resistance) {
            score = 0.5;  // Above resistance is bullish (breakout)
        } else {
            // Between support and resistance
            if (normalizedPosition < 0.4) score = 0.3;  // Closer to support (bullish)
            else if (normalizedPosition > 0.6) score = -0.3;  // Closer to resistance (bearish)
        }

        // Add strength to score based on momentum
        const nearSupport = Math.abs(currentPrice - support) / range < 0.1;
        const nearResistance = Math.abs(currentPrice - resistance) / range < 0.1;

        if (nearSupport && currentPrice > support) score += 0.2;
        if (nearResistance && currentPrice < resistance) score -= 0.2;

        return Math.max(-1, Math.min(1, score));
    }

    private async fetchPriceData(ticker: string) {
        const now = new Date();
        const twoYearsAgo = new Date();
        twoYearsAgo.setFullYear(now.getFullYear() - 2);

        const fullData = await getPriceHistoryByTicker(
            ticker,
            twoYearsAgo.getTime(),
            now.getTime(),
            "day"
        );

        return fullData[0]?.history.map(({ date, close }) => ({ t: date, c: close })) || [];
    }
}

// Example usage
console.log('Starting technical analysis...');
const analyzer = new TechnicalAnalyzer();
analyzer.analyzeTechnical('AAPL').then(analysis => {
    console.log('Technical Analysis Results:', JSON.stringify(analysis, null, 2));
}).catch(error => {
    console.error('Analysis failed:', error);
});

export default TechnicalAnalyzer;
