declare module "dockerode" {
  type JsonPrimitive = string | number | boolean | null;
  type JsonValue =
    | JsonPrimitive
    | JsonValue[]
    | {
        [key: string]: JsonValue | undefined;
      };

  export interface ExecInspectResult {
    ExitCode?: number | null;
  }

  export interface ExecStartOptions {
    hijack?: boolean;
    stdin?: boolean;
  }

  export type ExecStream = NodeJS.ReadWriteStream & { destroy: () => void };

  export interface Exec {
    start(options?: ExecStartOptions): Promise<ExecStream>;
    inspect(): Promise<ExecInspectResult>;
  }

  export interface ContainerExecOptions {
    Cmd: string[];
    AttachStdin?: boolean;
    AttachStdout?: boolean;
    AttachStderr?: boolean;
    Tty?: boolean;
    Env?: string[];
    WorkingDir?: string;
  }

  export interface ContainerStopOptions {
    t?: number;
  }

  export interface PutArchiveOptions {
    path: string;
  }

  export interface Container {
    exec(options: ContainerExecOptions): Promise<Exec>;
    start(): Promise<void>;
    stop(options?: ContainerStopOptions): Promise<void>;
    kill(): Promise<void>;
    remove(): Promise<void>;
    putArchive(
      stream: NodeJS.ReadableStream,
      options: PutArchiveOptions,
    ): Promise<void>;
  }

  export interface ImageInfo {
    RepoTags?: string[];
  }

  export interface Modem {
    followProgress(
      stream: NodeJS.ReadableStream,
      callback: (err: Error | null, res: JsonValue[]) => void,
    ): void;
  }

  export interface ContainerCreateOptions {
    Image: string;
    name?: string;
    WorkingDir?: string;
    Env?: string[];
    Tty?: boolean;
    OpenStdin?: boolean;
    StdinOnce?: boolean;
    AttachStdin?: boolean;
    AttachStdout?: boolean;
    AttachStderr?: boolean;
    HostConfig?: JsonValue;
    [key: string]: JsonValue | undefined;
  }

  export default class Dockerode {
    constructor(options?: Record<string, JsonValue | undefined>);
    createContainer(options: ContainerCreateOptions): Promise<Container>;
    getContainer(id: string): Container;
    listContainers(
      options?: Record<string, JsonValue | undefined>,
    ): Promise<JsonValue[]>;
    listImages(
      options?: Record<string, JsonValue | undefined>,
    ): Promise<ImageInfo[]>;
    pull(
      image: string,
      options?: Record<string, JsonValue | undefined>,
    ): Promise<NodeJS.ReadableStream>;
    modem: Modem;
  }
}
