import { SmartThingsApi } from "../services/smart_things_api";

export class SceneHandlers {
  constructor(private api: SmartThingsApi) {}

  async listScenes(): Promise<any[]> {
    return await this.api.scenes.list();
  }

  async executeScene(sceneId: string): Promise<void> {
    await this.api.scenes.execute(sceneId);
  }

  async getSceneByName(name: string): Promise<any> {
    const scenes = await this.listScenes();
    return scenes.find(scene =>
      scene.name.toLowerCase() === name.toLowerCase()
    );
  }
}