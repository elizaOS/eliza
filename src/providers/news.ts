import { Provider } from "@elizaos/core";
import { LEVVA_SERVICE } from "../constants/enum";
import { ILevvaService } from "../types/service";

export const newsProvider: Provider = {
  name: "CRYPTO_NEWS",
  description: "Latest crypto news",
  dynamic: true,
  async get(runtime) {
    const service = await runtime.getService<ILevvaService>(
      LEVVA_SERVICE.LEVVA_COMMON
    );

    if (!service) {
      return {
        text: "Dependency not found",
        values: {},
        data: {},
      };
    }

    const news = await service.getCryptoNews(20);
    const newsEntries = news.map((v) => `Title: ${v.title}\nDescription: ${v.description}\nLink: ${v.link}`);

    return {
      text: `Latest crypto news:\n${newsEntries.join("\n")}`,
      values: {
        cryptoNews: newsEntries,
      },
      data: {
        news,
      },
    };
  },
};
