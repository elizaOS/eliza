import dotenv from "dotenv";
dotenv.config();

import {
    restClient,
    ITickers,
    ITickersQuery,
    IGlobalOptions,
    ITickerDetails,
    IStockFinancialResults,
    ITickerNews,
} from "@polygon.io/client-js";
import {
    composeContext,
    generateText,
    trimTokens,
    IAgentRuntime,
    State,
    Memory,
    models,
    ModelClass,
    ServiceType,
    elizaLogger,
} from "@elizaos/core";
import { BrowserService } from "@elizaos/plugin-node";
import {
    FinancialSummarizationTemplate,
    FinancialMapReduceSummarizationTemplate,
    ExtractNewsBasedonTickerTemplate,
    CompetitiveAnalysisTemplate,
    TechnicalAnalysisTemplate
} from "../templates";
import { getCompetitors } from "@jawk/utils";
import TechnicalAnalyzer from './technicalanalysis';

export const createClient = () => {
    const apiKey = process.env.POLYGON_API_KEY;
    elizaLogger.log("apiKey", apiKey);

    const rest = restClient(apiKey);
    return rest;
};

type NewsResults = {
    ticker: string;
    articles: ITickerNews["results"];
};

export const getNewsByTicker = async (
    ticker: string[]
): Promise<NewsResults[]> => {
    elizaLogger.log("getNewsByTicker called with tickers:", ticker);
    const rest = createClient();

    const news: NewsResults[] = [];

    elizaLogger.log("Fetching news for each ticker...");
    await Promise.all(
        ticker.map(async (ticker) => {
            elizaLogger.log(`Fetching news for ticker: ${ticker}`);
            try {
                const newsArticles = await rest.reference.tickerNews({
                    ticker: ticker,
                    sort: "published_utc",
                    order: "desc",
                    limit: 20,
                });

                elizaLogger.log(`Found ${newsArticles.results.length} articles for ${ticker}`);
                news.push({
                    ticker: ticker,
                    articles: newsArticles.results,
                });
            } catch (error) {
                elizaLogger.log(`No articles found for ${ticker}`, error);
            }
        })
    );

    elizaLogger.log(`Returning news for ${news.length} tickers`);
    return news;
};
type PriceDataPoint = {
    date: number;
    close: number;
};

type TickerHistory = {
    ticker: string;
    history: PriceDataPoint[];
};

export const getPriceHistoryByTicker = async (
    ticker: string,
    start: number,
    end: number,
    period: string
) => {
    elizaLogger.log("getPriceHistoryByTicker called", {ticker, start, end, period});
    const rest = createClient();
    const tickerHistory: TickerHistory[] = [];
    const startDate = new Date(start);
    const endDate = new Date(Math.min(end, Date.now() - 15 * 60 * 1000));

    elizaLogger.log(`Fetching price history from ${startDate.toISOString()} to ${endDate.toISOString()}`);

    if (end - start <= 86400000) {
        start = end - 24 * 60 * 60 * 1000;
        elizaLogger.log("Time range too short, adjusted start date", new Date(start).toISOString());
    }

    try {
        elizaLogger.log("Requesting aggregates from Polygon API...");
        const dailyData = await rest.stocks.aggregates(
            ticker,
            1,
            period,
            String(start),
            String(end)
        );
        if (dailyData.results.length === 0) {
            elizaLogger.log("No results returned from Polygon API");
            return [];
        }
        elizaLogger.log(`Received ${dailyData.results.length} data points`);

        tickerHistory.push({
            ticker: ticker,
            history: dailyData.results.map((result) => ({
                date: result.t,
                open: result.o,
                high: result.h,
                low: result.l,
                close: result.c,
                volume: result.v,
            })),
        });
    } catch (error) {
        elizaLogger.error("Error fetching price history:", error);
        elizaLogger.log(
            `No data found for ${ticker} between ${new Date(
                start
            ).toISOString()} and ${new Date(end).toISOString()}`
        );
    }

    elizaLogger.log(`Returning history with ${tickerHistory[0]?.history.length || 0} data points`);
    return tickerHistory;
};

export const getCompanyFinancialsTicker = async (
    ticker: string
): Promise<IStockFinancialResults["results"]> => {
    elizaLogger.log("getCompanyFinancialsTicker called for", ticker);
    const rest = createClient();

    const query = {
        ticker: ticker,
        timeframe: "annual" as "annual" | "quarterly",
        order: "desc" as "desc" | "asc",
        limit: 5,
    };
    elizaLogger.log("Requesting financial data with query:", query);
    const financials = await rest.reference.stockFinancials(query);
    elizaLogger.log(`Received ${financials.results.length} financial records`);
    return financials.results;
};

export const getFinancialSummarization = async (
    ticker: string,
    runtime: IAgentRuntime,
    state: State,
    _message: Memory,
    chunkSize: number
) => {
    elizaLogger.log("getFinancialSummarization called", {ticker, chunkSize});
    const financials = await getCompanyFinancialsTicker(ticker);
    if (financials.length === 0) {
        elizaLogger.log("No financials found, returning empty string");
        return "";
    }

    state.objective = _message.content.text;
    elizaLogger.log("Processing financials for summarization");

    const summaries = [];

    await Promise.all(
        financials.map(async (financial) => {
            elizaLogger.log(`Processing financial period: ${financial.fiscal_year}-${financial.fiscal_period}`);
            state.financial = JSON.stringify(financial.financials);

            const template = await trimTokens(
                FinancialSummarizationTemplate,
                chunkSize,
                runtime
            );
            const context = composeContext({
                state,
                template,
            });

            elizaLogger.log("Generating summary for period");
            const summary = await generateText({
                runtime,
                context,
                modelClass: ModelClass.SMALL,
            });
            const summaryWithFiscalPeriod = `${financial.fiscal_year}-${financial.fiscal_period}: ${summary}`;
            summaries.push(summaryWithFiscalPeriod);
        })
    );

    elizaLogger.log(`Generated ${summaries.length} period summaries`);
    const currentSummary = summaries.join("\n\n");

    state.summaries = currentSummary;

    elizaLogger.log("Generating final summarization");
    const template = await trimTokens(
        FinancialMapReduceSummarizationTemplate,
        chunkSize,
        runtime
    );

    const context = composeContext({
        state,
        template,
    });

    const finalSummary = await generateText({
        runtime,
        context,
        modelClass: ModelClass.SMALL,
    });

    elizaLogger.log("Financial summarization complete");
    return finalSummary;
};

export const getSummarizedNews = async (
    ticker: string,
    runtime: IAgentRuntime,
    state: State,
) => {
    elizaLogger.log("getSummarizedNews called for", ticker);
    const news = await getNewsByTicker([ticker]);
    if (!news) {
        elizaLogger.log("No news found, returning empty string");
        return "";
    }

    const newsBrowser = (await runtime.getService(
        ServiceType.BROWSER
    )) as BrowserService;
    if (!newsBrowser) {
        elizaLogger.log("Browser service not available");
        return "";
    }

    const allSummaries = [];

    elizaLogger.log("Processing news articles");
    for (const newsResult of news) {
        elizaLogger.log(`Processing news for ${newsResult.ticker}`);
        const articles = newsResult.articles.slice(0, 5);
        elizaLogger.log(`Processing ${articles.length} recent articles`);

        const summaries = await Promise.all(
            articles.map(async (article) => {
                try {
                    elizaLogger.log(`Fetching content for article: ${article.article_url}`);
                    const newsContent = await newsBrowser.getPageContent(
                        article.article_url,
                        runtime
                    );
                    return {
                        title: newsContent.title,
                        url: article.article_url,
                        publishedDate: article.published_utc,
                        summary: newsContent.description,
                    };
                } catch (error) {
                    elizaLogger.error("Error getting news content:", error);
                    return null;
                }
            })
        );

        const validSummaries = summaries.filter(Boolean);
        elizaLogger.log(`Got ${validSummaries.length} valid summaries`);
        allSummaries.push({
            ticker: newsResult.ticker,
            articles: validSummaries,
        });
    }

    elizaLogger.log("Formatting news summaries");
    const formattedNews = allSummaries
        .map((summary) => {
            return `News for ${summary.ticker}:\n${summary.articles
                .map(
                    (article) =>
                        `- ${article.title} (${new Date(
                            article.publishedDate
                        ).toLocaleDateString()})\n  ${article.summary}\n`
                )
                .join("\n")}`;
        })
        .join("\n\n");

    state.formattedNews = formattedNews;
    state.ticker = ticker;

    elizaLogger.log("Generating final news context");
    const tickerNewsContext = composeContext({
        state,
        template: ExtractNewsBasedonTickerTemplate,
    });

    elizaLogger.log("Generating final news summary");
    const extractNewsBasedOnTicker = await generateText({
        runtime,
        context: tickerNewsContext,
        modelClass: ModelClass.MEDIUM,
    });
    if (!extractNewsBasedOnTicker) {
        elizaLogger.log("Failed to generate news summary");
        return "";
    }

    elizaLogger.log("News summarization complete");
    return extractNewsBasedOnTicker;
};

type CompetitorAnalysis = {
    ticker: string;
    financials: string;
    news: string;
    latestPrice: number;
    technicalAnalysis: string;
};

export const getCompetitorAnalysis = async (
    ticker: string,
    runtime: IAgentRuntime,
    state: State,
    message: Memory,
    chunkSize: number
): Promise<{mainStock: CompetitorAnalysis, competitors: CompetitorAnalysis[]}> => {
    elizaLogger.log("Starting competitor analysis for", ticker);

    const competitorTickers = await getCompetitors(runtime, ticker);
    elizaLogger.log("Found competitors:", competitorTickers);

    const endDate = new Date();
    const startDate = new Date();
    startDate.setFullYear(endDate.getFullYear() - 1);

    const mainStockData = await Promise.all([
        getFinancialSummarization(ticker, runtime, state, message, chunkSize),
        getSummarizedNews(ticker, runtime, state),
        getPriceHistoryByTicker(ticker, startDate.getTime(), endDate.getTime(), "day"),
        getTechnicalAnalysis(ticker, runtime, state, message)
    ]);

    const mainStock: CompetitorAnalysis = {
        ticker: ticker,
        financials: mainStockData[0],
        news: mainStockData[1],
        latestPrice: mainStockData[2][0].history[mainStockData[2][0].history.length - 1].close,
        technicalAnalysis: mainStockData[3]
    };

    elizaLogger.log("mainStock", mainStock);

    const competitors = await Promise.all(competitorTickers.map(async (compTicker) => {
        const [financials, news, priceHistory, technicalAnalysis] = await Promise.all([
            getFinancialSummarization(compTicker, runtime, state, message, chunkSize),
            getSummarizedNews(compTicker, runtime, state),
            getPriceHistoryByTicker(compTicker, startDate.getTime(), endDate.getTime(), "day"),
            getTechnicalAnalysis(compTicker, runtime, state, message)
        ]);

        const pricingData = priceHistory[0].history.map((price) => ({
            date: price.date,
            close: price.close
        })) ?? [];

        return {
            ticker: compTicker,
            financials,
            news,
            latestPrice: pricingData[pricingData.length - 1].close,
            technicalAnalysis
        };
    }));

    elizaLogger.log("competitors", competitors);

    return {
        mainStock,
        competitors
    };
};

export const generateCompetitiveAnalysis = async (
    analysisData: {mainStock: CompetitorAnalysis, competitors: CompetitorAnalysis[]},
    runtime: IAgentRuntime,
    state: State
): Promise<string> => {
    state.ticker = analysisData.mainStock.ticker;
    state.mainStockFinancials = analysisData.mainStock.financials;
    state.mainStockTechnicals = analysisData.mainStock.technicalAnalysis;
    state.competitorData = analysisData.competitors.map(comp =>
        `${comp.ticker}:
Financial Analysis:
${comp.financials}

Technical Analysis:
${comp.technicalAnalysis}

News:
${comp.news}

Current Price: ${comp.latestPrice}`
    ).join('\n\n');

    const context = composeContext({
        state,
        template: CompetitiveAnalysisTemplate
    });

    const analysis = await generateText({
        runtime,
        context,
        modelClass: ModelClass.LARGE
    });

    return analysis;
};

export const analyzeCompetitors = async (
    ticker: string,
    runtime: IAgentRuntime,
    state: State,
    message: Memory,
    chunkSize: number = 126000
): Promise<string> => {
    elizaLogger.log("Starting full competitor analysis for", ticker);

    try {
        // Get all competitor data
        const analysisData = await getCompetitorAnalysis(
            ticker,
            runtime,
            state,
            message,
            chunkSize
        );

        // Generate comparative analysis
        const competitiveAnalysis = await generateCompetitiveAnalysis(
            analysisData,
            runtime,
            state
        );

        return competitiveAnalysis;
    } catch (error) {
        elizaLogger.error("Error in competitor analysis:", error);
        return `Failed to analyze competitors for ${ticker}: ${error.message}`;
    }
};

type TechnicalAnalysisResult = {
    stock: {
        ticker: string;
        currentPrice: number;
        analysisDate: string;
    };
    technicalAnalysis: {
        movingAverages: any;
        rsi: any;
        macd: any;
        bollingerBands: any;
        supportResistance: any;
    };
};

export const getTechnicalAnalysis = async (
    ticker: string,
    runtime: IAgentRuntime,
    state: State,
    message: Memory
): Promise<string> => {
    elizaLogger.log("Getting technical analysis for", ticker);

    try {
        const analyzer = new TechnicalAnalyzer();
        const analysis = await analyzer.analyzeTechnical(ticker);

        state.ticker = ticker;
        state.technicalAnalysis = analysis;

        elizaLogger.log("Generating technical analysis context");
        const technicalContext = composeContext({
            state,
            template: TechnicalAnalysisTemplate,
        });

        elizaLogger.log("Generating final technical analysis");
        const technicalSummary = await generateText({
            runtime,
            context: technicalContext,
            modelClass: ModelClass.MEDIUM,
        });

        return technicalSummary;
    } catch (error) {
        elizaLogger.error("Error in technical analysis:", error);
        return "";
    }
};

export const analyzeStock = async (
    ticker: string,
    runtime: IAgentRuntime,
    state: State,
    message: Memory
) => {
    const [technicalAnalysis, financialAnalysis] = await Promise.all([
        getTechnicalAnalysis(ticker, runtime, state, message),
        getFinancialSummarization(ticker, runtime, state, message, 126000)
    ]);

    return {
        technical: technicalAnalysis,
        financial: financialAnalysis
    };
};
