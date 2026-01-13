declare module 'dockerode' {
  export default class Dockerode {
    constructor(options?: Record<string, unknown>);
    createContainer(options: Record<string, unknown>): Promise<unknown>;
    getContainer(id: string): unknown;
    listContainers(options?: Record<string, unknown>): Promise<unknown[]>;
    listImages(options?: Record<string, unknown>): Promise<unknown[]>;
    pull(image: string, options?: Record<string, unknown>): Promise<unknown>;
    modem: unknown;
  }
}
