import { PortfolioData, PositionData } from "./types";

export const formatPortfolioData = (data: PortfolioData) => {
    return `Total Value of the portfolio is $${data.totalValue.toFixed(2)}. In 24 hours the portfolio has changed by (${data.changes.percent_1d}%).`;
}

export const formatPositionsData = (data: PositionData) => {
    let response = `Total Portfolio Value: $${data.totalValue.toFixed(2)}\n\nToken Positions:\n`;

    // Sort positions by value (descending), putting null values at the end
    const sortedPositions = [...data.positions].sort((a, b) => {
        if (a.value === null && b.value === null) return 0;
        if (a.value === null) return 1;
        if (b.value === null) return -1;
        return b.value - a.value;
    });

    for (const position of sortedPositions) {
        const valueStr = position.value !== null ? `$${position.value.toFixed(2)}` : 'N/A';
        const change24hStr = position.change24h !== null ? `${position.change24h.toFixed(2)}%` : 'N/A';

        response += `${position.name} Value: ${valueStr} 24h Change: ${change24hStr}\n`;
    }

    return response;
}