/** Captures host executable authority before any test fixture mutates PATH. */

import { captureHostExecutionBaseline } from "@elizaos/core/host-execution-env";

captureHostExecutionBaseline();
