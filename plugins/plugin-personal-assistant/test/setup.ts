import { vi } from "vitest";
import Module from "node:module";

const requireFromHere = Module.createRequire(import.meta.url);
const react = requireFromHere("react") as typeof import("react");
const reactDom = requireFromHere("react-dom") as typeof import("react-dom");
const reactDomClient = requireFromHere(
  "react-dom/client",
) as typeof import("react-dom/client");
const reactDomServer = requireFromHere(
  "react-dom/server",
) as typeof import("react-dom/server");

vi.mock("react", () => ({ ...react, default: react }));
vi.mock("react-dom", () => ({ ...reactDom, default: reactDom }));
vi.mock("react-dom/client", () => ({
  ...reactDomClient,
  default: reactDomClient,
}));
vi.mock("react-dom/server", () => ({
  ...reactDomServer,
  default: reactDomServer,
}));

vi.mock("@elizaos/agent", async () => import("./stubs/agent.ts"));
vi.mock("@elizaos/ui", async () => import("./stubs/ui.ts"));
vi.mock(
  "@elizaos/plugin-google",
  async () => import("./stubs/plugin-google.ts"),
);
