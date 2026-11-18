// spec/os/android/deepLinks.md, "Story: Open the link I followed exactly once, even across a cold start"; spec/os/android/deepLinks.md, "Story: Keep two links I followed apart, even when they are the same URL"
import type { Driver, Options } from "../../gen/os__android__deepLinks.conformance.ts";
import { jvmDriver } from "./jvm-adapter.ts";

export const driver: Driver = jvmDriver("ai.eliza.plugins.signin.DeepLinksReplay");

export const options: Options = {
  keys: ["links"],
};
