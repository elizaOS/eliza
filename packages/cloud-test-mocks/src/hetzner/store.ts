import type { MockAction, MockLocation, MockServer, MockVolume } from "./types";

const FALKENSTEIN: MockLocation = {
  id: 1,
  name: "fsn1",
  city: "Falkenstein",
  country: "DE",
  description: "Falkenstein DC Park 1",
  network_zone: "eu-central",
};

const NUREMBERG: MockLocation = {
  id: 2,
  name: "nbg1",
  city: "Nuremberg",
  country: "DE",
  description: "Nuremberg DC Park 1",
  network_zone: "eu-central",
};

const HELSINKI: MockLocation = {
  id: 3,
  name: "hel1",
  city: "Helsinki",
  country: "FI",
  description: "Helsinki DC Park 1",
  network_zone: "eu-central",
};

export const KNOWN_LOCATIONS: Record<string, MockLocation> = {
  fsn1: FALKENSTEIN,
  nbg1: NUREMBERG,
  hel1: HELSINKI,
};

export class HetznerStore {
  private nextServerId = 1_000_000;
  private nextActionId = 1;
  private nextVolumeId = 5_000_000;

  readonly servers = new Map<number, MockServer>();
  readonly actions = new Map<number, MockAction>();
  readonly volumes = new Map<number, MockVolume>();

  allocServerId(): number {
    return this.nextServerId++;
  }

  allocActionId(): number {
    return this.nextActionId++;
  }

  allocVolumeId(): number {
    return this.nextVolumeId++;
  }

  resolveLocation(name: string): MockLocation {
    return KNOWN_LOCATIONS[name] ?? FALKENSTEIN;
  }

  randomIpv4(): string {
    const octet = () => Math.floor(Math.random() * 254) + 1;
    return `49.${octet()}.${octet()}.${octet()}`;
  }
}
