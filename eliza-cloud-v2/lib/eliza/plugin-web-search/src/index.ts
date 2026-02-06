import { webSearch } from "./actions/webSearch";
import { TavilyService } from "./services/tavilyService";

export const webSearchPlugin = {
  name: "webSearch",
  description: "Search the web using Tavily",
  actions: [webSearch],
  evaluators: [],
  providers: [],
  services: [TavilyService],
  clients: [],
  adapters: [],
};

export default webSearchPlugin;
