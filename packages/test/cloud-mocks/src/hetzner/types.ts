// Hetzner Cloud API response shapes (subset used by the autoscaler client).

export interface MockLocation {
  id: number;
  name: string;
  city: string;
  country: string;
  description?: string;
  latitude?: number;
  longitude?: number;
  network_zone?: string;
}

export interface MockServerType {
  id: number;
  name: string;
  description: string;
  cores: number;
  memory: number;
  disk: number;
  architecture: "x86" | "arm";
  storage_type: "local" | "network";
  cpu_type?: string;
  deprecated?: boolean;
}

export interface MockImage {
  id: number;
  name: string | null;
  description: string;
  type: string;
  os_flavor: string;
  os_version: string | null;
  architecture?: "x86" | "arm";
  status?: string;
}

export interface MockServer {
  id: number;
  name: string;
  status:
    | "initializing"
    | "starting"
    | "running"
    | "stopping"
    | "off"
    | "deleting"
    | "rebuilding"
    | "migrating"
    | "unknown";
  created: string;
  public_net: {
    ipv4: { ip: string; blocked: boolean } | null;
    ipv6: { ip: string; blocked: boolean } | null;
  };
  server_type: { id: number; name: string };
  datacenter: { id: number; name: string; location: MockLocation };
  labels: Record<string, string>;
  /** Mock-only: tracks the action that will delete this server once completed. */
  _deletePendingActionId?: number | null;
}

export interface MockAction {
  id: number;
  command: string;
  status: "running" | "success" | "error";
  progress: number;
  started: string;
  finished: string | null;
  resources: Array<{ id: number; type: string }>;
  error: { code: string; message: string } | null;
}

export interface MockVolume {
  id: number;
  name: string;
  size: number;
  linux_device: string | null;
  server: number | null;
  location: MockLocation;
  format: string | null;
  status: "creating" | "available";
  labels: Record<string, string>;
  created: string;
}

export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}
