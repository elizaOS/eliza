/**
 * @module tokens/registry
 * TokenRegistry — multi-chain token address registry for AgentWallet v6.
 *
 * Ships pre-populated with top tokens for all 11 supported EVM chains.
 * All addresses sourced from:
 *   - EVM: CoinGecko official token lists + chain explorers
 *   - USDC: https://developers.circle.com/stablecoins/usdc-contract-addresses
 *   - WBTC: https://wbtc.network/dashboard/order
 *   - WETH: official wrapped ETH contracts per chain
 *   - L2 native tokens: official L2 documentation
 *
 * Chain IDs follow the CHAIN_IDS map in src/types.ts.
 */

import type { Address } from "viem";
import { zeroAddress } from "viem";
import type { TokenInfo } from "./decimals.js";

export type { TokenInfo };

/** Full token entry stored in the registry */
export interface TokenEntry extends TokenInfo {
  chainId: number;
  name: string;
  isNative?: boolean; // true for native gas tokens (ETH, MATIC, etc.)
}

/** Params for adding a custom token */
export interface AddTokenParams {
  symbol: string;
  address: Address;
  decimals: number;
  chainId: number;
  name?: string;
  isNative?: boolean;
}

// ─── Chain IDs ───────────────────────────────────────────────────────────────

const CHAIN = {
  ETHEREUM: 1,
  BASE: 8453,
  ARBITRUM: 42161,
  OPTIMISM: 10,
  POLYGON: 137,
  AVALANCHE: 43114,
  UNICHAIN: 130,
  LINEA: 59144,
  SONIC: 146,
  WORLDCHAIN: 480,
  BASE_SEPOLIA: 84532,
} as const;

// ─── Pre-verified token address tables ───────────────────────────────────────
//
// All addresses are verified against:
//   - Etherscan (chain 1), Basescan (8453), Arbiscan (42161), Optimistic Etherscan (10),
//     Polygonscan (137), Snowtrace (43114), Lineascan (59144)
//   - CoinGecko token detail pages
//   - Circle USDC registry
//
// NATIVE_ADDR = zeroAddress (0x0000...0000) — used for native gas tokens

const NATIVE_ADDR = zeroAddress;

// ─── Native gas tokens ────────────────────────────────────────────────────────

const NATIVE_TOKENS: TokenEntry[] = [
  // ETH on ETH-compatible chains
  {
    chainId: CHAIN.ETHEREUM,
    address: NATIVE_ADDR,
    symbol: "ETH",
    name: "Ether",
    decimals: 18,
    isNative: true,
  },
  {
    chainId: CHAIN.BASE,
    address: NATIVE_ADDR,
    symbol: "ETH",
    name: "Ether",
    decimals: 18,
    isNative: true,
  },
  {
    chainId: CHAIN.ARBITRUM,
    address: NATIVE_ADDR,
    symbol: "ETH",
    name: "Ether",
    decimals: 18,
    isNative: true,
  },
  {
    chainId: CHAIN.OPTIMISM,
    address: NATIVE_ADDR,
    symbol: "ETH",
    name: "Ether",
    decimals: 18,
    isNative: true,
  },
  {
    chainId: CHAIN.UNICHAIN,
    address: NATIVE_ADDR,
    symbol: "ETH",
    name: "Ether",
    decimals: 18,
    isNative: true,
  },
  {
    chainId: CHAIN.LINEA,
    address: NATIVE_ADDR,
    symbol: "ETH",
    name: "Ether",
    decimals: 18,
    isNative: true,
  },
  {
    chainId: CHAIN.WORLDCHAIN,
    address: NATIVE_ADDR,
    symbol: "ETH",
    name: "Ether",
    decimals: 18,
    isNative: true,
  },
  {
    chainId: CHAIN.BASE_SEPOLIA,
    address: NATIVE_ADDR,
    symbol: "ETH",
    name: "Ether",
    decimals: 18,
    isNative: true,
  },
  // MATIC on Polygon
  {
    chainId: CHAIN.POLYGON,
    address: NATIVE_ADDR,
    symbol: "POL",
    name: "POL (ex-MATIC)",
    decimals: 18,
    isNative: true,
  },
  // AVAX on Avalanche
  {
    chainId: CHAIN.AVALANCHE,
    address: NATIVE_ADDR,
    symbol: "AVAX",
    name: "Avalanche",
    decimals: 18,
    isNative: true,
  },
  // S (Sonic's native token)
  {
    chainId: CHAIN.SONIC,
    address: NATIVE_ADDR,
    symbol: "S",
    name: "Sonic",
    decimals: 18,
    isNative: true,
  },
];

// ─── EVM token table ──────────────────────────────────────────────────────────
// Format: [chainId, address, symbol, name, decimals]
// Sources documented inline where non-obvious.

type RawEntry = [number, Address, string, string, number];

const EVM_TOKENS: RawEntry[] = [
  // ─── Ethereum Mainnet (1) ────────────────────────────────────────────────
  // USDC — Circle official
  [
    CHAIN.ETHEREUM,
    "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    "USDC",
    "USD Coin",
    6,
  ],
  // USDT — Tether official
  [
    CHAIN.ETHEREUM,
    "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    "USDT",
    "Tether USD",
    6,
  ],
  // DAI — MakerDAO
  [
    CHAIN.ETHEREUM,
    "0x6B175474E89094C44Da98b954EedeAC495271d0F",
    "DAI",
    "Dai Stablecoin",
    18,
  ],
  // WETH — official WETH9
  [
    CHAIN.ETHEREUM,
    "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    "WETH",
    "Wrapped Ether",
    18,
  ],
  // WBTC — BitGo wrapped BTC
  [
    CHAIN.ETHEREUM,
    "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
    "WBTC",
    "Wrapped BTC",
    8,
  ],
  // LINK — Chainlink
  [
    CHAIN.ETHEREUM,
    "0x514910771AF9Ca656af840dff83E8264EcF986CA",
    "LINK",
    "ChainLink Token",
    18,
  ],
  // UNI — Uniswap
  [
    CHAIN.ETHEREUM,
    "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984",
    "UNI",
    "Uniswap",
    18,
  ],
  // AAVE
  [
    CHAIN.ETHEREUM,
    "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9",
    "AAVE",
    "Aave Token",
    18,
  ],
  // CRV — Curve DAO Token
  [
    CHAIN.ETHEREUM,
    "0xD533a949740bb3306d119CC777fa900bA034cd52",
    "CRV",
    "Curve DAO Token",
    18,
  ],
  // MKR — MakerDAO
  [
    CHAIN.ETHEREUM,
    "0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2",
    "MKR",
    "Maker",
    18,
  ],
  // SNX — Synthetix
  [
    CHAIN.ETHEREUM,
    "0xC011a73ee8576Fb46F5E1c5751cA3B9Fe0af2a6F",
    "SNX",
    "Synthetix Network Token",
    18,
  ],
  // COMP — Compound
  [
    CHAIN.ETHEREUM,
    "0xc00e94Cb662C3520282E6f5717214004A7f26888",
    "COMP",
    "Compound",
    18,
  ],
  // LDO — Lido DAO
  [
    CHAIN.ETHEREUM,
    "0x5A98FcBEA516Cf06857215779Fd812CA3beF1B32",
    "LDO",
    "Lido DAO Token",
    18,
  ],
  // MATIC (ERC-20 on ETH, now POL)
  [
    CHAIN.ETHEREUM,
    "0x7D1AfA7B718fb893dB30A3aBc0Cfc608AaCfeBB0",
    "POL",
    "POL (ex-MATIC)",
    18,
  ],

  // ─── Base Mainnet (8453) ─────────────────────────────────────────────────
  [
    CHAIN.BASE,
    "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "USDC",
    "USD Coin",
    6,
  ],
  [
    CHAIN.BASE,
    "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2",
    "USDT",
    "Tether USD",
    6,
  ],
  [
    CHAIN.BASE,
    "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb",
    "DAI",
    "Dai Stablecoin",
    18,
  ],
  [
    CHAIN.BASE,
    "0x4200000000000000000000000000000000000006",
    "WETH",
    "Wrapped Ether",
    18,
  ],
  // WBTC on Base — bridged via LayerZero
  [
    CHAIN.BASE,
    "0x0555E30da8f98308EdB960aa94C0Db47230d2B9c",
    "WBTC",
    "Wrapped BTC",
    8,
  ],
  [
    CHAIN.BASE,
    "0xE3B53AF74a4BF62Ae5511055290838050bf764Df",
    "LINK",
    "ChainLink Token",
    18,
  ],
  [
    CHAIN.BASE,
    "0xc3De830EA07524a0761646a6a4e4be0e114a3C83",
    "AAVE",
    "Aave Token",
    18,
  ],
  // cbETH — Coinbase Staked ETH
  [
    CHAIN.BASE,
    "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22",
    "cbETH",
    "Coinbase Staked Ether",
    18,
  ],
  // USDbC — Bridged USDC (legacy on Base)
  [
    CHAIN.BASE,
    "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA",
    "USDbC",
    "USD Base Coin",
    6,
  ],

  // ─── Arbitrum One (42161) ────────────────────────────────────────────────
  [
    CHAIN.ARBITRUM,
    "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    "USDC",
    "USD Coin",
    6,
  ],
  [
    CHAIN.ARBITRUM,
    "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
    "USDT",
    "Tether USD",
    6,
  ],
  [
    CHAIN.ARBITRUM,
    "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1",
    "DAI",
    "Dai Stablecoin",
    18,
  ],
  [
    CHAIN.ARBITRUM,
    "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
    "WETH",
    "Wrapped Ether",
    18,
  ],
  [
    CHAIN.ARBITRUM,
    "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f",
    "WBTC",
    "Wrapped BTC",
    8,
  ],
  [
    CHAIN.ARBITRUM,
    "0xf97f4df75117a78c1A5a0DBb814Af92458539FB4",
    "LINK",
    "ChainLink Token",
    18,
  ],
  [
    CHAIN.ARBITRUM,
    "0xFa7F8980b0f1E64A2062791cc3b0871572f1F7f0",
    "UNI",
    "Uniswap",
    18,
  ],
  [
    CHAIN.ARBITRUM,
    "0xba5DdD1f9d7F570dc94a51479a000E3BCE967196",
    "AAVE",
    "Aave Token",
    18,
  ],
  // ARB — Arbitrum governance token (native to Arbitrum)
  [
    CHAIN.ARBITRUM,
    "0x912CE59144191C1204E64559FE8253a0e49E6548",
    "ARB",
    "Arbitrum",
    18,
  ],
  [
    CHAIN.ARBITRUM,
    "0x11cDb42B0EB46D95f990BeDD4695A6e3fA034978",
    "CRV",
    "Curve DAO Token",
    18,
  ],
  [
    CHAIN.ARBITRUM,
    "0x13Ad51ed4F1B7e9Dc168d8a00cB3f4dDD85EfA60",
    "LDO",
    "Lido DAO Token",
    18,
  ],
  [
    CHAIN.ARBITRUM,
    "0x354A6dA3fcde098F8389cad84b0182725c6C91dE",
    "COMP",
    "Compound",
    18,
  ],

  // ─── Optimism (10) ───────────────────────────────────────────────────────
  [
    CHAIN.OPTIMISM,
    "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
    "USDC",
    "USD Coin",
    6,
  ],
  [
    CHAIN.OPTIMISM,
    "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58",
    "USDT",
    "Tether USD",
    6,
  ],
  [
    CHAIN.OPTIMISM,
    "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1",
    "DAI",
    "Dai Stablecoin",
    18,
  ],
  [
    CHAIN.OPTIMISM,
    "0x4200000000000000000000000000000000000006",
    "WETH",
    "Wrapped Ether",
    18,
  ],
  [
    CHAIN.OPTIMISM,
    "0x68f180fcCe6836688e9084f035309E29Bf0A2095",
    "WBTC",
    "Wrapped BTC",
    8,
  ],
  [
    CHAIN.OPTIMISM,
    "0x350a791Bfc2C21F9Ed5d10980Dad2e2638ffa7f6",
    "LINK",
    "ChainLink Token",
    18,
  ],
  [
    CHAIN.OPTIMISM,
    "0x6fd9d7AD17242c41f7131d257212c54A0e816691",
    "UNI",
    "Uniswap",
    18,
  ],
  [
    CHAIN.OPTIMISM,
    "0x76FB31fb4af56892A25e32cFC43De717950c9278",
    "AAVE",
    "Aave Token",
    18,
  ],
  // OP — Optimism governance token (native to Optimism)
  [
    CHAIN.OPTIMISM,
    "0x4200000000000000000000000000000000000042",
    "OP",
    "Optimism",
    18,
  ],
  [
    CHAIN.OPTIMISM,
    "0x9560e827aF36c94D2Ac33a39bCE1Fe78631088Db",
    "VELO",
    "Velodrome Finance",
    18,
  ],
  [
    CHAIN.OPTIMISM,
    "0xc5b001DC33727F8F26880B184090D3E252470D45",
    "SNX",
    "Synthetix",
    18,
  ],

  // ─── Polygon (137) ───────────────────────────────────────────────────────
  [
    CHAIN.POLYGON,
    "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
    "USDC",
    "USD Coin",
    6,
  ],
  [
    CHAIN.POLYGON,
    "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
    "USDT",
    "Tether USD",
    6,
  ],
  [
    CHAIN.POLYGON,
    "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063",
    "DAI",
    "Dai Stablecoin",
    18,
  ],
  [
    CHAIN.POLYGON,
    "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
    "WETH",
    "Wrapped Ether",
    18,
  ],
  [
    CHAIN.POLYGON,
    "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6",
    "WBTC",
    "Wrapped BTC",
    8,
  ],
  [
    CHAIN.POLYGON,
    "0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39",
    "LINK",
    "ChainLink Token",
    18,
  ],
  [
    CHAIN.POLYGON,
    "0xb33EaAd8d922B1083446DC23f610c2567fB5180f",
    "UNI",
    "Uniswap",
    18,
  ],
  [
    CHAIN.POLYGON,
    "0xD6DF932A45C0f255f85145f286eA0b292B21C90B",
    "AAVE",
    "Aave Token",
    18,
  ],
  // WMATIC — Wrapped POL (MATIC) on Polygon
  [
    CHAIN.POLYGON,
    "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
    "WMATIC",
    "Wrapped POL (MATIC)",
    18,
  ],
  [
    CHAIN.POLYGON,
    "0x172370d5Cd63279eFa6d502DAB29171933a610AF",
    "CRV",
    "Curve DAO Token",
    18,
  ],
  [
    CHAIN.POLYGON,
    "0x50B728D8D964fd00C2d0AAD81718b71311feF68a",
    "SNX",
    "Synthetix",
    18,
  ],

  // ─── Avalanche C-Chain (43114) ───────────────────────────────────────────
  [
    CHAIN.AVALANCHE,
    "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
    "USDC",
    "USD Coin",
    6,
  ],
  [
    CHAIN.AVALANCHE,
    "0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7",
    "USDT",
    "Tether USD",
    6,
  ],
  [
    CHAIN.AVALANCHE,
    "0xd586E7F844cEa2F87f50152665BCbc2C279D8d70",
    "DAI",
    "Dai Stablecoin",
    18,
  ],
  // WETH.e — Bridged Ether on Avalanche
  [
    CHAIN.AVALANCHE,
    "0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB",
    "WETH.e",
    "Wrapped Ether",
    18,
  ],
  [
    CHAIN.AVALANCHE,
    "0x50b7545627a5162F82A992c33b87aDc75187B218",
    "WBTC",
    "Wrapped BTC",
    8,
  ],
  [
    CHAIN.AVALANCHE,
    "0x5947BB275c521040051D82396192181b413227A3",
    "LINK",
    "ChainLink Token",
    18,
  ],
  [
    CHAIN.AVALANCHE,
    "0x8eBAf22B6F053dFFeaf46f4Dd9eFA95D89ba8580",
    "UNI",
    "Uniswap",
    18,
  ],
  // WAVAX — Wrapped AVAX
  [
    CHAIN.AVALANCHE,
    "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7",
    "WAVAX",
    "Wrapped AVAX",
    18,
  ],
  [
    CHAIN.AVALANCHE,
    "0x63a72806098Bd3D9520cC43356dD78afe5D386D9",
    "AAVE",
    "Aave Token",
    18,
  ],

  // ─── Unichain (130) ──────────────────────────────────────────────────────
  [
    CHAIN.UNICHAIN,
    "0x078D782b760474a361dDA0AF3839290b0EF57AD6",
    "USDC",
    "USD Coin",
    6,
  ],
  [
    CHAIN.UNICHAIN,
    "0x4200000000000000000000000000000000000006",
    "WETH",
    "Wrapped Ether",
    18,
  ],

  // ─── Linea (59144) ───────────────────────────────────────────────────────
  [
    CHAIN.LINEA,
    "0x176211869cA2b568f2A7D4EE941E073a821EE1ff",
    "USDC",
    "USD Coin",
    6,
  ],
  [
    CHAIN.LINEA,
    "0xA219439258ca9da29E9Cc4cE5596924745e12B93",
    "USDT",
    "Tether USD",
    6,
  ],
  [
    CHAIN.LINEA,
    "0x4AF15ec2A0BD43Db75dd04E62FAA3B8EF36b00d5",
    "DAI",
    "Dai Stablecoin",
    18,
  ],
  [
    CHAIN.LINEA,
    "0xe5D7C2a44FfDDf6b295A15c148167daaAf5Cf34f",
    "WETH",
    "Wrapped Ether",
    18,
  ],
  [
    CHAIN.LINEA,
    "0x3aAB2285ddcDdaD8edf438C1bAB47e1a9D05a9b4",
    "WBTC",
    "Wrapped BTC",
    8,
  ],

  // ─── Sonic (146) ─────────────────────────────────────────────────────────
  [
    CHAIN.SONIC,
    "0x29219dd400f2Bf60E5a23d13Be72B486D4038894",
    "USDC",
    "USD Coin",
    6,
  ],
  // WS — Wrapped Sonic (native S wrapped)
  [
    CHAIN.SONIC,
    "0x039e2fB66102314Ce7b64Ce5Ce3E5183bc94aD38",
    "WS",
    "Wrapped Sonic",
    18,
  ],

  // ─── World Chain (480) ───────────────────────────────────────────────────
  [
    CHAIN.WORLDCHAIN,
    "0x79A02482A880bCE3B13e09Da970dC34db4CD24d1",
    "USDC",
    "USD Coin",
    6,
  ],
  [
    CHAIN.WORLDCHAIN,
    "0x4200000000000000000000000000000000000006",
    "WETH",
    "Wrapped Ether",
    18,
  ],
  // WLD — Worldcoin token
  [
    CHAIN.WORLDCHAIN,
    "0x163f8C2467924be0ae7B5347228CABF260318753",
    "WLD",
    "Worldcoin",
    18,
  ],

  // ─── Base Sepolia Testnet (84532) ────────────────────────────────────────
  [
    CHAIN.BASE_SEPOLIA,
    "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    "USDC",
    "USD Coin",
    6,
  ],
  [
    CHAIN.BASE_SEPOLIA,
    "0x4200000000000000000000000000000000000006",
    "WETH",
    "Wrapped Ether",
    18,
  ],
];

// ─── TokenRegistry class ──────────────────────────────────────────────────────

export class TokenRegistry {
  private readonly tokens: Map<string, TokenEntry> = new Map();

  constructor(initialTokens?: TokenEntry[]) {
    // Load native gas tokens
    for (const t of NATIVE_TOKENS) {
      this._store(t);
    }
    // Load EVM tokens
    for (const [chainId, address, symbol, name, decimals] of EVM_TOKENS) {
      this._store({ chainId, address, symbol, name, decimals });
    }
    // Load any provided custom tokens
    if (initialTokens) {
      for (const t of initialTokens) {
        this._store(t);
      }
    }
  }

  private _key(symbol: string, chainId: number): string {
    return `${symbol.toUpperCase()}:${chainId}`;
  }

  private _store(entry: TokenEntry): void {
    const key = this._key(entry.symbol, entry.chainId);
    this.tokens.set(key, { ...entry });
  }

  /**
   * Add or overwrite a token in the registry.
   */
  addToken(params: AddTokenParams): void {
    const entry: TokenEntry = {
      symbol: params.symbol,
      address: params.address,
      decimals: params.decimals,
      chainId: params.chainId,
      name: params.name ?? params.symbol,
      isNative: params.isNative ?? false,
    };
    this._store(entry);
  }

  /**
   * Look up a token by symbol and chainId.
   * Returns undefined if not found.
   */
  getToken(symbol: string, chainId: number): TokenEntry | undefined {
    return this.tokens.get(this._key(symbol, chainId));
  }

  /**
   * List all tokens registered for a given chainId.
   */
  listTokens(chainId: number): TokenEntry[] {
    const result: TokenEntry[] = [];
    for (const entry of this.tokens.values()) {
      if (entry.chainId === chainId) result.push(entry);
    }
    return result;
  }

  /**
   * Find a token by its contract address on a given chain.
   */
  getTokenByAddress(address: Address, chainId: number): TokenEntry | undefined {
    const lower = address.toLowerCase();
    for (const entry of this.tokens.values()) {
      if (entry.chainId === chainId && entry.address.toLowerCase() === lower) {
        return entry;
      }
    }
    return undefined;
  }

  /**
   * Returns all registered tokens (all chains).
   */
  getAllTokens(): TokenEntry[] {
    return Array.from(this.tokens.values());
  }

  /**
   * Returns number of registered tokens.
   */
  size(): number {
    return this.tokens.size;
  }
}

// ─── Pre-built per-chain registries ──────────────────────────────────────────
// These are lazy singletons — constructed once on first import.

let _globalRegistry: TokenRegistry | null = null;

/** Global registry with all supported chains pre-populated. */
export function getGlobalRegistry(): TokenRegistry {
  if (!_globalRegistry) _globalRegistry = new TokenRegistry();
  return _globalRegistry;
}

/** Create a fresh registry pre-populated for a single chain.
 * @internal — reserved for future per-chain filtering API
 */
export function createChainRegistry(_chainId: number): TokenRegistry {
  return new TokenRegistry(); // loads all tokens; filter via listTokens(chainId)
}

// Named per-chain exports — each returns the global registry (all tokens loaded,
// filtered access via listTokens(chainId)). Use getGlobalRegistry() for multi-chain.
export const ETHEREUM_REGISTRY = new TokenRegistry();
export const BASE_REGISTRY = new TokenRegistry();
export const ARBITRUM_REGISTRY = new TokenRegistry();
export const OPTIMISM_REGISTRY = new TokenRegistry();
export const POLYGON_REGISTRY = new TokenRegistry();
export const AVALANCHE_REGISTRY = new TokenRegistry();
export const UNICHAIN_REGISTRY = new TokenRegistry();
export const LINEA_REGISTRY = new TokenRegistry();
export const SONIC_REGISTRY = new TokenRegistry();
export const WORLDCHAIN_REGISTRY = new TokenRegistry();
export const BASE_SEPOLIA_REGISTRY = new TokenRegistry();

// Convenience: get native gas token for a chain
export function getNativeToken(chainId: number): TokenEntry | undefined {
  return (
    getGlobalRegistry().getToken("ETH", chainId) ??
    getGlobalRegistry().getToken("POL", chainId) ??
    getGlobalRegistry().getToken("AVAX", chainId) ??
    getGlobalRegistry().getToken("S", chainId)
  );
}
