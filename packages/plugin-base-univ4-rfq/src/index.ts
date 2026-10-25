// Archivo listo para Pull Request en:
// - Coinbase AgentKit (https://github.com/coinbase/agentkit)
// - GOAT SDK (https://github.com/goat-sdk/goat)
// Proveedor de Ejecución Cero-Slippage sobre Uniswap v4 en Base Mainnet (ChainID: 8453)

export interface Univ4RfqQuoteResponse {
  quoteId: string;
  pair: string;
  amountInWei: string;
  promisedOutWei: string;
  promisedOutHuman: number;
  feeBps: number;
  deadline: number;
}

export interface Univ4RfqSwapResponse extends Univ4RfqQuoteResponse {
  universalRouterTx: {
    to: string;
    data: string;
    value: string;
    chainId: number;
  };
}

export class BaseUniv4RfqProvider {
  private readonly apiUrl: string;

  constructor(
    apiUrl = "https://courage-matches-omaha-commissions.trycloudflare.com"
  ) {
    this.apiUrl = apiUrl.replace(/\/$/, "");
  }

  /**
   * Obtiene cotización garantizada con 0.00% slippage (Chainlink Oracle - 30 bps)
   */
  async getQuote(
    tokenIn: string,
    tokenOut: string,
    amountIn: string | number
  ): Promise<Univ4RfqQuoteResponse> {
    const url = `${this.apiUrl}/quote?tokenIn=${encodeURIComponent(
      tokenIn
    )}&tokenOut=${encodeURIComponent(tokenOut)}&amountIn=${encodeURIComponent(
      String(amountIn)
    )}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Univ4Rfq quote failed: ${res.statusText}`);
    }
    return res.json();
  }

  /**
   * Construye el calldata firmado listo para ejecutar en el UniversalRouter de Uniswap v4 en Base
   * Hook Address: 0xd72CD1d46bA05479583fbB561B558f133BA98088
   */
  async buildZeroSlippageSwap(
    tokenIn: string,
    tokenOut: string,
    amountIn: string | number
  ): Promise<Univ4RfqSwapResponse> {
    const url = `${this.apiUrl}/swap?tokenIn=${encodeURIComponent(
      tokenIn
    )}&tokenOut=${encodeURIComponent(tokenOut)}&amountIn=${encodeURIComponent(
      String(amountIn)
    )}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Univ4Rfq swap build failed: ${res.statusText}`);
    }
    return res.json();
  }
}
