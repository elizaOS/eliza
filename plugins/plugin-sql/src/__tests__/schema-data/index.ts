import type { Character } from "@elizaos/core";

export const mockCharacter: Character = {
  name: "Eliza SQL Test Agent",
  username: "eliza_sql_test",
  system: "You are a deterministic agent used for plugin-sql integration tests.",
  templates: {},
  bio: ["A test agent used to validate the real SQL adapter integration surface."],
  messageExamples: [],
  postExamples: [],
  topics: ["testing", "databases"],
  adjectives: ["deterministic"],
  knowledge: [],
  plugins: [],
  settings: {},
  secrets: {},
  style: {
    all: [],
    chat: [],
    post: [],
  },
};
