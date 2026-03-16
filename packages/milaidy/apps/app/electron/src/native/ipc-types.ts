export type IpcPrimitive = string | number | boolean | null | undefined;

export interface IpcObject {
  [key: string]: IpcValue;
}

export type IpcValue =
  | IpcPrimitive
  | IpcObject
  | IpcValue[]
  | ArrayBuffer
  | Float32Array
  | Uint8Array;
