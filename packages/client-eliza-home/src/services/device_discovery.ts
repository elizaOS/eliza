import { SmartThingsApi } from './smart_things_api';
import { SmartThingsDevice } from '../types/smart_things';
import { DEVICE_CLASSES } from '../config';

export class DeviceDiscoveryService {
  constructor(private api: SmartThingsApi) {}

  async discoverDevices(): Promise<SmartThingsDevice[]> {
    const devices = await this.api.devices.list();
    return devices.map(device => this.normalizeDevice(device));
  }

  async discoverDevicesByRoom(roomId: string): Promise<SmartThingsDevice[]> {
    const devices = await this.discoverDevices();
    return devices.filter(device => device.roomId === roomId);
  }

  async discoverDevicesByType(type: string): Promise<SmartThingsDevice[]> {
    const devices = await this.discoverDevices();
    return devices.filter(device => this.getDeviceType(device) === type);
  }

  private normalizeDevice(device: any): SmartThingsDevice {
    return {
      deviceId: device.deviceId,
      name: device.label || device.name,
      roomId: device.roomId,
      capabilities: device.capabilities,
      status: device.status || {}
    };
  }

  private getDeviceType(device: SmartThingsDevice): string {
    for (const [type, deviceClass] of Object.entries(DEVICE_CLASSES)) {
      if (this.hasRequiredCapabilities(device, type)) {
        return deviceClass;
      }
    }
    return 'unknown';
  }

  private hasRequiredCapabilities(device: SmartThingsDevice, type: string): boolean {
    const requiredCaps = DEVICE_CLASSES[type];
    if (!requiredCaps) return false;

    return device.capabilities.some(cap =>
      requiredCaps.includes(cap.id)
    );
  }
}