// spec/os/android/passwords/autofill.md, "Story: Fill a form only for its site, from my choice"; spec/os/android/passwords/autofill.md, "Story: Save a password only when I choose Save and unlock"
import type { Driver, Options } from "../../gen/os__android__passwords__autofill.conformance.ts";
import type { NativeAutofill } from "../../gen/os__android__passwords__autofill.ts";
import { jvmDriver } from "./jvm-adapter.ts";

export type HeldByJava = Omit<NativeAutofill, "elapsed" | "nextToken">;

export const driver: Driver<HeldByJava> = jvmDriver("ai.eliza.passwords.AutofillReplay");

export const options: Options<HeldByJava> = {
  keys: ["autofill"],
  view: ({ elapsed: _clock, nextToken: _issued, ...held }) => held,
};
