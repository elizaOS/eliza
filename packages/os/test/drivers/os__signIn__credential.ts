// spec/os/signIn/credential.md, "Story: Keep me signed in without a second copy of my key"; spec/os/signIn/credential.md, "Story: Sign out or reset cleanly"; spec/os/signIn/credential.md, "Story: Confirm it is me before a billing change"
import type { Driver, Options } from "../../gen/os__signIn__credential.conformance.ts";
import { jvmDriver } from "./jvm-adapter.ts";

export const driver: Driver = jvmDriver("ai.eliza.plugins.signin.CredentialReplay");

export const options: Options = { keys: ["device"] };
