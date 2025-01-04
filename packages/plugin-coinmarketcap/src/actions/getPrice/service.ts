import axios from "axios";
import { ApiResponse, PriceData } from "./types";

const BASE_URL = "https://pro-api.coinmarketcap.com/v1";

export const createPriceService = (apiKey: string) => {
    const client = axios.create({
        baseURL: BASE_URL,
        headers: {
            "X-CMC_PRO_API_KEY": apiKey,
            Accept: "application/json",
        },
    });

    const getPrice = async (
        symbol: string,
        currency: string
    ): Promise<PriceData> => {
        const normalizedSymbol = symbol.toUpperCase().trim();
        const normalizedCurrency = currency.toUpperCase().trim();

        try {
            const response = await client.get<ApiResponse>(
                "/cryptocurrency/quotes/latest",
                {
                    params: {
                        symbol: normalizedSymbol,
                        convert: normalizedCurrency,
                    },
                }
            );

            console.log(
                "API Response:",
                JSON.stringify(response.data, null, 2)
            );

            const symbolData = response.data.data[normalizedSymbol];
            if (!symbolData) {
                throw new Error(
                    `No data found for symbol: ${normalizedSymbol}`
                );
            }

            const quoteData = symbolData.quote[normalizedCurrency];
            if (!quoteData) {
                throw new Error(
                    `No quote data found for currency: ${normalizedCurrency}`
                );
            }

            return {
                price: quoteData.price,
                marketCap: quoteData.market_cap,
                volume24h: quoteData.volume_24h,
                percentChange24h: quoteData.percent_change_24h,
            };
        } catch (error) {
            if (axios.isAxiosError(error)) {
                const errorMessage =
                    error.response?.data?.status?.error_message ||
                    error.message;
                console.error("API Error:", errorMessage);
                throw new Error(`API Error: ${errorMessage}`);
            }
            throw error;
        }
    };

    return { getPrice };
};
