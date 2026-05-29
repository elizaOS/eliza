export {};

declare global {
  interface Window {
    __accessToken?: string | null;
    __getAccessToken?: () => Promise<string | null>;
  }
}
