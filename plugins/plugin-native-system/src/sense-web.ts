import type { SensePlugin } from "./sense";
/** A web page cannot observe or control the separately installed image listener. */
export class SenseWeb implements SensePlugin {
  async status() {
    return { available: false } as const;
  }
  async pause() {
    return { available: false } as const;
  }
  async turnOff() {
    return { available: false } as const;
  }
  async openSettings() {
    return { opened: false };
  }
  async bindInvocationSession() {}
  async takeInvocation() {
    return { assistant: false, invocation: null, locked: true };
  }
}
