/**
 * Fresh-process harness for the cross-instance env mirror: reads the baseline
 * WITHOUT ever calling capture, as an externalized second module instance
 * (e.g. plugin-coding-tools inside a bundled ACP child) would.
 */

import { getHostExecutionBaseline } from "./host-execution-env.ts";

process.stdout.write(JSON.stringify(getHostExecutionBaseline()));
