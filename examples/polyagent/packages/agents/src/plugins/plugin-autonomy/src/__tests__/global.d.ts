declare global {
  let testHarness: { cleanup: () => Promise<void> } | undefined;
}

export {};
