export const delay = <T>(ms: number = 0, value?: T): Promise<T> =>
  new Promise((resolve) => setTimeout(() => resolve(value), ms));

export async function isResolved(promise) {
  return await Promise.race([
    delay(0, false),
    promise.then(
      () => true,
      () => false
    ),
  ]);
}

export async function isRejected(promise) {
  return await Promise.race([
    delay(0, false),
    promise.then(
      () => false,
      () => true
    ),
  ]);
}

export async function isFinished(promise) {
  return await Promise.race([
    delay(0, false),
    promise.then(
      () => true,
      () => true
    ),
  ]);
}
