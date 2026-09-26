/** Restores fixture-owned method overrides without shadowing inherited runtime methods. */
export function snapshotRuntimeMethods(runtime: object): () => void {
  const descriptors = [
    "createTask",
    "getTasks",
    "deleteTask",
    "getService",
  ].map(
    (name) => [name, Object.getOwnPropertyDescriptor(runtime, name)] as const,
  );
  return () => {
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(runtime, name, descriptor);
      else Reflect.deleteProperty(runtime, name);
    }
  };
}
