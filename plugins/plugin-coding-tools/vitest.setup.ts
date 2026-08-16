/** Captures host executable authority before any test fixture mutates PATH. */

import { captureHostExecutionBaseline } from "@elizaos/shared/host-execution-env";

captureHostExecutionBaseline();
