import {
  EVEN_G1_UART,
  type G1Event,
  type GlassSide,
  parseG1Notification,
  type SmartglassesAudioEncoding,
} from "../protocol.js";
import type { SmartglassesTransport } from "./types.js";

type BluetoothRemoteGATTCharacteristicLike = {
  value?: DataView;
  writeValueWithoutResponse?: (data: ArrayBuffer) => Promise<void>;
  writeValueWithResponse?: (data: ArrayBuffer) => Promise<void>;
  writeValue?: (data: ArrayBuffer) => Promise<void>;
  startNotifications: () => Promise<BluetoothRemoteGATTCharacteristicLike>;
  stopNotifications?: () => Promise<void>;
  addEventListener: (type: string, listener: (event: Event) => void) => void;
  removeEventListener?: (
    type: string,
    listener: (event: Event) => void,
  ) => void;
};

type BluetoothRemoteGATTServerLike = {
  connected?: boolean;
  getPrimaryService: (service: string) => Promise<{
    getCharacteristic: (
      characteristic: string,
    ) => Promise<BluetoothRemoteGATTCharacteristicLike>;
  }>;
  disconnect?: () => void;
};

type BluetoothDeviceLike = {
  name?: string;
  gatt?: {
    connect: () => Promise<BluetoothRemoteGATTServerLike>;
  };
};

type NavigatorBluetoothLike = {
  requestDevice: (options: {
    filters?: Array<{ namePrefix?: string; services?: string[] }>;
    optionalServices?: string[];
  }) => Promise<BluetoothDeviceLike>;
};

type SideConnection = {
  device: BluetoothDeviceLike;
  server: BluetoothRemoteGATTServerLike;
  tx: BluetoothRemoteGATTCharacteristicLike;
  rx: BluetoothRemoteGATTCharacteristicLike;
  listener: (event: Event) => void;
};

export class WebBluetoothG1Transport implements SmartglassesTransport {
  readonly name = "web-bluetooth-g1";
  private readonly sides = new Map<GlassSide, SideConnection>();
  private eventCallbacks = new Set<(event: G1Event) => void>();
  private audioCallbacks = new Set<
    (
      audioData: Uint8Array,
      sampleRate: number,
      side: GlassSide,
      encoding?: SmartglassesAudioEncoding,
      sequence?: number,
    ) => void
  >();

  constructor(
    private readonly bluetooth: NavigatorBluetoothLike = getNavigatorBluetooth(),
  ) {}

  async connect(): Promise<void> {
    await this.connectLens("left");
    await this.connectLens("right");
  }

  async disconnect(): Promise<void> {
    for (const [side, connection] of this.sides) {
      await connection.rx.stopNotifications?.();
      connection.rx.removeEventListener?.(
        "characteristicvaluechanged",
        connection.listener,
      );
      connection.server.disconnect?.();
      this.sides.delete(side);
    }
  }

  isConnected(): boolean {
    return (
      this.sides.size === 2 &&
      [...this.sides.values()].every(
        (connection) => connection.server.connected !== false,
      )
    );
  }

  async write(side: GlassSide, data: Uint8Array): Promise<void> {
    const connection = this.sides.get(side);
    if (!connection) throw new Error(`G1 ${side} lens is not connected`);
    const buffer = toArrayBuffer(data);
    if (connection.tx.writeValueWithoutResponse) {
      await connection.tx.writeValueWithoutResponse(buffer);
      return;
    }
    if (connection.tx.writeValueWithResponse) {
      await connection.tx.writeValueWithResponse(buffer);
      return;
    }
    await connection.tx.writeValue?.(buffer);
  }

  async writeBoth(data: Uint8Array): Promise<void> {
    await this.write("left", data);
    await this.write("right", data);
  }

  async openMicrophone(enabled: boolean): Promise<void> {
    const { encodeMicCommand } = await import("../protocol.js");
    await this.write("right", encodeMicCommand(enabled));
  }

  onEvent(callback: (event: G1Event) => void): () => void {
    this.eventCallbacks.add(callback);
    return () => this.eventCallbacks.delete(callback);
  }

  onAudio(
    callback: (
      audioData: Uint8Array,
      sampleRate: number,
      side: GlassSide,
      encoding?: SmartglassesAudioEncoding,
      sequence?: number,
    ) => void,
  ): () => void {
    this.audioCallbacks.add(callback);
    return () => this.audioCallbacks.delete(callback);
  }

  async connectLens(side: GlassSide): Promise<void> {
    if (this.sides.has(side)) return;
    const nameMarker = side === "left" ? "_L_" : "_R_";
    const device = await this.bluetooth.requestDevice({
      filters: [
        { namePrefix: "Even" },
        { namePrefix: "G1" },
        { namePrefix: "ER" },
      ],
      optionalServices: [EVEN_G1_UART.service],
    });
    if (device.name && !device.name.includes(nameMarker)) {
      // Some platforms hide names until after selection; keep this advisory rather than failing.
      console.warn(
        `[smartglasses] selected ${device.name} for ${side}, expected name containing ${nameMarker}`,
      );
    }
    if (!device.gatt)
      throw new Error(`Selected G1 ${side} device does not expose GATT`);
    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(EVEN_G1_UART.service);
    const tx = await service.getCharacteristic(EVEN_G1_UART.tx);
    const rx = await service.getCharacteristic(EVEN_G1_UART.rx);
    const listener = (event: Event) => {
      const value = (
        event.target as unknown as BluetoothRemoteGATTCharacteristicLike | null
      )?.value;
      if (!value) return;
      const bytes = new Uint8Array(
        value.buffer.slice(
          value.byteOffset,
          value.byteOffset + value.byteLength,
        ),
      );
      this.emitParsed(parseG1Notification(side, bytes));
    };
    rx.addEventListener("characteristicvaluechanged", listener);
    await rx.startNotifications();
    this.sides.set(side, { device, server, tx, rx, listener });
  }

  private emitParsed(event: G1Event): void {
    for (const callback of this.eventCallbacks) callback(event);
    const audioData = event.audioPcm ?? event.audioData;
    if (audioData) {
      for (const callback of this.audioCallbacks)
        callback(
          audioData,
          16_000,
          event.side,
          event.audioEncoding,
          event.sequence,
        );
    }
  }
}

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(data.byteLength);
  new Uint8Array(buffer).set(data);
  return buffer;
}

export function getWebBluetoothG1Transport(): SmartglassesTransport | null {
  const nav = (
    globalThis as { navigator?: { bluetooth?: NavigatorBluetoothLike } }
  ).navigator;
  return nav?.bluetooth ? new WebBluetoothG1Transport(nav.bluetooth) : null;
}

function getNavigatorBluetooth(): NavigatorBluetoothLike {
  const nav = (
    globalThis as { navigator?: { bluetooth?: NavigatorBluetoothLike } }
  ).navigator;
  if (!nav?.bluetooth)
    throw new Error("Web Bluetooth is not available in this runtime");
  return nav.bluetooth;
}
