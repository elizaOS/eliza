import { webSearch } from "./actions/webSearch";
import { WebSearchService } from "./services/searchService";

export const webSearchPlugin = {
  name: "webSearch",
  description: "Search the web using hosted Google Search grounding via Gemini",
  actions: [webSearch],
  evaluators: [],
  providers: [],
  services: [WebSearchService],
  clients: [],
  adapters: [],
};

export default webSearchPlugin;
