declare module "vitest" {
  export const describe: (...args: any[]) => any;
  export const it: (...args: any[]) => any;
  export const test: (...args: any[]) => any;
  export const expect: any;
  export const beforeEach: (...args: any[]) => any;
  export const afterEach: (...args: any[]) => any;
  export const beforeAll: (...args: any[]) => any;
  export const afterAll: (...args: any[]) => any;

  export const vi: {
    mock: (...args: any[]) => any;
    mocked: <T>(value: T) => any;
    clearAllMocks: () => void;
    restoreAllMocks: () => void;
    fn: (...args: any[]) => any;
  };
}
