import { ElizaClient as _ElizaClient, type ElizaClient } from "./client-base";

export { ElizaClient } from "./client-base";

// ---------------------------------------------------------------------------
// Domain method augmentations (declaration merging + prototype assignment)
// These import ElizaClient from client-base directly, avoiding circular deps.
// ---------------------------------------------------------------------------
import "./client-agent";
import "./client-accounts";
import "./client-approvals";
import "./client-automations";
import "./client-background";
import "./client-browser-workspace";
import "./client-chat";
import "./client-cloud";
import "./client-computeruse";
import "./client-files";
import "./client-imessage";
import "./client-local-inference";
import "./client-meetings";
import "./client-notifications";
import "./client-scheduled-tasks";
import "./client-voice-models";
import "./client-workflow";
import "./client-skills";
import "./client-transcripts";
import "./client-vault";
import "./client-wallet";
// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------
// External plugins augment ElizaClient via `declare module "@elizaos/ui"`.
// Annotating with ElizaClient (which TypeScript normalizes to the canonical
// @elizaos/ui export) makes augmented methods visible to callers. The
// prototype has all methods at runtime via the augmenting side-effect imports.
export const client: ElizaClient = new _ElizaClient();
