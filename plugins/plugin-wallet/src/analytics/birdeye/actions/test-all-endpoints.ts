import {
    type Action,
    type ActionExample,
    elizaLogger,
    type HandlerCallback,
    type IAgentRuntime,
    type Memory,
    type State,
} from '@elizaos/core';
import { BirdeyeProvider } from '../birdeye';
import { waitFor } from '../utils';

// This is a dummy action generated solely to test all Birdeye endpoints and should not be used in production
export const testAllEndpointsAction = {
    name: 'BIRDEYE_TEST_ALL_ENDPOINTS',
    similes: [],
    description: 'Test all Birdeye endpoints with sample data',
    handler: async (
        runtime: IAgentRuntime,
        _message: Memory,
        _state: State,
        _options: Record<string, unknown>,
        callback?: HandlerCallback
    ) => {
        try {
            elizaLogger.info('Testing all endpoints');

            await waitFor(1000);

            const birdeyeProvider = new BirdeyeProvider(runtime);

            // Sample data for testing
            const sampleParams = {
                token: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
                address: 'MfDuWeqSHEqTFVYZ7LoexgAK9dxk7cy4DFJWjWMGVWa',
                network: 'solana',
                list_address: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
                address_type: 'token',
                type: '1D',
                tx_type: 'all',
                sort_type: 'desc',
                unixtime: 1234567890,
                base_address: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
                quote_address: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
                time_to: 1672531199, // Unix timestamp
                meme_platform_enabled: true,
                time_frame: '1D',
                sort_by: undefined,
                list_addresses: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
                wallet: 'MfDuWeqSHEqTFVYZ7LoexgAK9dxk7cy4DFJWjWMGVWa',
                token_address: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
                pair: 'samplePair',
                before_time: 1672531199,
                after_time: 1672331199,
            };

            // Test each fetch function
            elizaLogger.info('fetchDefiSupportedNetworks');
            await birdeyeProvider.fetchDefiSupportedNetworks();
            elizaLogger.success('fetchDefiSupportedNetworks: SUCCESS!');
            await waitFor(500);

            elizaLogger.info('fetchDefiPrice');
            await birdeyeProvider.fetchDefiPrice({ ...sampleParams });
            elizaLogger.success('fetchDefiPrice: SUCCESS!');
            await waitFor(500);

            elizaLogger.info('fetchDefiPriceMultiple');
            await birdeyeProvider.fetchDefiPriceMultiple({ ...sampleParams });
            elizaLogger.success('fetchDefiPriceMultiple: SUCCESS!');
            await waitFor(500);

            elizaLogger.info('fetchDefiPriceMultiple_POST');
            await birdeyeProvider.fetchDefiPriceMultiple_POST({
                ...sampleParams,
            });
            elizaLogger.success('fetchDefiPriceMultiple_POST: SUCCESS!');
            await waitFor(500);

            elizaLogger.info('fetchDefiPriceHistorical');
            await birdeyeProvider.fetchDefiPriceHistorical({
                ...sampleParams,
                address_type: 'token',
                type: '1D',
            });
            elizaLogger.success('fetchDefiPriceHistorical: SUCCESS!');
            await waitFor(500);

            elizaLogger.info('fetchDefiPriceHistoricalByUnixTime');
            await birdeyeProvider.fetchDefiPriceHistoricalByUnixTime({
                address: sampleParams.token,
            });
            elizaLogger.success('fetchDefiPriceHistoricalByUnixTime: SUCCESS!');
            await waitFor(500);

            elizaLogger.info('fetchDefiTradesToken');
            await birdeyeProvider.fetchDefiTradesToken({
                address: sampleParams.token,
            });
            elizaLogger.success('fetchDefiTradesToken: SUCCESS!');
            await waitFor(500);

            elizaLogger.info('fetchDefiTradesPair');
            await birdeyeProvider.fetchDefiTradesPair({
                address: sampleParams.token,
            });
            elizaLogger.success('fetchDefiTradesPair: SUCCESS!');
            await waitFor(500);

            elizaLogger.info('fetchDefiTradesTokenSeekByTime');
            await birdeyeProvider.fetchDefiTradesTokenSeekByTime({
                address: sampleParams.token,
                before_time: sampleParams.before_time,
            });
            elizaLogger.success('fetchDefiTradesTokenSeekByTime: SUCCESS!');
            await waitFor(500);

            elizaLogger.info('fetchDefiTradesPairSeekByTime');
            await birdeyeProvider.fetchDefiTradesPairSeekByTime({
                address: sampleParams.token,
                after_time: sampleParams.after_time,
            });
            elizaLogger.success('fetchDefiTradesPairSeekByTime: SUCCESS!');
            await waitFor(500);

            elizaLogger.info('fetchDefiOHLCV');
            await birdeyeProvider.fetchDefiOHLCV({
                ...sampleParams,
                type: '1D',
            });
            elizaLogger.success('fetchDefiOHLCV: SUCCESS!');
            await waitFor(500);

            elizaLogger.info('fetchDefiOHLCVPair');
            await birdeyeProvider.fetchDefiOHLCVPair({
                ...sampleParams,
                type: '1D',
            });
            elizaLogger.success('fetchDefiOHLCVPair: SUCCESS!');
            await waitFor(500);

            elizaLogger.info('fetchDefiOHLCVBaseQuote');
            await birdeyeProvider.fetchDefiOHLCVBaseQuote({
                ...sampleParams,
                type: '1D',
            });
            elizaLogger.success('fetchDefiOHLCVBaseQuote: SUCCESS!');
            await waitFor(500);

            elizaLogger.info('fetchDefiPriceVolume');
            await birdeyeProvider.fetchDefiPriceVolume({
                address: sampleParams.token,
            });
            elizaLogger.success('fetchDefiPriceVolume: SUCCESS!');
            await waitFor(500);

            // this endpoint is for enterprise users only
            // elizaLogger.info("fetchDefiPriceVolumeMulti_POST");
            // await birdeyeProvider.fetchDefiPriceVolumeMulti_POST({
            //     list_address: sampleParams.token,
            // });
            // elizaLogger.success("fetchDefiPriceVolumeMulti_POST: SUCCESS!");
            // await waitFor(500);

            elizaLogger.info('fetchTokenList');
            await birdeyeProvider.fetchTokenList({
                ...sampleParams,
                sort_by: 'mc',
                sort_type: 'desc',
            });
            elizaLogger.success('fetchTokenList: SUCCESS!');
            await waitFor(500);

            elizaLogger.info('fetchTokenSecurityByAddress');
            await birdeyeProvider.fetchTokenSecurityByAddress({
                ...sampleParams,
            });
            elizaLogger.success('fetchTokenSecurityByAddress: SUCCESS!');
            await waitFor(500);

            elizaLogger.info('fetchTokenOverview');
            await birdeyeProvider.fetchTokenOverview({ ...sampleParams });
            elizaLogger.success('fetchTokenOverview: SUCCESS!');
            await waitFor(500);

            elizaLogger.info('fetchTokenCreationInfo');
            await birdeyeProvider.fetchTokenCreationInfo({ ...sampleParams });
            elizaLogger.success('fetchTokenCreationInfo: SUCCESS!');
            await waitFor(500);

            elizaLogger.info('fetchTokenTrending');
            await birdeyeProvider.fetchTokenTrending({
                ...sampleParams,
                sort_by: 'volume24hUSD',
                sort_type: 'desc',
            });
            elizaLogger.success('fetchTokenTrending: SUCCESS!');
            await waitFor(500);

            // this endpoint is for enterprise users only
            // elizaLogger.info("fetchTokenListV2_POST");
            // await birdeyeProvider.fetchTokenListV2_POST({});
            // elizaLogger.success("fetchTokenListV2_POST: SUCCESS!");
            // await waitFor(500);

            elizaLogger.info('fetchTokenNewListing');
            await birdeyeProvider.fetchTokenNewListing({
                time_to: Date.now(),
                meme_platform_enabled: true,
            });
            elizaLogger.success('fetchTokenNewListing: SUCCESS!');
            await waitFor(500);

            elizaLogger.info('fetchTokenTopTraders');
            await birdeyeProvider.fetchTokenTopTraders({
                ...sampleParams,
                time_frame: '24h',
                sort_type: 'asc',
                sort_by: 'volume',
            });
            elizaLogger.success('fetchTokenTopTraders: SUCCESS!');
            await waitFor(500);

            elizaLogger.info('fetchTokenAllMarketsList');
            await birdeyeProvider.fetchTokenAllMarketsList({
                ...sampleParams,
                time_frame: '12H',
                sort_type: 'asc',
                sort_by: 'volume24h',
            });
            elizaLogger.success('fetchTokenAllMarketsList: SUCCESS!');
            await waitFor(500);

            elizaLogger.info('fetchTokenMetadataSingle');
            await birdeyeProvider.fetchTokenMetadataSingle({ ...sampleParams });
            elizaLogger.success('fetchTokenMetadataSingle: SUCCESS!');
            await waitFor(500);

            // this endpoint is for enterprise users only
            // elizaLogger.info("fetchTokenMetadataMulti");
            // await birdeyeProvider.fetchTokenMetadataMulti({ ...sampleParams });
            // elizaLogger.success("fetchTokenMetadataMulti: SUCCESS!");
            // await waitFor(500);

            elizaLogger.info('fetchTokenMarketData');
            await birdeyeProvider.fetchTokenMarketData({ ...sampleParams });
            elizaLogger.success('fetchTokenMarketData: SUCCESS!');
            await waitFor(500);

            elizaLogger.info('fetchTokenTradeDataSingle');
            await birdeyeProvider.fetchTokenTradeDataSingle({
                ...sampleParams,
            });
            elizaLogger.success('fetchTokenTradeDataSingle: SUCCESS!');
            await waitFor(500);

            // this endpoint is for enterprise users only
            // elizaLogger.info("fetchTokenTradeDataMultiple");
            // await birdeyeProvider.fetchTokenTradeDataMultiple({
            //     ...sampleParams,
            // });
            // elizaLogger.success("fetchTokenTradeDataMultiple: SUCCESS!");
            // await waitFor(500);

            elizaLogger.info('fetchTokenHolders');
            await birdeyeProvider.fetchTokenHolders({ ...sampleParams });
            elizaLogger.success('fetchTokenHolders: SUCCESS!');
            await waitFor(500);

            elizaLogger.info('fetchTokenMintBurn');
            await birdeyeProvider.fetchTokenMintBurn({
                ...sampleParams,
                sort_by: 'block_time',
                sort_type: 'desc',
                type: 'all',
            });
            elizaLogger.success('fetchTokenMintBurn: SUCCESS!');
            await waitFor(500);

            elizaLogger.info('fetchWalletSupportedNetworks');
            await birdeyeProvider.fetchWalletSupportedNetworks();
            elizaLogger.success('fetchWalletSupportedNetworks: SUCCESS!');
            await waitFor(500);

            elizaLogger.info('fetchWalletPortfolio');
            await birdeyeProvider.fetchWalletPortfolio({ ...sampleParams });
            elizaLogger.success('fetchWalletPortfolio: SUCCESS!');
            await waitFor(500);

            // elizaLogger.info("fetchWalletPortfolioMultichain");
            // await birdeyeProvider.fetchWalletPortfolioMultichain({
            //     ...sampleParams,
            // });
            // elizaLogger.success("fetchWalletPortfolioMultichain: SUCCESS!");
            // await waitFor(500);

            elizaLogger.info('fetchWalletTokenBalance');
            await birdeyeProvider.fetchWalletTokenBalance({ ...sampleParams });
            elizaLogger.success('fetchWalletTokenBalance: SUCCESS!');
            await waitFor(500);

            elizaLogger.info('fetchWalletTransactionHistory');
            await birdeyeProvider.fetchWalletTransactionHistory({
                ...sampleParams,
            });
            elizaLogger.success('fetchWalletTransactionHistory: SUCCESS!');
            await waitFor(500);

            // elizaLogger.info("fetchWalletTransactionHistoryMultichain");
            // await birdeyeProvider.fetchWalletTransactionHistoryMultichain({
            //     ...sampleParams,
            // });
            // elizaLogger.success(
            //     "fetchWalletTransactionHistoryMultichain: SUCCESS!"
            // );
            // await waitFor(500);

            elizaLogger.info('fetchWalletTransactionSimulate_POST');
            await birdeyeProvider.fetchWalletTransactionSimulate_POST({
                from: sampleParams.token,
                to: sampleParams.token,
                data: JSON.stringify({ test: 'ok' }),
                value: '100000',
            });
            elizaLogger.success('fetchWalletTransactionSimulate_POST: SUCCESS!');
            await waitFor(500);

            elizaLogger.info('fetchTraderGainersLosers');
            await birdeyeProvider.fetchTraderGainersLosers({
                ...sampleParams,
                type: 'today',
                sort_type: 'asc',
                sort_by: 'PnL',
            });
            elizaLogger.success('fetchTraderGainersLosers: SUCCESS!');
            await waitFor(500);

            elizaLogger.info('fetchTraderTransactionsSeek');
            await birdeyeProvider.fetchTraderTransactionsSeek({
                ...sampleParams,
                tx_type: 'all',
                before_time: undefined,
            });
            elizaLogger.success('fetchTraderTransactionsSeek: SUCCESS!');
            await waitFor(500);

            elizaLogger.info('fetchPairOverviewSingle');
            await birdeyeProvider.fetchPairOverviewSingle({ ...sampleParams });
            elizaLogger.success('fetchPairOverviewSingle: SUCCESS!');
            await waitFor(500);

            // this endpoint is for enterprise users only
            // elizaLogger.info("fetchMultiPairOverview");
            // await birdeyeProvider.fetchMultiPairOverview({ ...sampleParams });
            // elizaLogger.success("fetchMultiPairOverview: SUCCESS!");
            // await waitFor(500);

            // this endpoint is for enterprise users only
            // elizaLogger.info("fetchPairOverviewMultiple");
            // await birdeyeProvider.fetchPairOverviewMultiple({
            //     ...sampleParams,
            // });
            // elizaLogger.success("fetchPairOverviewMultiple: SUCCESS!");
            // await waitFor(500);

            elizaLogger.info('fetchSearchTokenMarketData');
            await birdeyeProvider.fetchSearchTokenMarketData({
                ...sampleParams,
                sort_type: 'asc',
            });
            elizaLogger.success('fetchSearchTokenMarketData: SUCCESS!');
            await waitFor(500);

            elizaLogger.info('All endpoints tested successfully');
            callback?.({ text: 'All endpoints tested successfully!' });
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            runtime.logger?.error('Error in testAllEndpointsAction:', errorMessage);
            callback?.({ text: `Error: ${errorMessage}` });
        }
    },
    validate: async (_runtime: IAgentRuntime, message: Memory) => {
        // only run if explicitly triggered by user
        return message.content?.text?.includes('BIRDEYE_TEST_ALL_ENDPOINTS') ?? false;
    },
    examples: [
        [
            {
                name: '{{name1}}',
                content: {
                    text: 'I want you to BIRDEYE_TEST_ALL_ENDPOINTS',
                    action: 'BIRDEYE_TEST_ALL_ENDPOINTS',
                },
            },
        ],
    ] as ActionExample[][],
} as Action;
