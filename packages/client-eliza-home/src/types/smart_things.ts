export interface SmartThingsDevice {
  deviceId: string;
  name: string;
  label?: string;
  roomId?: string;
  capabilities: Array<{
    id: string;
    version: number;
  }>;
  status: DeviceStatus;
}

export interface DeviceStatus {
  switch?: {
    value: 'on' | 'off';
  };
  level?: {
    value: number;
  };
  temperature?: {
    value: number;
    unit: string;
  };
  motion?: {
    value: 'active' | 'inactive';
  };
  contact?: {
    value: 'open' | 'closed';
  };
  presence?: {
    value: 'present' | 'not present';
  };
  battery?: {
    value: number;
  };
}

export interface SmartThingsRoom {
  roomId: string;
  name: string;
  locationId: string;
}

export interface SmartThingsScene {
  sceneId: string;
  sceneName: string;
  locationId: string;
  lastExecutedDate: string;
}

export interface DeviceCommand {
  capability: string;
  command: string;
  arguments?: any[];
}