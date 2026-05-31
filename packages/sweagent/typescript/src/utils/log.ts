export function getLogger(_name: string) {
  return {
    info: (...args: unknown[]) => console.log(...args),
    error: (...args: unknown[]) => console.error(...args),
  };
}
