// spec/os/android/deepLinks.md, "Story: Open the link I followed exactly once, even across a cold start"; spec/os/android/deepLinks.md, "Story: Keep two links I followed apart, even when they are the same URL"
import type { PluginListenerHandle } from "@capacitor/core";
import type { Brand } from "effect";
import type { DeepLinks, LinkOutcome } from "../../../gen/os__android__deepLinks.ts";

export type { DeepLinks, LinkOutcome };

export type LinkReceipt = number & Brand.Brand<"LinkReceipt">;

export interface FollowedLink {
  readonly receipt: LinkReceipt;
  readonly url: string;
}

export interface DeepLinksNativePlugin {
  pending(): Promise<unknown>;
  acknowledge(options: { receipt: LinkReceipt; url: string }): Promise<unknown>;
  addListener(eventName: "linkCaptured", listener: (event: unknown) => void): Promise<PluginListenerHandle>;
}

export type LinkOpener = (url: string) => Promise<LinkOutcome>;

export interface DeepLinksClient {
  start(): Promise<void>;
  ready(): Promise<void>;
  poll(): Promise<void>;
  state(): Promise<DeepLinks>;
  stop(): Promise<void>;
}
