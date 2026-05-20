import type { EventEmitter } from "node:events";
import {
  EVEN_G1_UART,
  encodeMicCommand,
  type G1Event,
  type GlassSide,
  parseG1Notification,
  type SmartglassesAudioEncoding,
} from "../protocol.js";
import type {
  SmartglassesConnectedLenses,
  SmartglassesTransport,
} from "./types.js";

type NobleState =
  | "unknown"
  | "resetting"
  | "unsupported"
  | "unauthorized"
  | "poweredOff"
  | "poweredOn";

export type NobleCharacteristicLike = EventEmitter & {
  uuid: string;
  writeAsync?: (data: Buffer, withoutResponse?: boolean) => Promise<void>;
  write?: (
    data: Buffer,
    withoutResponse: boolean,
    callback: (error?: Error) => void,
  ) => void;
  subscribeAsync?: () => Promise<void>;
  subscribe?: (callback: (error?: Error) => void) => void;
  unsubscribeAsync?: () => Promise<void>;
};

export type NoblePeripheralLike = EventEmitter & {
  id?: string;
  address?: string;
  advertisement?: {
    localName?: string;
  };
  connectAsync?: () => Promise<void>;
  connect?: (callback: (error?: Error) => void) => void;
  disconnectAsync?: () => Promise<void>;
  disconnect?: (callback?: (error?: Error) => void) => void;
  discoverSomeServicesAndCharacteristicsAsync?: (
    serviceUuids: string[],
    characteristicUuids: string[],
  ) => Promise<{
    characteristics: NobleCharacteristicLike[];
  }>;
  discoverSomeServicesAndCharacteristics?: (
    serviceUuids: string[],
    characteristicUuids: string[],
    callback: (
      error: Error | null,
      services: unknown[],
      characteristics: NobleCharacteristicLike[],
    ) => void,
  ) => void;
};

export type NobleAdapterLike = EventEmitter & {
  state?: NobleState;
  startScanningAsync?: (
    serviceUuids: string[],
    allowDuplicates?: boolean,
  ) => Promise<void>;
  startScanning?: (
    serviceUuids: string[],
    allowDuplicates: boolean,
    callback?: (error?: Error) => void,
  ) => void;
  stopScanningAsync?: () => Promise<void>;
  stopScanning?: () => void;
};

type SideConnection = {
  peripheral: NoblePeripheralLike;
  tx: NobleCharacteristicLike;
  rx: NobleCharacteristicLike;
  dataHandler: (data: Buffer | Uint8Array) => void;
};

const SERVICE_UUID = normalizeUuid(EVEN_G1_UART.service);
const TX_UUID = normalizeUuid(EVEN_G1_UART.tx);
const RX_UUID = normalizeUuid(EVEN_G1_UART.rx);

export interface NobleG1TransportOptions {
  scanTimeoutMs?: number;
}

export class NobleG1Transport implements SmartglassesTransport {
  readonly name = "noble-g1";
  private readonly sides = new Map<GlassSide, SideConnection>();
  private readonly eventCallbacks = new Set<(event: G1Event) => void>();
  private readonly audioCallbacks = new Set<
    (
      audioData: Uint8Array,
      sampleRate: number,
      side: GlassSide,
      encoding?: SmartglassesAudioEncoding,
      sequence?: number,
    ) => void
  >();

  constructor(
    private readonly noble: NobleAdapterLike,
    private readonly options: NobleG1TransportOptions = {},
  ) {}

  async connect(): Promise<void> {
    await this.waitForPoweredOn();
    const found = await this.scanForPair();
    try {
      await Promise.all([
        this.connectPeripheral("left", found.left),
        this.connectPeripheral("right", found.right),
      ]);
    } catch (error) {
      await this.disconnect();
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    for (const [side, connection] of this.sides) {
      connection.rx.removeListener("data", connection.dataHandler);
      await callOptionalAsync(
        connection.rx.unsubscribeAsync?.bind(connection.rx),
      );
      await disconnectPeripheral(connection.peripheral);
      this.sides.delete(side);
    }
  }

  isConnected(): boolean {
    return this.sides.size === 2;
  }

  getConnectedLenses(): SmartglassesConnectedLenses {
    const lenses: SmartglassesConnectedLenses = {};
    for (const [side, connection] of this.sides) {
      lenses[side] = {
        connected: true,
        name: connection.peripheral.advertisement?.localName,
        address: connection.peripheral.address ?? connection.peripheral.id,
      };
    }
    return lenses;
  }

  async write(side: GlassSide, data: Uint8Array): Promise<void> {
    const connection = this.sides.get(side);
    if (!connection) throw new Error(`G1 ${side} lens is not connected`);
    await writeCharacteristic(connection.tx, Buffer.from(data));
  }

  async writeBoth(data: Uint8Array): Promise<void> {
    await this.write("left", data);
    await this.write("right", data);
  }

  async openMicrophone(enabled: boolean): Promise<void> {
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

  private async waitForPoweredOn(): Promise<void> {
    if (this.noble.state === "poweredOn" || this.noble.state === undefined)
      return;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.noble.removeListener("stateChange", onState);
        reject(
          new Error(
            `Timed out waiting for Bluetooth adapter; state=${this.noble.state}`,
          ),
        );
      }, this.options.scanTimeoutMs ?? 10_000);
      const onState = (state: NobleState) => {
        if (state !== "poweredOn") return;
        clearTimeout(timeout);
        this.noble.removeListener("stateChange", onState);
        resolve();
      };
      this.noble.on("stateChange", onState);
    });
  }

  private async scanForPair(): Promise<{
    left: NoblePeripheralLike;
    right: NoblePeripheralLike;
  }> {
    const found: Partial<Record<GlassSide, NoblePeripheralLike>> = {};
    const timeoutMs = this.options.scanTimeoutMs ?? 15_000;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("Timed out scanning for Even G1 left/right lenses"));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timeout);
        this.noble.removeListener("discover", onDiscover);
        void stopScanning(this.noble);
      };
      const onDiscover = (peripheral: NoblePeripheralLike) => {
        const side = inferSide(peripheral);
        if (!side) return;
        found[side] = peripheral;
        if (found.left && found.right) {
          cleanup();
          resolve();
        }
      };
      this.noble.on("discover", onDiscover);
      void startScanning(this.noble).catch((error) => {
        cleanup();
        reject(error);
      });
    });
    if (!found.left || !found.right)
      throw new Error("Missing G1 left or right lens");
    return { left: found.left, right: found.right };
  }

  private async connectPeripheral(
    side: GlassSide,
    peripheral: NoblePeripheralLike,
  ): Promise<void> {
    await connectPeripheral(peripheral);
    const characteristics = await discoverCharacteristics(peripheral);
    const tx = characteristics.find(
      (characteristic) => normalizeUuid(characteristic.uuid) === TX_UUID,
    );
    const rx = characteristics.find(
      (characteristic) => normalizeUuid(characteristic.uuid) === RX_UUID,
    );
    if (!tx || !rx)
      throw new Error(
        `G1 ${side} lens did not expose UART TX/RX characteristics`,
      );
    const dataHandler = (data: Buffer | Uint8Array) => {
      const event = parseG1Notification(side, new Uint8Array(data));
      this.emitParsed(event);
    };
    rx.on("data", dataHandler);
    await subscribeCharacteristic(rx);
    this.sides.set(side, { peripheral, tx, rx, dataHandler });
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

export async function getNobleG1Transport(
  options: NobleG1TransportOptions = {},
): Promise<SmartglassesTransport | null> {
  if (typeof process === "undefined" || typeof window !== "undefined")
    return null;
  try {
    const dynamicImport = new Function(
      "specifier",
      "return import(specifier)",
    ) as (specifier: string) => Promise<unknown>;
    const mod = (await dynamicImport("@abandonware/noble")) as {
      default?: NobleAdapterLike;
    } & NobleAdapterLike;
    const noble = mod.default ?? mod;
    return noble ? new NobleG1Transport(noble, options) : null;
  } catch {
    return null;
  }
}

function inferSide(peripheral: NoblePeripheralLike): GlassSide | null {
  const name = peripheral.advertisement?.localName ?? "";
  if (/_L_|left/i.test(name)) return "left";
  if (/_R_|right/i.test(name)) return "right";
  return null;
}

function normalizeUuid(uuid: string): string {
  return uuid.replace(/-/g, "").toLowerCase();
}

async function startScanning(noble: NobleAdapterLike): Promise<void> {
  if (noble.startScanningAsync) return noble.startScanningAsync([], false);
  await new Promise<void>((resolve, reject) => {
    noble.startScanning?.([], false, (error) =>
      error ? reject(error) : resolve(),
    );
  });
}

async function stopScanning(noble: NobleAdapterLike): Promise<void> {
  if (noble.stopScanningAsync) return noble.stopScanningAsync();
  noble.stopScanning?.();
}

async function connectPeripheral(
  peripheral: NoblePeripheralLike,
): Promise<void> {
  if (peripheral.connectAsync) return peripheral.connectAsync();
  await new Promise<void>((resolve, reject) => {
    peripheral.connect?.((error) => (error ? reject(error) : resolve()));
  });
}

async function disconnectPeripheral(
  peripheral: NoblePeripheralLike,
): Promise<void> {
  if (peripheral.disconnectAsync) return peripheral.disconnectAsync();
  await new Promise<void>((resolve, reject) => {
    peripheral.disconnect?.((error) => (error ? reject(error) : resolve()));
    resolve();
  });
}

async function discoverCharacteristics(
  peripheral: NoblePeripheralLike,
): Promise<NobleCharacteristicLike[]> {
  if (peripheral.discoverSomeServicesAndCharacteristicsAsync) {
    const result = await peripheral.discoverSomeServicesAndCharacteristicsAsync(
      [SERVICE_UUID],
      [TX_UUID, RX_UUID],
    );
    return result.characteristics;
  }
  return new Promise((resolve, reject) => {
    peripheral.discoverSomeServicesAndCharacteristics?.(
      [SERVICE_UUID],
      [TX_UUID, RX_UUID],
      (error, _services, characteristics) =>
        error ? reject(error) : resolve(characteristics),
    );
  });
}

async function writeCharacteristic(
  characteristic: NobleCharacteristicLike,
  data: Buffer,
): Promise<void> {
  if (characteristic.writeAsync) return characteristic.writeAsync(data, false);
  await new Promise<void>((resolve, reject) => {
    characteristic.write?.(data, false, (error) =>
      error ? reject(error) : resolve(),
    );
  });
}

async function subscribeCharacteristic(
  characteristic: NobleCharacteristicLike,
): Promise<void> {
  if (characteristic.subscribeAsync) return characteristic.subscribeAsync();
  await new Promise<void>((resolve, reject) => {
    characteristic.subscribe?.((error) => (error ? reject(error) : resolve()));
  });
}

async function callOptionalAsync(
  fn: (() => Promise<void>) | undefined,
): Promise<void> {
  if (fn) await fn();
}
