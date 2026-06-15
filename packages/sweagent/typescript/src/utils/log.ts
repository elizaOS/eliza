export function getLogger(name: string) {
  const prefix = `[sweagent:${name}]`;
  return {
    info: (...args: unknown[]) => console.log(prefix, ...args),
    error: (...args: unknown[]) => console.error(prefix, ...args),
  };
}
