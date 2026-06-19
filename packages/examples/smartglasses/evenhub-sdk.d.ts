declare module "@evenrealities/even_hub_sdk" {
  export interface EvenHubBridge {
    onEvenHubEvent(callback: (event: unknown) => void): void;
  }

  export function waitForEvenAppBridge(): Promise<EvenHubBridge>;
}
