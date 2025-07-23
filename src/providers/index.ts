import { State, UUID, type Provider } from "@elizaos/core";
import { LEVVA_SERVICE } from "../constants/enum";
import { RawMessage } from "../types/core";
import { getChain, getLevvaUser, parseTokenInfo } from "../util";
import { LevvaService } from "../services/levva/class";

interface Token {
  symbol: string;
  name: string;
  decimals: number;
  address?: string;
  info?: Record<string, any>;
}

export interface LevvaProviderState {
  chainId: number;
  user?: { id: UUID; address: `0x${string}` };
  tokens?: Token[];
  bySymbol?: Record<string, Token>;
  byAddress?: Record<`0x${string}`, Token>;
}

const groupTokens = (tokens: Token[]) => {
  const pendle: Token[] = [];
  const common: Token[] = [];
  const byAddress: Record<`0x${string}`, Token> = {};
  const bySymbol: Record<string, Token> = {};

  for (const token of tokens) {
    const info = parseTokenInfo(token.info);
    bySymbol[token.symbol] = token;

    if (token.address) {
      byAddress[token.address] = token;
    }

    if (info.swap?.type === "pendle") {
      pendle.push(token);
    } else {
      common.push(token);
    }
  }

  return { pendle, common, bySymbol, byAddress };
};

export const selectLevvaState = (
  state: State
): LevvaProviderState | undefined =>
  "levva" in state.data.providers
    ? (state.data.providers.levva as { data: LevvaProviderState }).data
    : undefined;

// provider text gets inserted after system prompt, so add levva-specific prompts
const prompts = [
  "User handles transaction signing.",
  "Expect that user should either wish to cancel transaction or confirm it by sending JSON object with transaction receipt.",
].join(" ");

export const levvaProvider: Provider = {
  name: "levva",
  description: "Levva provider",
  async get(runtime, message, state) {
    const raw: RawMessage = (message.metadata as unknown as { raw: RawMessage })
      .raw;

    const chainId = (raw.metadata.chainId ?? 1) as number;
    const userId = raw.senderId;
    const user = (await getLevvaUser(runtime, { id: userId }))[0];

    if (!user) {
      return {
        text: "Levva user not found",
        data: {
          chainId,
        },
      };
    }

    const service = runtime.getService<LevvaService>(
      LEVVA_SERVICE.LEVVA_COMMON
    );

    if (!service) {
      throw new Error("Failed to get levva service, disable action");
    }

    const tokens = await service.getAvailableTokens({ chainId });
    // @ts-expect-error TODO fix types
    const { pendle, common, byAddress, bySymbol } = groupTokens(tokens);

    const addressText = `Found levva user with address ${user.address}.`;
    const tokenText = `Known asset symbols:
PENDLE: ${pendle.map((v) => v.symbol).join(", ")}.
COMMON: ${common.map((v) => v.symbol).join(", ")}.`;

    return {
      text: `${prompts}
Selected EVM chain: ${getChain(chainId).name}.
${addressText}
${tokenText}`,
      data: {
        chainId,
        user,
        tokens,
        byAddress,
        bySymbol,
      },
      values: {
        user: addressText,
        tokens: tokenText,
      },
    };
  },
};
