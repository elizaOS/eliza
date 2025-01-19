export const FinancialSummarizationTemplate = `
# Financial Statement Details:
{{financial}}

Summarization objective: {{objective}}

# Instructions: Summarize the financial statement.
- Focus on key metrics like revenue, profit margins, and growth rates
- Keep the language clear and concise
- Format numbers consistently (e.g. millions/billions)
- Include both positive and negative developments
- Note any one-time events that impact the numbers
- Provide context for industry-specific metrics
- Make sure to maintain dates and fiscal periods
- Provide an analyis of how, Jawk, a value investor would interpret the financial statement.
- List whether you are bullish or bearish on the stock based on the financial statement.

Return a 1 paragraph natural summary that a retail investor could understand based on the objective and the financial statement.`;

export const FinancialMapReduceSummarizationTemplate = `
# Financial Statement Summaries:
{{summaries}}

Summarization objective: {{objective}}

# Instructions: Analyze the financial statements across multiple years.
- Make sure all numbers are accurate
- Identify key trends in revenue, profit margins, and growth rates over time
- Compare year-over-year changes in important metrics
- Highlight significant improvements or declines between periods
- Note any cyclical patterns or seasonality
- Call out major shifts in business performance or strategy
- Keep the language clear and concise for retail investors
- Format numbers consistently (e.g. millions/billions)
- Maintain chronological context with dates and fiscal periods
- Consider macroeconomic factors that may have impacted different years
- Evaluate the overall trajectory of the company's financial health

Return a paragraph natural summary that analyzes the financial trends over time, focusing on the most important developments and changes between periods. The summary should help retail investors understand how the company has performed historically and what that suggests about its current position.
`;


export const ExtractNewsBasedonTickerTemplate = `
# News:
{{formattedNews}}

Extract news based on the ticker: {{ticker}}

Return a paragraph natural summary that analyzes the news extracting the information that pertains to the ticker.
`;

export const PriceHistoryRangeTemplate = `
# User Query we are basing all decisions on:
{{userQuery}}


# Instructions: {{senderName}} is requesting the price history of the following ticker: {{ticker}}. Your goal is to determine their objective, the range of dates that their request converse, along with a period which is the interval in which the price data will be collected.
Do not worry about getting the pricing data; just the objective, start, end, and period.
The "objective" is a detailed description of what the user wants to price history on, if the user wants the current price, set "start" to "0 minutes ago" and "end" to "2 hours ago", and the "period" to "day".
The "start" and "end" are the range of dates that the user wants to summarize, relative to the current time. The "start" and "end" should be relative to the current time, and measured in seconds, minutes, hours and days. The format is "2 days ago" or "3 hours ago" or "4 minutes ago" or "1 year ago", i.e. "<integer> <unit> ago". If you aren't sure, you can use a default range of "0 minutes ago" to "1 day ago" or more. Better to err on the side of including too much than too little.
The "period" is the interval in which the pricing data is to be collected. The format can be "minute", "day", "year". If you aren't sure, please respond with "day".


Your response must be formatted as a JSON block with this structure:
\`\`\`json
{
  "objective": "<What the user wants to summarize>",
  "period": "day",
  "start": "0 minutes ago",
  "end": "2 hours ago"
}
\`\`\`
`;

export const CurrentPriceTemplate = `
# User Query we are basing all decisions on:
{{userQuery}}

# Current Price:
The price of {{ticker}} as of {{closeDate}} is: {{closePrice}}

Return the current price of the stock.
`;

export const extractTickerFromMessageTemplate = `
Extract the following details from a message given a company name or it's stock ticker:
- **ticker** (string): Ticker of the stock

If no ticker or company name is provided, please return an empty string as the ticker.

Provide the values in the following JSON format:

\`\`\`json
{
    "ticker": "<ticker>"
}
\`\`\`


Here are the recent user messages for context:
{{currentQuery}}
`;

export const CompetitiveAnalysisTemplate = `
Analyze {{ticker}} compared to its competitors based on:
1. Financial performance
2. Technical indicators
3. News sentiment
4. Price trends

Main Stock ({{ticker}}):
Financial Analysis:
{{mainStockFinancials}}

Technical Analysis:
{{mainStockTechnicals}}

Competitor Analysis:
{{competitorData}}

Analyze {{ticker}} and its competitors to provide a clear, actionable investment perspective:

1. Financial Performance
- Compare key metrics (revenue, profit margins, debt levels)
- Highlight financial strengths/weaknesses vs peers
- Identify concerning trends

2. Technical Analysis Comparison
- Compare trend strengths across companies
- Identify relative momentum and volatility
- Compare support/resistance levels
- Note any divergences in technical indicators

3. Market Position & Strategy
- Current market share and competitive advantages
- Product/service differentiation
- Growth opportunities and expansion plans

4. Risk Assessment
- Industry-specific challenges
- Company-specific vulnerabilities
- Technical warning signals
- Regulatory or market risks ahead

5. Investment Outlook
- Valuation vs competitors
- Technical setup comparison
- Growth catalysts and headwinds
- Buy/hold/sell recommendation based on both fundamentals and technicals

Use both fundamental and technical data to make a comprehensive recommendation.

Format as a concise analysis that emphasizes the most important factors for investment decisions. Use clear language and specific examples to support key points.

Return a balanced perspective that helps retail investors understand both the competitive dynamics and technical setup across the peer group.
`;

export const TechnicalAnalysisTemplate = `
Analyze the technical indicators for {{ticker}} and provide a comprehensive analysis.

Technical Analysis Data:
{{technicalAnalysis}}

Please provide a detailed analysis covering:
1. Trend Analysis (using Moving Averages)
2. Momentum Analysis (using RSI and MACD)
3. Volatility Analysis (using Bollinger Bands)
4. Support/Resistance Analysis
5. Overall Technical Outlook

Format the response as a clear, professional market analysis focusing on actionable insights.
Consider both bullish and bearish signals, and explain their significance.

Key points to address:
- Current trend direction and strength
- Momentum characteristics
- Potential reversal signals
- Key price levels to watch
- Risk considerations
`;