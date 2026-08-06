import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ImperialClient,
  ImperialOrderSide,
  ImperialUnderwriter,
  buildImperialConnectMessage,
  buildImperialMarketOrder,
  encodeImperialMarketPrice,
  extractImperialMarkPrice,
  getImperialConfig,
  getImperialLiveReadiness,
  getTradingGateState,
} from './imperial.js';

describe('Imperial config', () => {
  test('defaults to Phoenix profile 0 and paper/read mode', () => {
    const config = getImperialConfig({});
    assert.equal(config.enabled, false);
    assert.equal(config.live, false);
    assert.equal(config.profileIndex, 0);
    assert.equal(config.defaultUnderwriter, ImperialUnderwriter.Phoenix);
    assert.deepEqual(config.allowedSymbols, ['SOL', 'ETH', 'BTC']);
  });

  test('uses IMPERIAL_JWT as a secret trading credential', () => {
    const config = getImperialConfig({
      IMPERIAL_WALLET: 'wallet-pubkey',
      IMPERIAL_JWT: 'jwt-value',
      IMPERIAL_PROFILE_INDEX: '2',
      IMPERIAL_ALLOWED_SYMBOLS: 'SOL,XAU',
      IMPERIAL_DEFAULT_UNDERWRITER: 'phoenix',
    });
    assert.equal(config.enabled, true);
    assert.equal(config.wallet, 'wallet-pubkey');
    assert.equal(config.jwt, 'jwt-value');
    assert.equal(config.profileIndex, 2);
    assert.deepEqual(config.allowedSymbols, ['SOL', 'XAU']);
  });

  test('requires both global and Imperial live gates', () => {
    const config = getImperialConfig({
      IMPERIAL_LIVE: 'true',
      IMPERIAL_WALLET: 'wallet-pubkey',
      IMPERIAL_JWT: 'jwt-value',
      IMPERIAL_PROFILE_INDEX: '0',
    });
    const paper = getTradingGateState({});
    assert.equal(getImperialLiveReadiness(config, paper).ok, false);

    const live = getTradingGateState({
      LIVE_TRADING: 'true',
      OPERATOR_CONFIRMED: 'true',
      PERPS_SIM_ONLY: 'false',
    });
    assert.equal(getImperialLiveReadiness(config, live).ok, true);
  });
});

describe('Imperial price and order encoding', () => {
  test('encodes marketPrice per underwriter scale', () => {
    assert.equal(encodeImperialMarketPrice(64.94, ImperialUnderwriter.Phoenix), 64940000);
    assert.equal(encodeImperialMarketPrice(64.94, ImperialUnderwriter.Jupiter), 64940000);
    assert.equal(encodeImperialMarketPrice(64.94, ImperialUnderwriter.GMTrade), 64940000000);
    assert.equal(encodeImperialMarketPrice(64.94, ImperialUnderwriter.FlashTradeV2), 0);
  });

  test('builds Phoenix market order payload with profileIndex and 6-decimal sizeUsd', () => {
    const config = getImperialConfig({
      IMPERIAL_WALLET: 'wallet-pubkey',
      IMPERIAL_JWT: 'jwt-value',
      IMPERIAL_PROFILE_INDEX: '1',
    });
    const order = buildImperialMarketOrder({
      config,
      symbol: 'sol',
      side: ImperialOrderSide.Short,
      notionalUsd: 125.5,
      leverage: 2,
      marketPriceUsd: 64.94,
    });

    assert.equal(order.wallet, 'wallet-pubkey');
    assert.equal(order.profileIndex, 1);
    assert.equal(order.symbol, 'SOL');
    assert.equal(order.underwriter, ImperialUnderwriter.Phoenix);
    assert.equal(order.side, ImperialOrderSide.Short);
    assert.equal(order.sizeUsd, 125500000);
    assert.equal(order.marketPrice, 64940000);
  });

  test('extracts Phoenix mark price from nested payloads', () => {
    const payload = {
      data: [
        { symbol: 'SOL', venue: 'jupiter', price: 63 },
        { symbol: 'SOL', venue: 'phoenix', price: 64.94 },
      ],
    };
    assert.equal(extractImperialMarkPrice(payload, 'SOL', ImperialUnderwriter.Phoenix), 64.94);
  });
});

describe('Imperial auth client', () => {
  test('builds the documented mobile connect message', () => {
    assert.equal(
      buildImperialConnectMessage('wallet-pubkey', 'nonce-1'),
      'imperial:mobile-connect:wallet-pubkey:nonce-1',
    );
  });

  test('posts mobile connect and exchange requests without auth header', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
      calls.push({ url, init });
      return new Response(JSON.stringify(calls.length === 1 ? { code: 'one-time-code' } : { jwt: 'jwt-value' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    const client = new ImperialClient(getImperialConfig({ IMPERIAL_API_BASE_URL: 'https://imperial.test/api/v1' }), fetchImpl);

    const connect = await client.connectMobile({ wallet: 'wallet', message: 'message', signature: 'signature' });
    const exchange = await client.exchangeMobileCode(connect.code ?? '');

    assert.equal(exchange.jwt, 'jwt-value');
    assert.equal(calls[0].url, 'https://imperial.test/api/v1/mobile/connect');
    assert.equal(calls[1].url, 'https://imperial.test/api/v1/mobile/exchange');
    assert.equal((calls[0].init?.headers as Record<string, string>).Authorization, undefined);
  });

  test('revoke uses bearer auth but never needs the raw JWT in output', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    };
    const client = new ImperialClient(getImperialConfig({
      IMPERIAL_API_BASE_URL: 'https://imperial.test/api/v1',
      IMPERIAL_WALLET: 'wallet',
      IMPERIAL_JWT: 'jwt-value',
    }), fetchImpl);

    await client.revokeMobileSession();

    assert.equal(calls[0].url, 'https://imperial.test/api/v1/mobile/revoke');
    assert.equal((calls[0].init?.headers as Record<string, string>).Authorization, 'Bearer jwt-value');
    assert.equal(calls[0].init?.body, JSON.stringify({ wallet: 'wallet' }));
  });

  test('registerPhoenix posts wallet and profile without bearer auth', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ profilePda: 'profile-pda', activated: true, message: 'ok' }), { status: 200 });
    };
    const client = new ImperialClient(getImperialConfig({
      IMPERIAL_API_BASE_URL: 'https://imperial.test/api/v1',
      IMPERIAL_WALLET: 'wallet',
      IMPERIAL_PROFILE_INDEX: '3',
    }), fetchImpl);

    const result = await client.registerPhoenix();

    assert.equal(result.profilePda, 'profile-pda');
    assert.equal(calls[0].url, 'https://imperial.test/api/v1/phoenix/register');
    assert.equal((calls[0].init?.headers as Record<string, string>).Authorization, undefined);
    assert.equal(calls[0].init?.body, JSON.stringify({ wallet: 'wallet', profileIndex: 3 }));
  });
});
