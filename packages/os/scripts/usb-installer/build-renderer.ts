// Electrobun lifecycle hooks execute a Bun file path, not a shell command.
import { build } from "vite";

await build();
