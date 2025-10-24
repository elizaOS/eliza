export interface IKVStore<T, M = undefined> {
  get(key: string): Promise<T | undefined>;
  set(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  entries(): AsyncGenerator<[string, T]>;
  getMetrics?(): Promise<M>;
}

export interface IKVStoreService {
  getStore<T, M = undefined>(name: string): IKVStore<T, M>;
}

export function isKVStoreService(service: any): service is IKVStoreService {
  return service && 'getStore' in service;
}
