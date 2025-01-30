import { type IAgentRuntime, type Memory, type Provider, type State, elizaLogger } from "@elizaos/core";
import axios from 'axios';
import { getApiConfig, validateCoingeckoConfig } from '../environment';

interface CategoryItem {
    category_id: string;
    name: string;
}

const CACHE_KEY = 'coingecko:categories';
const CACHE_TTL = 5 * 60; // 5 minutes
const MAX_RETRIES = 3;

async function fetchCategories(runtime: IAgentRuntime): Promise<CategoryItem[]> {
    const config = await validateCoingeckoConfig(runtime);
    const { baseUrl, apiKey, headerKey } = getApiConfig(config);

    const response = await axios.get<CategoryItem[]>(
        `${baseUrl}/coins/categories/list`,
        {
            headers: {
                'accept': 'application/json',
                [headerKey]: apiKey
            },
            timeout: 5000 // 5 second timeout
        }
    );

    if (!response.data?.length) {
        throw new Error("Invalid categories data received");
    }

    return response.data;
}

async function fetchWithRetry(runtime: IAgentRuntime): Promise<CategoryItem[]> {
    let lastError: Error | null = null;

    for (let i = 0; i < MAX_RETRIES; i++) {
        try {
            return await fetchCategories(runtime);
        } catch (error) {
            lastError = error;
            elizaLogger.error(`Categories fetch attempt ${i + 1} failed:`, error);
            await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
        }
    }

    throw lastError || new Error("Failed to fetch categories after multiple attempts");
}

async function getCategories(runtime: IAgentRuntime): Promise<CategoryItem[]> {
    try {
        // Try to get from cache first
        const cached = await runtime.cacheManager.get<CategoryItem[]>(CACHE_KEY);
        if (cached) {
            return cached;
        }

        // Fetch fresh data
        const categories = await fetchWithRetry(runtime);

        // Cache the result
        await runtime.cacheManager.set(CACHE_KEY, categories, { expires: CACHE_TTL });

        return categories;
    } catch (error) {
        elizaLogger.error("Error fetching categories:", error);
        throw error;
    }
}

function formatCategoriesContext(categories: CategoryItem[]): string {
    const popularCategories = [
        'layer-1', 'defi', 'meme', 'ai-meme-coins',
        'artificial-intelligence', 'gaming', 'metaverse'
    ];

    const popular = categories
        .filter(c => popularCategories.includes(c.category_id))
        .map(c => `${c.name} (${c.category_id})`);

    return `
Available cryptocurrency categories:

Popular categories:
${popular.map(c => `- ${c}`).join('\n')}

Total available categories: ${categories.length}

You can use these category IDs when filtering cryptocurrency market data.
`.trim();
}

export const categoriesProvider: Provider = {
    // eslint-disable-next-line
    get: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<string> => {
        try {
            const categories = await getCategories(runtime);
            return formatCategoriesContext(categories);
        } catch (error) {
            elizaLogger.error("Categories provider error:", error);
            return "Cryptocurrency categories are temporarily unavailable. Please try again later.";
        }
    }
};

// Helper function for actions to get raw categories data
export async function getCategoriesData(runtime: IAgentRuntime): Promise<CategoryItem[]> {
    return getCategories(runtime);
}
