import { LEVVA_API_V1_BASEURL } from "./constants";
import { strategiesResponseSchema } from "./schema";

// todo config
export const getStrategies = async (chainId: number) => {
  const url = `${LEVVA_API_V1_BASEURL}/strategies?PublicChainId=${chainId}`;
  const response = await fetch(url);
  const data = await response.json();
  return strategiesResponseSchema.safeParse(data);
};