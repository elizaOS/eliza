// spec/os/appUpdate/policy.md, "Story: Update my apps only when it is safe and on time"
import type { Driver, Options } from "../../gen/os__appUpdate__policy.conformance.ts";
import { jvmDriver } from "./jvm-adapter.ts";

export const driver: Driver & AsyncDisposable = jvmDriver("ai.eliza.plugins.agent.updater.policy.PolicyAdapter", { receives: true });

export const options: Options = { keys: ["device"] };
