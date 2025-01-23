import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TradeService } from '../src/services/trade';
import { AuthenticationError, InvalidSymbolError, MinNotionalError, ApiError } from '../src/types/internal/error';
import { ORDER_TYPES, TIME_IN_FORCE } from '../src/constants/api';

// Mock the Binance client
const mockNewOrder = vi.fn();
const mockExchangeInfo = vi.fn();
vi.mock('@binance/connector', () => ({
    Spot: vi.fn().mockImplementation(() => ({
        newOrder: mockNewOrder,
        exchangeInfo: mockExchangeInfo
    }))
}));

describe('TradeService', () => {
    let tradeService: TradeService;
    const mockApiKey = 'test-api-key';
    const mockSecretKey = 'test-secret-key';

    beforeEach(() => {
        vi.clearAllMocks();
        tradeService = new TradeService({
            apiKey: mockApiKey,
            secretKey: mockSecretKey
        });
    });

    describe('initialization', () => {
        it('should initialize with API credentials', () => {
            expect(tradeService).toBeInstanceOf(TradeService);
        });

        it('should throw AuthenticationError when credentials are missing', async () => {
            tradeService = new TradeService();
            await expect(tradeService.executeTrade({
                symbol: 'BTCUSDT',
                side: 'BUY',
                type: ORDER_TYPES.MARKET,
                quantity: 1
            })).rejects.toThrow(AuthenticationError);
        });
    });

    describe('executeTrade', () => {
        const mockSymbolInfo = {
            symbol: 'BTCUSDT',
            status: 'TRADING',
            baseAsset: 'BTC',
            quoteAsset: 'USDT',
            filters: [
                {
                    filterType: 'NOTIONAL',
                    minNotional: '10.00000000'
                }
            ]
        };

        const mockExchangeInfoResponse = {
            data: {
                symbols: [mockSymbolInfo]
            }
        };

        beforeEach(() => {
            mockExchangeInfo.mockResolvedValue(mockExchangeInfoResponse);
        });

        it('should execute a market order successfully', async () => {
            const mockOrderResponse = {
                data: {
                    symbol: 'BTCUSDT',
                    orderId: 12345,
                    status: 'FILLED',
                    executedQty: '1.0',
                    cummulativeQuoteQty: '50000.0',
                    price: '50000.0',
                    type: ORDER_TYPES.MARKET,
                    side: 'BUY'
                }
            };

            mockNewOrder.mockResolvedValueOnce(mockOrderResponse);

            const result = await tradeService.executeTrade({
                symbol: 'BTCUSDT',
                side: 'BUY',
                type: ORDER_TYPES.MARKET,
                quantity: 1
            });

            expect(result).toEqual({
                symbol: 'BTCUSDT',
                orderId: 12345,
                status: 'FILLED',
                executedQty: '1.0',
                cummulativeQuoteQty: '50000.0',
                price: '50000.0',
                type: ORDER_TYPES.MARKET,
                side: 'BUY'
            });

            expect(mockNewOrder).toHaveBeenCalledWith(
                'BTCUSDT',
                'BUY',
                ORDER_TYPES.MARKET,
                expect.objectContaining({
                    quantity: '1'
                })
            );
        });

        it('should execute a limit order successfully', async () => {
            const mockOrderResponse = {
                data: {
                    symbol: 'BTCUSDT',
                    orderId: 12345,
                    status: 'NEW',
                    executedQty: '0.0',
                    cummulativeQuoteQty: '0.0',
                    price: '50000.0',
                    type: ORDER_TYPES.LIMIT,
                    side: 'BUY'
                }
            };

            mockNewOrder.mockResolvedValueOnce(mockOrderResponse);

            const result = await tradeService.executeTrade({
                symbol: 'BTCUSDT',
                side: 'BUY',
                type: ORDER_TYPES.LIMIT,
                quantity: 1,
                price: 50000,
                timeInForce: TIME_IN_FORCE.GTC
            });

            expect(result).toEqual({
                symbol: 'BTCUSDT',
                orderId: 12345,
                status: 'NEW',
                executedQty: '0.0',
                cummulativeQuoteQty: '0.0',
                price: '50000.0',
                type: ORDER_TYPES.LIMIT,
                side: 'BUY'
            });

            expect(mockNewOrder).toHaveBeenCalledWith(
                'BTCUSDT',
                'BUY',
                ORDER_TYPES.LIMIT,
                expect.objectContaining({
                    quantity: '1',
                    price: '50000',
                    timeInForce: TIME_IN_FORCE.GTC
                })
            );
        });

        it('should throw error for invalid symbol', async () => {
            mockExchangeInfo.mockResolvedValueOnce({
                data: {
                    symbols: [] // No symbols match
                }
            });

            await expect(tradeService.executeTrade({
                symbol: 'INVALID',
                side: 'BUY',
                type: ORDER_TYPES.MARKET,
                quantity: 1
            })).rejects.toThrow(InvalidSymbolError);
        });

        it('should throw error for insufficient notional value', async () => {
            // Mock successful exchange info response first
            mockExchangeInfo.mockResolvedValueOnce(mockExchangeInfoResponse);

            // Mock order response with error
            mockNewOrder.mockRejectedValueOnce({
                response: {
                    data: {
                        code: -1013,
                        msg: 'Filter failure: NOTIONAL'
                    }
                }
            });

            await expect(tradeService.executeTrade({
                symbol: 'BTCUSDT',
                side: 'BUY',
                type: ORDER_TYPES.MARKET,
                quantity: 0.0001 // Very small amount
            })).rejects.toThrow(MinNotionalError);
        });

        it('should throw error for limit order without price', async () => {
            // Mock successful exchange info response
            mockExchangeInfo.mockResolvedValueOnce(mockExchangeInfoResponse);

            await expect(tradeService.executeTrade({
                symbol: 'BTCUSDT',
                side: 'BUY',
                type: ORDER_TYPES.LIMIT,
                quantity: 1
                // price is missing
            })).rejects.toThrow('Price is required for LIMIT orders');
        });

        it('should handle API timeout', async () => {
            // Mock successful exchange info response first
            mockExchangeInfo.mockResolvedValueOnce(mockExchangeInfoResponse);

            // Mock order request to timeout
            mockNewOrder.mockImplementationOnce(() => 
                Promise.reject(new ApiError('Request timed out', -1001))
            );

            const service = new TradeService({
                apiKey: 'test',
                secretKey: 'test',
                timeout: 100 // Lower timeout as we're mocking the error
            });

            await expect(() => service.executeTrade({
                symbol: 'BTCUSDT',
                side: 'BUY',
                type: ORDER_TYPES.MARKET,
                quantity: 1
            })).rejects.toMatchObject({
                message: 'Request timed out',
                code: -1001
            });
        });
    });
});
