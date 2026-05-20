export { DEVICE_REGISTRY } from "./registry.ts";
export const EVEN_G1_UART_SERVICE_UUID = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
export const EVEN_G1_TX_CHAR_UUID = "6e400002-b5a3-f393-e0a9-e50e24dcca9e";
export const EVEN_G1_RX_CHAR_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";
export const EVEN_REALITIES_DEVICE_TYPES = ["g1", "g2"] as const;
export type EvenRealitiesDeviceType = (typeof EVEN_REALITIES_DEVICE_TYPES)[number];
