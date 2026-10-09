// Wires hosted Eliza agent index behavior for cloud runtime services.
import { webSearch } from "./action";
import { WebSearchService } from "./service";

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
