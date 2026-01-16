export {};

declare global {
  interface Window {
    __privyAccessToken?: string | null;
    __privyGetAccessToken?: () => Promise<string | null>;
  }
}
