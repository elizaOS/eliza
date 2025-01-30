import { SmartThingsApi } from "../services/smart_things_api";

export class RoomHandlers {
  constructor(private api: SmartThingsApi) {}

  async listRooms(): Promise<any[]> {
    return await this.api.rooms.list();
  }

  async getRoom(roomId: string): Promise<any> {
    return await this.api.rooms.get(roomId);
  }

  async getRoomByName(name: string): Promise<any> {
    const rooms = await this.listRooms();
    return rooms.find(room =>
      room.name.toLowerCase() === name.toLowerCase()
    );
  }

  async getDevicesInRoom(roomId: string): Promise<any[]> {
    const devices = await this.api.devices.list();
    return devices.filter(device => device.roomId === roomId);
  }
}