import { vi } from "vitest";

vi.mock("@elizaos/agent", async () => import("./stubs/agent.ts"));
vi.mock("@elizaos/ui", async () => import("./stubs/ui.ts"));
vi.mock("@elizaos/plugin-google", async () => import("./stubs/plugin-google.ts"));
