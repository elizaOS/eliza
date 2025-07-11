import { State, UUID, type Provider } from "@elizaos/core";
import { RawMessage } from "../types/core";
import { getChain, getLevvaUser } from "../util";
import { ILevvaService } from "src/types/service";
import { LEVVA_SERVICE } from "src/constants/enum";

export interface LevvaProviderState {
  chainId: number;
  user?: { id: UUID; address: `0x${string}` };
  tokens?: { symbol: string, name: string, decimals: number, address?: string, info?: Record<string, any> }[];
}

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

    const service = runtime.getService<ILevvaService>(
      LEVVA_SERVICE.LEVVA_COMMON
    );

    const tokens = await service.getAvailableTokens({ chainId });
    const tokenSymbols = tokens.map((token) => token.symbol);
    const addressText = `Found levva user with address ${user.address}.`;

    return {
      text: `${prompts}
Selected EVM chain: ${getChain(chainId).name}.
${addressText}
Known token symbols: ${tokenSymbols.join(", ")}.`,
      data: {
        chainId,
        user,
        tokens
      },
      values: {
        user: addressText,
        tokens: tokenSymbols,
      },
    };
  },
};
