export interface OverlayWidgetInstance {
  id: string;
  type: string;
  enabled: boolean;
  position: { x: number; y: number; width: number; height: number };
  zIndex: number;
  config: Record<string, unknown>;
}

export interface OverlayLayoutData {
  version: 1;
  name: string;
  widgets: OverlayWidgetInstance[];
}

export interface StreamingDestination {
  id: string;
  name: string;
  getCredentials(): Promise<{ rtmpUrl: string; rtmpKey: string }>;
  onStreamStart?(): Promise<void>;
  onStreamStop?(): Promise<void>;
  defaultOverlayLayout?: OverlayLayoutData;
}
